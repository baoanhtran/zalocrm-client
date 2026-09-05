// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * lead-distribution-routes.ts — Cấu hình + chạy tay cơ chế chia lead.
 *
 * Toàn bộ dưới resource `lead_distribution`: `access` để xem, `edit` để đổi bất cứ thứ gì.
 * Mặc định chỉ nhóm Admin có `edit`; CEO và Trưởng phòng chỉ xem; Sale không thấy màn này.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { vnDayRange } from '../../shared/utils/vn-time.js';
import { resolveProvince, resolveQuota } from './planner.js';
import { cleanProvince, provinceKey } from '../../shared/utils/province.js';
import { runForOrg, backfill } from './runner.js';

const DEFAULTS = {
  enabled: false,
  dailyQuotaPerUser: 12,
  coAssignAfterDays: 14,
  escalateAfterDays: 28,
  requirePhone: true,
};

/** Cấu hình luôn tồn tại từ góc nhìn FE — chưa có thì tạo bản mặc định (đang TẮT). */
async function getOrCreateConfig(orgId: string) {
  const found = await prisma.leadDistributionConfig.findUnique({ where: { orgId } });
  if (found) return found;
  return prisma.leadDistributionConfig.create({ data: { orgId, ...DEFAULTS } });
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.round(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function leadDistributionRoutes(app: FastifyInstance): Promise<void> {
  // Resource riêng từ 2026-08-25 (trước đây dùng chung 'settings'). 'edit' bao cả run-now
  // và backfill — hai nút đó ghi thẳng vào dữ liệu nên không thể nằm dưới quyền chỉ-xem.
  const readGuard = { preHandler: [authMiddleware, requireGrant('lead_distribution', 'access')] };
  const writeGuard = { preHandler: [authMiddleware, requireGrant('lead_distribution', 'edit')] };

  // ── GET config + danh sách sale kèm số liệu ────────────────────────────────
  app.get('/api/v1/lead-distribution/config', readGuard, async (request, reply) => {
    const user = (request as any).user;
    const orgId = user.orgId;
    const cfg = await getOrCreateConfig(orgId);

    const [users, members, branches] = await Promise.all([
      prisma.user.findMany({
        where: { orgId, isActive: true },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          // Chi nhánh = phòng ban có khai tỉnh. Trang Chia lead cần hiện ra để admin
          // thấy ngay ai chưa được xếp chi nhánh — người đó sẽ không nhận lead nào
          // dù đã tick vào vòng chia, và đó là câu hỏi đầu tiên họ sẽ đi hỏi.
          departmentMember: {
            select: { department: { select: { name: true, province: true, archivedAt: true } } },
          },
        },
        orderBy: { fullName: 'asc' },
      }),
      prisma.leadDistributionMember.findMany({
        where: { orgId },
        select: { userId: true, enabled: true, dailyQuota: true, province: true },
      }),
      // Các tỉnh THẬT SỰ có chi nhánh — nguồn duy nhất cho ô chọn địa bàn riêng.
      // Không cho gõ tự do: gán ai đó vào một tỉnh không chi nhánh nào nhận thì họ
      // ngồi không mà màn hình chẳng có dấu hiệu gì báo sai.
      prisma.department.findMany({
        where: { orgId, archivedAt: null, province: { not: null } },
        select: { province: true },
        orderBy: { province: 'asc' },
      }),
    ]);

    // Danh sách cho ô chọn: các tỉnh có chi nhánh, CỘNG các địa bàn đang được đặt
    // riêng. Vế sau để chi nhánh bị lưu trữ không làm ô chọn mất giá trị hiện tại —
    // v-select không tìm thấy value trong items sẽ hiện trống, và lần lưu kế tiếp
    // âm thầm xoá mất địa bàn của người đó.
    const provinceSet = new Map<string, string>();
    for (const d of branches) {
      if (d.province) provinceSet.set(provinceKey(d.province), d.province);
    }
    for (const m of members) {
      if (m.province && !provinceSet.has(provinceKey(m.province))) {
        provinceSet.set(provinceKey(m.province), m.province);
      }
    }
    const branchProvinces = [...provinceSet.values()].sort((a, b) => a.localeCompare(b, 'vi'));

    const { today } = vnDayRange();
    const [loadRows, todayRows] = await Promise.all([
      prisma.leadAssignment.groupBy({
        by: ['userId'],
        where: {
          orgId,
          contact: {
            NOT: { OR: [{ statusRef: { isTerminal: true } }, { status: { in: ['converted', 'lost'] } }] },
          },
        },
        _count: { _all: true },
      }),
      prisma.leadAssignment.groupBy({
        by: ['userId'],
        where: { orgId, round: 1, assignedAt: { gte: today } },
        _count: { _all: true },
      }),
    ]);

    const memberBy = new Map(members.map((m) => [m.userId, m]));
    const loadBy = new Map(loadRows.map((r) => [r.userId, r._count._all]));
    const todayBy = new Map(todayRows.map((r) => [r.userId, r._count._all]));

    return reply.send({
      config: cfg,
      branchProvinces,
      members: users.map((u) => {
        const m = memberBy.get(u.id);
        const dept = u.departmentMember?.department;
        const branch = dept && !dept.archivedAt && dept.province ? dept : null;
        const departmentProvince = branch?.province ?? null;
        return {
          userId: u.id,
          fullName: u.fullName,
          email: u.email,
          role: u.role,
          departmentName: dept?.name ?? null,
          // Ba trường tách bạch để FE hiện được "vì sao địa bàn lại là tỉnh này":
          // suy từ phòng ban, do admin đặt tay, và cái cuối cùng có hiệu lực.
          departmentProvince,
          provinceOverride: m?.province ?? null,
          province: resolveProvince(m?.province, departmentProvince),
          // Chưa có bản ghi = chưa được admin tick vào vòng chia.
          inPool: !!m?.enabled,
          dailyQuota: m?.dailyQuota ?? null,
          effectiveQuota: resolveQuota(m?.dailyQuota, cfg.dailyQuotaPerUser),
          activeLoad: loadBy.get(u.id) ?? 0,
          assignedToday: todayBy.get(u.id) ?? 0,
        };
      }),
    });
  });

  // ── PUT config ────────────────────────────────────────────────────────────
  app.put('/api/v1/lead-distribution/config', writeGuard, async (request, reply) => {
    const user = (request as any).user;
    const orgId = user.orgId;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const cur = await getOrCreateConfig(orgId);

    // Kẹp biên ngay ở API: coAssignAfterDays = 0 sẽ khiến lead vừa chia sáng nay
    // chiều đã bị nhét thêm sale, còn hạn mức 100000 thì một sale ôm sạch kho.
    const updated = await prisma.leadDistributionConfig.update({
      where: { orgId },
      data: {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : cur.enabled,
        dailyQuotaPerUser: clampInt(body.dailyQuotaPerUser, 0, 500, cur.dailyQuotaPerUser),
        coAssignAfterDays: clampInt(body.coAssignAfterDays, 1, 365, cur.coAssignAfterDays),
        escalateAfterDays: clampInt(body.escalateAfterDays, 1, 365, cur.escalateAfterDays),
        requirePhone: typeof body.requirePhone === 'boolean' ? body.requirePhone : cur.requirePhone,
      },
    });
    return reply.send({ config: updated });
  });

  // ── PUT members ───────────────────────────────────────────────────────────
  app.put('/api/v1/lead-distribution/members', writeGuard, async (request, reply) => {
    const user = (request as any).user;
    const orgId = user.orgId;
    const body = (request.body ?? {}) as {
      members?: Array<{
        userId: string;
        inPool: boolean;
        dailyQuota?: number | null;
        province?: string | null;
      }>;
    };
    if (!Array.isArray(body.members)) {
      return reply.status(400).send({ error: 'Thiếu mảng members' });
    }

    const ids = body.members.map((m) => m.userId);
    const valid = await prisma.user.findMany({
      where: { id: { in: ids }, orgId, isActive: true },
      select: { id: true },
    });
    const validIds = new Set(valid.map((u) => u.id));
    const rejected = ids.filter((id) => !validIds.has(id));
    if (rejected.length) {
      return reply.status(400).send({ error: 'User không thuộc org hoặc đã khoá', rejected });
    }

    // Địa bàn đặt riêng phải trỏ tới một chi nhánh có thật, nếu không người đó vào
    // vòng chia rồi ngồi không vĩnh viễn mà không có lỗi nào nổi lên. Đối chiếu bằng
    // provinceKey để "hà nội" admin gõ vẫn nhận ra chi nhánh "Hà Nội", rồi LƯU lại
    // đúng chính tả của chi nhánh — hai cách viết cùng một tỉnh trong DB là mầm cho
    // đúng loại lệch dữ liệu mà provinceKey sinh ra để dập.
    const [branches, existing] = await Promise.all([
      prisma.department.findMany({
        where: { orgId, archivedAt: null, province: { not: null } },
        select: { province: true },
      }),
      prisma.leadDistributionMember.findMany({
        where: { orgId },
        select: { userId: true, province: true },
      }),
    ]);
    const canonicalByKey = new Map<string, string>();
    for (const b of branches) {
      if (b.province) canonicalByKey.set(provinceKey(b.province), b.province);
    }
    const currentBy = new Map(existing.map((e) => [e.userId, e.province]));

    const resolvedProvince = new Map<string, string | null>();
    const badProvince: string[] = [];
    for (const m of body.members) {
      const raw = cleanProvince(m.province);
      if (!raw) {
        resolvedProvince.set(m.userId, null); // bỏ trống = bám theo phòng ban
        continue;
      }
      const canonical = canonicalByKey.get(provinceKey(raw));
      if (canonical) {
        resolvedProvince.set(m.userId, canonical);
        continue;
      }
      // Không khớp chi nhánh nào NHƯNG đúng bằng giá trị đang lưu của chính người này:
      // giữ nguyên. Xảy ra khi admin lưu trữ một chi nhánh — địa bàn đặt riêng cố ý
      // không dính vòng đời phòng ban, nên nó không được phép biến việc lưu trang này
      // thành bất khả thi cho tới khi có người đi dọn tay.
      const cur = currentBy.get(m.userId);
      if (cur && provinceKey(cur) === provinceKey(raw)) {
        resolvedProvince.set(m.userId, cur);
        continue;
      }
      badProvince.push(raw);
    }
    if (badProvince.length) {
      return reply.status(400).send({
        error: 'Địa bàn riêng phải là tỉnh đã có chi nhánh',
        rejected: badProvince,
      });
    }

    for (const m of body.members) {
      const quota =
        m.dailyQuota === null || m.dailyQuota === undefined
          ? null
          : clampInt(m.dailyQuota, 0, 500, 0);
      const province = resolvedProvince.get(m.userId) ?? null;
      await prisma.leadDistributionMember.upsert({
        where: { orgId_userId: { orgId, userId: m.userId } },
        update: { enabled: m.inPool, dailyQuota: quota, province },
        create: { orgId, userId: m.userId, enabled: m.inPool, dailyQuota: quota, province },
      });
    }
    return reply.send({ ok: true, updated: body.members.length });
  });

  // ── POST run-now ──────────────────────────────────────────────────────────
  app.post('/api/v1/lead-distribution/run-now', writeGuard, async (request, reply) => {
    const user = (request as any).user;
    const q = (request.query ?? {}) as { dryRun?: string };
    // Mặc định KHÔNG ghi. Muốn chạy thật phải nói rõ dryRun=false — bấm nhầm nút
    // thì chỉ xem trước, không ai mất khách.
    const dryRun = q.dryRun !== 'false';

    // force: admin xem trước / chạy tay được cả khi cơ chế đang tắt.
    const summary = await runForOrg(user.orgId, { dryRun, force: true });
    return reply.send(summary);
  });

  // ── POST backfill ─────────────────────────────────────────────────────────
  app.post('/api/v1/lead-distribution/backfill', writeGuard, async (request, reply) => {
    const user = (request as any).user;
    const q = (request.query ?? {}) as { dryRun?: string };
    const dryRun = q.dryRun !== 'false';
    const res = await backfill(user.orgId, { dryRun });
    return reply.send({ dryRun, count: res.count, provinceFilled: res.provinceFilled });
  });

  // ── GET history ───────────────────────────────────────────────────────────
  app.get('/api/v1/lead-distribution/history', readGuard, async (request, reply) => {
    const user = (request as any).user;
    const q = (request.query ?? {}) as { days?: string };
    const days = clampInt(Number(q.days), 1, 90, 7);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await prisma.leadAssignment.findMany({
      where: { orgId: user.orgId, assignedAt: { gte: since } },
      select: {
        id: true,
        round: true,
        role: true,
        assignedAt: true,
        escalatedAt: true,
        user: { select: { id: true, fullName: true } },
        contact: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: { assignedAt: 'desc' },
      take: 500,
    });
    return reply.send({ days, rows });
  });
}
