// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * excel-import-routes.ts — Nhập khách hàng loạt từ file Excel/CSV (2026-09-10).
 *
 * Quản lý chọn một tỉnh rồi tải lên file nhiều dòng khách. Frontend đọc file thành
 * mảng ô 2 chiều (đọc file ở trình duyệt: không tốn băng thông upload, không lưu file
 * lạ trên server) rồi gọi hai bước:
 *
 *   1. POST .../import/preview — không ghi gì, trả về cột đã đoán + đếm hợp lệ/trùng/lỗi
 *   2. POST .../import        — ghi thật, trả về mã lô để hoàn tác
 *
 * Khách tạo ra CỐ Ý không gán ai (anh chốt 2026-09-10): module chia lead tự động theo
 * tỉnh sẽ nhận. Hệ quả phải nhớ: tới lúc đó khách chỉ hiện với người có
 * contact.view_all — sale chưa thấy gì, và tỉnh chưa có chi nhánh thì lead treo. Ô chọn
 * tỉnh ở frontend cảnh báo trước bằng cờ `hasBranch` của endpoint provinces.
 *
 * Toàn bộ dưới resource `contact_import` (chỉ có action `access`).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../../shared/database/prisma-client.js';
import { authMiddleware } from '../../auth/auth-middleware.js';
import { requireGrant } from '../../rbac/rbac-middleware.js';
import { logger } from '../../../shared/utils/logger.js';
import { cleanProvince, provinceKey } from '../../../shared/utils/province.js';
import { SOURCE_EXCEL_IMPORT_PREFIX, SOURCE_SURVEY_PREFIX } from '../../../shared/contact-source.js';
import { logActivity } from '../../activity/activity-logger.js';
import {
  detectColumns,
  normalizeImportRow,
  dedupeRowsInFile,
  type DetectedColumns,
  type NormalizedImportRow,
  type RowErrorReason,
} from './excel-import-service.js';

/**
 * Trần số dòng một lần nhập. Anh chốt quy mô "vài trăm dòng" nên xử lý đồng bộ trong
 * một request; đặt trần gấp đôi cho thoải mái, quá thì báo chia file thay vì để request
 * chạy vài phút rồi timeout ở proxy và người dùng không biết đã ghi được bao nhiêu.
 */
const MAX_ROWS = 2000;
/** Cắt ô quá dài trước khi lưu — ô Excel có thể chứa cả đoạn văn. */
const MAX_CELL = 200;
/** Ghi DB theo lô nhỏ: một câu INSERT 300 dòng vẫn nhanh mà không giữ transaction lâu. */
const WRITE_CHUNK = 200;
/** Số phần tử tối đa trong một mệnh đề IN khi dò trùng. */
const LOOKUP_CHUNK = 500;

/** Body 1MB mặc định của Fastify không đủ cho vài trăm dòng × nhiều cột. */
const BODY_LIMIT = 8 * 1024 * 1024;

interface SheetPayload {
  headers?: unknown;
  rows?: unknown;
  rowNumbers?: unknown;
  columns?: Partial<DetectedColumns> | null;
}

interface ParsedSheet {
  headers: string[];
  rows: string[][];
  /** Số dòng thật trong file của từng dòng — dùng khi báo lỗi cho người dùng. */
  rowNumbers: number[];
}

/** Ép payload thô về đúng hình dạng, cắt độ dài, bỏ dòng trống. */
function parseSheet(body: SheetPayload): ParsedSheet | { error: string } {
  const rawRows = body.rows;
  if (!Array.isArray(rawRows)) return { error: 'rows_required' };
  if (rawRows.length > MAX_ROWS) return { error: 'too_many_rows' };

  const headers = Array.isArray(body.headers)
    ? body.headers.map((h) => String(h ?? '').slice(0, MAX_CELL).trim())
    : [];

  // Số dòng gốc do frontend gửi kèm (nó biết file có dòng trống ở đâu). Thiếu thì suy
  // theo thứ tự — báo lệch vài dòng còn hơn không báo được dòng nào.
  const rawNumbers = Array.isArray(body.rowNumbers) ? body.rowNumbers : [];

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!Array.isArray(r)) continue;
    const cells = r.map((c) => (c === null || c === undefined ? '' : String(c).slice(0, MAX_CELL).trim()));
    if (!cells.some((c) => c !== '')) continue;
    rows.push(cells);
    const n = Number(rawNumbers[i]);
    rowNumbers.push(Number.isInteger(n) && n > 0 ? n : 0);
  }
  if (rows.length === 0) return { error: 'no_data_rows' };
  return { headers, rows, rowNumbers };
}

