// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * excel-import-service.ts — Nhập khách từ Excel: phần đọc hiểu bảng tính.
 *
 * Toàn bộ file này là hàm thuần (không đụng DB, không đụng request) vì đây là chỗ
 * tính năng dễ hỏng ÂM THẦM nhất: đoán nhầm cột thì vài trăm khách vào CRM với tên là
 * số điện thoại và không có lỗi nào nổi lên. Tách ra được thì test bằng vitest thường,
 * không cần Postgres — xem tests/unit/excel-import-service.test.ts.
 *
 * Luồng: frontend đọc file (.xlsx/.csv) thành mảng ô 2 chiều rồi gửi lên; backend
 * đoán cột (detectColumns) → chuẩn hoá từng dòng (normalizeImportRow) → bỏ trùng
 * trong chính file (dedupeRowsInFile) → route lo phần dò trùng với CRM và ghi DB.
 */

import { normalizeVnMobile } from '../../../shared/utils/phone.js';

// ── Kiểu dữ liệu ────────────────────────────────────────────────────────────

/** Chỉ số cột (0-based) trong bảng tính. null = không có / không đoán ra. */
export interface DetectedColumns {
  fullName: number | null;
  birth: number | null;
  phone: number | null;
}

export interface NormalizedImportRow {
  /** Số dòng trong file để người dùng mở Excel dò lại — tính cả dòng tiêu đề. */
  rowNumber: number;
  fullName: string | null;
  /** SĐT giữ nguyên dạng người dùng gõ, để hiển thị. */
  phone: string;
  /** Dạng chuẩn 84xxx — khoá dò trùng. */
  phoneNormalized: string;
  /** "YYYY-MM-DD" hoặc null. Chuỗi chứ không phải Date: đi qua JSON không lệch múi giờ. */
  birthDate: string | null;
  birthYear: number | null;
}

export type RowErrorReason = 'missing_phone' | 'invalid_phone';

export type NormalizeResult =
  | { ok: true; row: NormalizedImportRow }
  | { ok: false; rowNumber: number; reason: RowErrorReason };

// ── Chuẩn hoá chuỗi ─────────────────────────────────────────────────────────

/** Bỏ dấu + thường hoá + rút gọn khoảng trắng. Chỉ dùng để SO KHỚP, không để lưu. */
function foldText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cellText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return String(raw).replace(/\s+/g, ' ').trim();
}

// ── Đoán cột theo tiêu đề ───────────────────────────────────────────────────
//
// Đủ dùng cho phần lớn file thật; file không tiêu đề hoặc tiêu đề lạ thì tầng đoán
// theo NỘI DUNG bên dưới lo nốt.

const HEADER_PHONE = /\b(sdt|dt|dtdd|tel|phone|mobile|hotline)\b|dien thoai|so may/;
// Bắt buộc có chữ "sinh" (hoặc birth/dob/ns) — nhờ vậy "Ngày tạo", "Ngày nhập" không
// bị nhận nhầm thành ngày sinh.
const HEADER_BIRTH = /\bsinh\b|\bns\b|\bdob\b|birth/;
const HEADER_NAME = /\bho ten\b|ho va ten|\bten\b|\bname\b|khach hang|\bkhach\b/;

// ── Đoán cột theo nội dung ──────────────────────────────────────────────────

/** Tỉ lệ ô "đọc được" tối thiểu để dám nhận một cột. Dưới ngưỡng thì thà bỏ trống. */
const CONTENT_THRESHOLD = 0.6;

/**
 * Năm sinh xa nhất còn được coi là "ngày sinh" khi đoán theo nội dung.
 *
 * Cột "Ngày tạo" của file xuất từ phần mềm khác toàn ngày gần đây và ngày nào cũng
 * hợp lệ, nên chỉ hỏi "có phải ngày không" là dính bẫy. Người trong danh sách khách
 * hàng thì không ai mới sinh vài tháng — chặn ở 5 năm là đủ tách hai thứ.
 */
function contentBirthCutoff(): number {
  return new Date().getFullYear() - 5;
}

function columnCount(headers: string[], rows: unknown[][]): number {
  let n = headers.length;
  for (const r of rows) n = Math.max(n, r.length);
  return n;
}

function columnCells(rows: unknown[][], col: number): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const v = cellText(r[col]);
    if (v) out.push(v);
  }
  return out;
}

function ratio(cells: string[], pred: (c: string) => boolean): number {
  if (cells.length === 0) return 0;
  let hit = 0;
  for (const c of cells) if (pred(c)) hit++;
  return hit / cells.length;
}

