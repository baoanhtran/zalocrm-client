// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * lead-distribution-routes.ts — Cấu hình + chạy tay cơ chế chia lead.
 *
 * Toàn bộ dưới quyền `settings` (admin/owner). Sale thường không thấy màn này.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant } from '../rbac/rbac-middleware.js';
import { vnDayRange } from '../../shared/utils/vn-time.js';
import { resolveQuota } from './planner.js';
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
  const readGuard = { preHandler: [authMiddleware, requireGrant('settings', 'access')] };
  const writeGuard = { preHandler: [authMiddleware, requireGrant('settings', 'edit')] };

  // ── GET config + danh sách sale kèm số liệu ────────────────────────────────
  app.get('/api/v1/lead-distribution/config', readGuard, async (request, reply) => {
    const user = (request as any).user;
    const orgId = user.orgId;
    const cfg = await getOrCreateConfig(orgId);

    const [users, members] = await Promise.all([
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
        select: { userId: true, enabled: true, dailyQuota: true },
      }),
    ]);

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
      members: users.map((u) => {
        const m = memberBy.get(u.id);
        const dept = u.departmentMember?.department;
        const branch = dept && !dept.archivedAt && dept.province ? dept : null;
        return {
          userId: u.id,
          fullName: u.fullName,
          email: u.email,
          role: u.role,
          departmentName: dept?.name ?? null,
          province: branch?.province ?? null,
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
      members?: Array<{ userId: string; inPool: boolean; dailyQuota?: number | null }>;
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

    for (const m of body.members) {
      const quota =
        m.dailyQuota === null || m.dailyQuota === undefined
          ? null
          : clampInt(m.dailyQuota, 0, 500, 0);
      await prisma.leadDistributionMember.upsert({
        where: { orgId_userId: { orgId, userId: m.userId } },
        update: { enabled: m.inPool, dailyQuota: quota },
        create: { orgId, userId: m.userId, enabled: m.inPool, dailyQuota: quota },
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