/**
 * Cột do người dùng chỉnh tay ở bước xem trước được ưu tiên; ô nào họ để "tự động"
 * (gửi lên null) thì máy đoán. Chỉ số ngoài phạm vi coi như không có — không tin
 * payload để rồi đọc nhầm sang cột khác.
 */
function resolveColumns(sheet: ParsedSheet, override?: Partial<DetectedColumns> | null): DetectedColumns {
  const guessed = detectColumns(sheet.headers, sheet.rows);
  if (!override) return guessed;
  const width = sheet.rows.reduce((n, r) => Math.max(n, r.length), sheet.headers.length);
  const pick = (key: keyof DetectedColumns) => {
    const v = override[key];
    if (v === undefined) return guessed[key];
    if (v === null) return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n < width ? n : null;
  };
  return { fullName: pick('fullName'), birth: pick('birth'), phone: pick('phone') };
}

interface RowError {
  rowNumber: number;
  reason: RowErrorReason;
}

/** Chuẩn hoá cả bảng, giữ số dòng thật trong file để người dùng mở Excel dò lại được. */
function normalizeSheet(sheet: ParsedSheet, columns: DetectedColumns, hasHeaderRow: boolean) {
  const offset = hasHeaderRow ? 2 : 1;
  const valid: NormalizedImportRow[] = [];
  const invalid: RowError[] = [];
  sheet.rows.forEach((cells, i) => {
    const got = normalizeImportRow(cells, columns, sheet.rowNumbers[i] || i + offset);
    if (got.ok) valid.push(got.row);
    else invalid.push({ rowNumber: got.rowNumber, reason: got.reason });
  });
  return { valid, invalid };
}

/**
 * Những SĐT đã có khách trong CRM.
 *
 * Dò cả `phoneNormalized` (cột chuẩn, có index) lẫn `phone`/`phone2`/`phone3` ở dạng
 * thô: khách nhập từ đời trước có thể chưa được điền phoneNormalized, bỏ qua là tạo
 * bản trùng cho đúng người mà không ai biết.
 */
async function findExistingPhones(orgId: string, normalized: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < normalized.length; i += LOOKUP_CHUNK) {
    const chunk = normalized.slice(i, i + LOOKUP_CHUNK);
    const variants = chunk.flatMap((p) => [p, '+' + p, '0' + p.slice(2)]);
    const rows = await prisma.contact.findMany({
      where: {
        orgId,
        OR: [
          { phoneNormalized: { in: chunk } },
          { phone: { in: variants } },
          { phone2: { in: variants } },
          { phone3: { in: variants } },
        ],
      },
      select: { phoneNormalized: true, phone: true, phone2: true, phone3: true },
    });
    const want = new Set(chunk);
    for (const r of rows) {
      for (const raw of [r.phoneNormalized, r.phone, r.phone2, r.phone3]) {
        if (!raw) continue;
        const digits = String(raw).replace(/[^\d]/g, '');
        const canon = digits.startsWith('84') ? digits : digits.startsWith('0') ? '84' + digits.slice(1) : digits;
        if (want.has(canon)) found.add(canon);
      }
    }
  }
  return found;
}