/**
 * Đoán 3 cột họ tên / ngày sinh / SĐT.
 *
 * Hai tầng, tầng sau bù cho tầng trước: tiêu đề trước (rẻ, chính xác khi file có
 * tiêu đề tử tế), rồi nội dung cho những cột còn bỏ trống. Cột đã nhận rồi thì tầng
 * sau không đụng vào nữa — mỗi cột chỉ giữ một vai.
 *
 * `rows` là các dòng DỮ LIỆU (không gồm dòng tiêu đề); truyền vài chục dòng đầu là đủ.
 */
export function detectColumns(headers: string[], rows: unknown[][]): DetectedColumns {
  const result: DetectedColumns = { fullName: null, birth: null, phone: null };
  const taken = new Set<number>();
  const total = columnCount(headers, rows);

  // Tầng 1 — tiêu đề. Xét SĐT trước rồi ngày sinh rồi họ tên: cột SĐT là cột chắc
  // chắn nhất, nhường nó chọn trước thì hai cột kia ít cơ hội nhận nhầm.
  const folded = Array.from({ length: total }, (_, i) => foldText(headers[i]));
  for (const [key, re] of [
    ['phone', HEADER_PHONE],
    ['birth', HEADER_BIRTH],
    ['fullName', HEADER_NAME],
  ] as Array<[keyof DetectedColumns, RegExp]>) {
    for (let i = 0; i < total; i++) {
      if (taken.has(i) || !folded[i]) continue;
      if (re.test(folded[i])) {
        result[key] = i;
        taken.add(i);
        break;
      }
    }
  }

  // Tầng 2 — nội dung. Chấm điểm từng cột còn trống rồi lấy cột cao điểm nhất.
  const cutoff = contentBirthCutoff();
  const score = (pred: (c: string) => boolean) => {
    let best: { col: number; value: number } | null = null;
    for (let i = 0; i < total; i++) {
      if (taken.has(i)) continue;
      const v = ratio(columnCells(rows, i), pred);
      if (v >= CONTENT_THRESHOLD && (!best || v > best.value)) best = { col: i, value: v };
    }
    return best?.col ?? null;
  };

  if (result.phone === null) {
    const col = score((c) => normalizeVnMobile(c) !== null);
    if (col !== null) {
      result.phone = col;
      taken.add(col);
    }
  }
  if (result.birth === null) {
    const col = score((c) => {
      const b = parseBirth(c);
      return b.birthYear !== null && b.birthYear <= cutoff;
    });
    if (col !== null) {
      result.birth = col;
      taken.add(col);
    }
  }
  if (result.fullName === null) {
    // Cột chữ (không lẫn chữ số) nào có tên dài nhất thì là họ tên: file khách hàng
    // hay có thêm cột tỉnh/giới tính cũng toàn chữ, phân biệt bằng số từ trung bình.
    let best: { col: number; words: number } | null = null;
    for (let i = 0; i < total; i++) {
      if (taken.has(i)) continue;
      const cells = columnCells(rows, i);
      if (ratio(cells, isTextyName) < CONTENT_THRESHOLD) continue;
      const words = cells.reduce((sum, c) => sum + c.split(' ').length, 0) / (cells.length || 1);
      if (!best || words > best.words) best = { col: i, words };
    }
    if (best) {
      result.fullName = best.col;
      taken.add(best.col);
    }
  }

  return result;
}

function isTextyName(cell: string): boolean {
  if (cell.length < 2) return false;
  if (/\d/.test(cell)) return false;
  return /\p{L}/u.test(cell);
}

// ── Ngày sinh ───────────────────────────────────────────────────────────────

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30); // serial 1 = 1900-01-01
const MIN_BIRTH_YEAR = 1900;

/**
 * Đọc ô ngày sinh ở mọi dạng người dùng hay gửi:
 *   ô Date thật của Excel, số serial (32905), "01/02/1990", "1-2-1990", "1990-02-01",
 *   hoặc chỉ mỗi năm "1990".
 *
 * Ngày vô lý (32/13, năm 1850, năm ở tương lai) trả rỗng thay vì đoán bừa — thà để
 * trống ngày sinh còn hơn nhét năm sai vào CRM rồi chúc mừng sinh nhật nhầm.
 *
 * Trả `birthDate` dạng "YYYY-MM-DD" (chuỗi, không phải Date) để đi qua JSON không bị
 * lệch một ngày vì múi giờ.
 */
export function parseBirth(cell: unknown): { birthDate: string | null; birthYear: number | null } {
  const empty = { birthDate: null, birthYear: null };
  if (cell === null || cell === undefined) return empty;

  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return empty;
    return fromParts(cell.getUTCFullYear(), cell.getUTCMonth() + 1, cell.getUTCDate());
  }

  const raw = String(cell).trim();
  if (!raw) return empty;

  // Số trần: 4 chữ số trong khoảng năm hợp lệ là NĂM SINH, còn lại mới là serial của
  // Excel. Không phân biệt thì "1990" thành ngày 12/06/1905.
  if (/^\d+([.]0+)?$/.test(raw)) {
    const n = Math.trunc(Number(raw));
    if (n >= MIN_BIRTH_YEAR && n <= new Date().getFullYear()) {
      return { birthDate: null, birthYear: n };
    }
    if (n >= 1 && n <= 60000) {
      const d = new Date(EXCEL_EPOCH_UTC + n * 86400000);
      return fromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return empty;
  }

  // dd/mm/yyyy, d-m-yyyy, d.m.yyyy
  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) return fromParts(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  // yyyy-mm-dd (kể cả chuỗi ISO có giờ phía sau)
  const ymd = raw.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (ymd) return fromParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));

  return empty;
}

function fromParts(year: number, month: number, day: number): { birthDate: string | null; birthYear: number | null } {
  const empty = { birthDate: null, birthYear: null };
  if (!Number.isFinite(year) || year < MIN_BIRTH_YEAR || year > new Date().getFullYear()) return empty;
  if (month < 1 || month > 12 || day < 1 || day > 31) return empty;
  // Ngày 31/02 kiểu này Date sẽ tự trôi sang tháng sau — bắt lại bằng cách so ngược.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return empty;
  if (d.getTime() > Date.now()) return empty;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { birthDate: `${year}-${pad(month)}-${pad(day)}`, birthYear: year };
}

// ── Chuẩn hoá một dòng ──────────────────────────────────────────────────────

/** Ký tự che (▒) của tính năng làm mờ — không được để lọt vào tên khách. */
const BLUR_CHAR = /▒/;

/**
 * Chuẩn hoá một dòng dữ liệu thành khách sắp tạo, hoặc trả lỗi kèm SỐ DÒNG.
 *
 * SĐT là thứ định danh khách trong CRM này (dò trùng, kết bạn Zalo, chia lead đều
 * dựa vào nó) nên thiếu hoặc sai là bỏ dòng. Thiếu TÊN thì vẫn nhận: tên bổ sung sau
 * được, còn số thì không.
 *
 * Dùng normalizeVnMobile (chặt) chứ không normalizePhone (lỏng): danh sách nhập hàng
 * loạt để sale kết bạn Zalo — số bàn hay số 11 chữ số đời cũ vào đây chỉ làm rác.
 */
export function normalizeImportRow(
  cells: unknown[],
  columns: DetectedColumns,
  rowNumber: number,
): NormalizeResult {
  const rawPhone = columns.phone === null ? '' : cellText(cells[columns.phone]);
  if (!rawPhone) return { ok: false, rowNumber, reason: 'missing_phone' };

  const phoneNormalized = normalizeVnMobile(rawPhone);
  if (!phoneNormalized) return { ok: false, rowNumber, reason: 'invalid_phone' };

  let fullName: string | null = columns.fullName === null ? null : cellText(cells[columns.fullName]);
  if (!fullName || BLUR_CHAR.test(fullName)) fullName = null;

  const birth = columns.birth === null ? { birthDate: null, birthYear: null } : parseBirth(cells[columns.birth]);

  return {
    ok: true,
    row: { rowNumber, fullName, phone: rawPhone, phoneNormalized, birthDate: birth.birthDate, birthYear: birth.birthYear },
  };
}

/**
 * Bỏ dòng trùng SĐT trong chính file, giữ dòng ĐẦU.
 *
 * Giữ dòng đầu chứ không phải dòng cuối vì danh sách thường được nối thêm về sau: bản
 * ghi đầu là bản người vận hành nhập cẩn thận, các dòng sau hay là chép vội.
 */
export function dedupeRowsInFile(rows: NormalizedImportRow[]): {
  kept: NormalizedImportRow[];
  duplicateRowNumbers: number[];
} {
  const seen = new Set<string>();
  const kept: NormalizedImportRow[] = [];
  const duplicateRowNumbers: number[] = [];
  for (const r of rows) {
    if (seen.has(r.phoneNormalized)) {
      duplicateRowNumbers.push(r.rowNumber);
      continue;
    }
    seen.add(r.phoneNormalized);
    kept.push(r);
  }
  return { kept, duplicateRowNumbers };
}