export async function contactImportRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [authMiddleware, requireGrant('contact_import', 'access')] };
  // Hai route nhận cả bảng tính trong body nên phải nới trần body; các route còn lại giữ
  // trần mặc định.
  const sheetGuard = { ...guard, bodyLimit: BODY_LIMIT };

  // ── GET danh mục tỉnh cho ô chọn ───────────────────────────────────────────
  // Gợi ý lấy từ dữ liệu thật (chi nhánh + khách đang có) chứ không hardcode 34 tỉnh:
  // tên tỉnh trong CRM này do admin tự gõ khi lập chi nhánh, ép theo danh mục hành
  // chính thì lệch với thứ đang có và chia lead trượt. Vẫn cho gõ tự do ở frontend.
  app.get('/api/v1/contacts/import/provinces', guard, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).user.orgId as string;
      const [branches, contactProvinces, sources] = await Promise.all([
        prisma.department.findMany({
          where: { orgId, archivedAt: null, province: { not: null } },
          select: { province: true },
        }),
        prisma.contact.findMany({
          where: { orgId, province: { not: null } },
          select: { province: true },
          distinct: ['province'],
          take: 200,
        }),
        prisma.contact.findMany({
          where: {
            orgId,
            OR: [
              { source: { startsWith: SOURCE_SURVEY_PREFIX } },
              { source: { startsWith: SOURCE_EXCEL_IMPORT_PREFIX } },
            ],
          },
          select: { source: true },
          distinct: ['source'],
          take: 200,
        }),
      ]);

      // Gộp theo provinceKey để "hà nội" và "Hà Nội" không thành hai dòng. Cách viết
      // của CHI NHÁNH được ưu tiên giữ lại: đó là cách viết mà chia lead so khớp.
      const byKey = new Map<string, { name: string; hasBranch: boolean }>();
      for (const d of branches) {
        const name = cleanProvince(d.province);
        if (name) byKey.set(provinceKey(name), { name, hasBranch: true });
      }
      const addSoft = (raw: string | null) => {
        const name = cleanProvince(raw);
        if (!name) return;
        const key = provinceKey(name);
        if (!key || byKey.has(key)) return;
        byKey.set(key, { name, hasBranch: false });
      };
      for (const c of contactProvinces) addSoft(c.province);
      for (const s of sources) {
        const raw = s.source ?? '';
        const prefix = raw.startsWith(SOURCE_SURVEY_PREFIX) ? SOURCE_SURVEY_PREFIX : SOURCE_EXCEL_IMPORT_PREFIX;
        addSoft(raw.slice(prefix.length));
      }

      const provinces = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
      return { provinces };
    } catch (err) {
      logger.error('[contact-import] provinces error:', err);
      return reply.status(500).send({ error: 'Failed to list provinces' });
    }
  });

  // ── POST xem trước — KHÔNG ghi gì ─────────────────────────────────────────
  app.post('/api/v1/contacts/import/preview', sheetGuard, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).user.orgId as string;
      const body = (request.body ?? {}) as SheetPayload & { hasHeaderRow?: boolean };
      const sheet = parseSheet(body);
      if ('error' in sheet) return reply.status(400).send({ error: sheet.error });

      const columns = resolveColumns(sheet, body.columns);
      const { valid, invalid } = normalizeSheet(sheet, columns, body.hasHeaderRow !== false);
      const { kept, duplicateRowNumbers } = dedupeRowsInFile(valid);

      const existing = await findExistingPhones(orgId, kept.map((r) => r.phoneNormalized));
      const fresh = kept.filter((r) => !existing.has(r.phoneNormalized));

      return {
        columns,
        // 5 dòng đầu đã map để người dùng đối chiếu bằng mắt trước khi bấm Nhập.
        sample: kept.slice(0, 5),
        stats: {
          totalRows: sheet.rows.length,
          willCreate: fresh.length,
          duplicateInCrm: kept.length - fresh.length,
          duplicateInFile: duplicateRowNumbers.length,
          invalid: invalid.length,
        },
        // Cắt bớt để người dùng biết mở dòng nào trong Excel mà không nhận về vài nghìn số.
        invalidRows: invalid.slice(0, 50),
        duplicateInFileRows: duplicateRowNumbers.slice(0, 50),
      };
    } catch (err) {
      logger.error('[contact-import] preview error:', err);
      return reply.status(500).send({ error: 'Failed to preview import' });
    }
  });

  // ── POST nhập thật ────────────────────────────────────────────────────────
  app.post('/api/v1/contacts/import', sheetGuard, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = (request as any).user;
      const orgId = user.orgId as string;
      const body = (request.body ?? {}) as SheetPayload & {
        province?: string;
        fileName?: string;
        hasHeaderRow?: boolean;
      };

      const province = cleanProvince(body.province);
      if (!province) return reply.status(400).send({ error: 'province_required' });

      const sheet = parseSheet(body);
      if ('error' in sheet) return reply.status(400).send({ error: sheet.error });

      const columns = resolveColumns(sheet, body.columns);
      if (columns.phone === null) return reply.status(400).send({ error: 'phone_column_required' });

      const { valid, invalid } = normalizeSheet(sheet, columns, body.hasHeaderRow !== false);
      const { kept, duplicateRowNumbers } = dedupeRowsInFile(valid);
      const existing = await findExistingPhones(orgId, kept.map((r) => r.phoneNormalized));
      const fresh = kept.filter((r) => !existing.has(r.phoneNormalized));

      const source = SOURCE_EXCEL_IMPORT_PREFIX + province;
      const skippedDuplicate = duplicateRowNumbers.length + (kept.length - fresh.length);

      // Tạo lô TRƯỚC khi ghi khách: có mã lô rồi thì dù request đứt giữa chừng, số khách
      // đã kịp vào vẫn gắn được vào một lô để hoàn tác.
      const batch = await prisma.contactImportBatch.create({
        data: {
          orgId,
          createdById: user.id,
          fileName: String(body.fileName ?? '').slice(0, 200) || 'khong-ro-ten-file',
          province,
          source,
          totalRows: sheet.rows.length,
          skippedDuplicate,
          skippedInvalid: invalid.length,
        },
        select: { id: true },
      });

      let created = 0;
      for (let i = 0; i < fresh.length; i += WRITE_CHUNK) {
        const chunk = fresh.slice(i, i + WRITE_CHUNK);
        const res = await prisma.contact.createMany({
          data: chunk.map((r) => ({
            orgId,
            fullName: r.fullName,
            phone: r.phone,
            phoneNormalized: r.phoneNormalized,
            birthDate: r.birthDate ? new Date(`${r.birthDate}T00:00:00.000Z`) : null,
            birthYear: r.birthYear,
            province,
            source,
            status: 'new',
            // Chưa tra Zalo — để null cho luồng kết bạn/tra số sau này tự xử lý.
            hasZalo: null,
            importBatchId: batch.id,
          })),
        });
        created += res.count;
      }

      await prisma.contactImportBatch.update({
        where: { id: batch.id },
        data: { createdCount: created },
      });

      // Một dòng nhật ký cho cả lô, KHÔNG phải mỗi khách một dòng: nhập 500 khách mà
      // ghi 500 dòng thì nhật ký hoạt động của cả tổ chức chỉ còn thấy mỗi việc này.
      logActivity({
        orgId,
        userId: user.id,
        action: 'contact_import_excel',
        entityType: 'contact_import_batch',
        entityId: batch.id,
        details: { province, fileName: body.fileName ?? null, created, skippedDuplicate, skippedInvalid: invalid.length },
      });

      // CỐ Ý không bắn trigger `contact_created` cho từng khách: vài trăm sự kiện một
      // lúc là bão trigger, mà khách nhập chưa có Zalo lẫn người phụ trách nên không
      // kịch bản tự động nào chạy tới nơi. Chia lead tự động vẫn quét theo tỉnh như thường.
      return reply.status(201).send({
        batchId: batch.id,
        created,
        skippedDuplicate,
        skippedInvalid: invalid.length,
        invalidRows: invalid.slice(0, 50),
      });
    } catch (err) {
      logger.error('[contact-import] import error:', err);
      return reply.status(500).send({ error: 'Failed to import contacts' });
    }
  });

  // ── POST hoàn tác một lô ──────────────────────────────────────────────────
  app.post('/api/v1/contacts/import/:batchId/undo', guard, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const user = (request as any).user;
      const orgId = user.orgId as string;
      const { batchId } = request.params as { batchId: string };

      const batch = await prisma.contactImportBatch.findFirst({
        where: { id: batchId, orgId },
        select: { id: true, undoneAt: true, createdCount: true },
      });
      if (!batch) return reply.status(404).send({ error: 'batch_not_found' });
      if (batch.undoneAt) return reply.status(409).send({ error: 'already_undone' });

      // Chỉ xoá khách CÒN NGUYÊN TRẠNG. Khách đã được chia cho sale, đã nhắn tin, đã có
      // ghi chú hay lịch hẹn là đã có công của người khác trong đó — xoá theo là mất
      // dữ liệu thật vì một cú bấm nhầm file.
      const untouched = await prisma.contact.findMany({
        where: {
          orgId,
          importBatchId: batchId,
          conversations: { none: {} },
          contactNotes: { none: {} },
          appointments: { none: {} },
          friends: { none: {} },
          leadAssignments: { none: {} },
          contactAccess: { none: {} },
        },
        select: { id: true },
      });

      const res = await prisma.contact.deleteMany({
        where: { orgId, id: { in: untouched.map((c) => c.id) } },
      });

      await prisma.contactImportBatch.update({
        where: { id: batchId },
        data: { undoneAt: new Date(), undoneCount: res.count },
      });

      logActivity({
        orgId,
        userId: user.id,
        action: 'contact_import_undo',
        entityType: 'contact_import_batch',
        entityId: batchId,
        details: { deleted: res.count, kept: batch.createdCount - res.count },
      });

      return { deleted: res.count, kept: Math.max(0, batch.createdCount - res.count) };
    } catch (err) {
      logger.error('[contact-import] undo error:', err);
      return reply.status(500).send({ error: 'Failed to undo import' });
    }
  });

  // ── GET lịch sử các lần nhập ──────────────────────────────────────────────
  app.get('/api/v1/contacts/import/batches', guard, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orgId = (request as any).user.orgId as string;
      const batches = await prisma.contactImportBatch.findMany({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          fileName: true,
          province: true,
          totalRows: true,
          createdCount: true,
          skippedDuplicate: true,
          skippedInvalid: true,
          undoneAt: true,
          undoneCount: true,
          createdAt: true,
          createdBy: { select: { id: true, fullName: true } },
        },
      });
      return { batches };
    } catch (err) {
      logger.error('[contact-import] batches error:', err);
      return reply.status(500).send({ error: 'Failed to list import batches' });
    }
  });
}
