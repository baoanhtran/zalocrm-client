// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * runner.ts — Gom dữ liệu từ DB → planner.ts → executor.ts.
 *
 * Tách khỏi cron để endpoint run-now dùng chung đúng một đường đi: cái admin xem
 * trước bằng dryRun chính là cái cron sẽ làm, không phải hai nhánh code na ná nhau.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { withTenant } from '../../shared/tenant/tenant-context.js';
import { vnDayRange } from '../../shared/utils/vn-time.js';
import { buildPlan, isContactClosed, resolveQuota, type Plan, type PlannerConfig, type PrimaryAssignment, type SaleMember } from './planner.js';
import { executePlan, NO_BRANCH_SLUG, type ExecuteResult } from './executor.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Điều kiện "đã chốt" viết bằng ngôn ngữ Prisma. Phải khớp với isContactClosed()
 * trong planner — hai chỗ, một luật. Đổi một bên mà quên bên kia thì khách đã chốt
 * vẫn lọt vào vòng chia.
 */
const CLOSED_WHERE = {
  OR: [{ statusRef: { isTerminal: true } }, { status: { in: ['converted', 'lost'] } }],
};

export interface RunSummary {
  orgId: string;
  dryRun: boolean;
  plan: Plan;
  /** null khi dryRun. */
  result: ExecuteResult | null;
  /** Vì sao không làm gì (nếu có). */
  skipped?: string;
}

/** Gom số liệu của từng sale trong vòng chia. */
async function loadMembers(orgId: string, config: PlannerConfig): Promise<SaleMember[]> {
  const members = await prisma.leadDistributionMember.findMany({
    where: { orgId, enabled: true, user: { isActive: true } },
    select: {
      userId: true,
      dailyQuota: true,
      // Chi nhánh của sale = phòng ban họ thuộc về, miễn phòng ban đó có khai tỉnh.
      user: {
        select: {
          departmentMember: {
            select: { department: { select: { province: true, archivedAt: true } } },
          },
        },
      },
    },
  });
  if (members.length === 0) return [];

  const userIds = members.map((m) => m.userId);
  const { today } = vnDayRange();

  // Hai query gộp cho TOÀN BỘ sale, không phải mỗi người một query. Với 10 sale ×
  // vài trăm lead thì kiểu lặp-trong-vòng sẽ thành vài nghìn round-trip.
  const [loadRows, todayRows] = await Promise.all([
    prisma.leadAssignment.groupBy({
      by: ['userId'],
      where: { orgId, userId: { in: userIds }, contact: { NOT: CLOSED_WHERE } },
      _count: { _all: true },
    }),
    prisma.leadAssignment.groupBy({
      by: ['userId'],
      where: { orgId, userId: { in: userIds }, round: 1, assignedAt: { gte: today } },
      _count: { _all: true },
    }),
  ]);

  const loadBy = new Map(loadRows.map((r) => [r.userId, r._count._all]));
  const todayBy = new Map(todayRows.map((r) => [r.userId, r._count._all]));

  return members.map((m) => {
    const dept = m.user.departmentMember?.department;
    return {
      userId: m.userId,
      // Phòng ban đã lưu trữ thì coi như sale không còn chi nhánh — nhận lead theo một
      // chi nhánh đã đóng thì khách rơi vào vùng không ai chịu trách nhiệm.
      province: dept && !dept.archivedAt ? dept.province : null,
      dailyQuota: resolveQuota(m.dailyQuota, config.dailyQuotaPerUser),
      activeLoad: loadBy.get(m.userId) ?? 0,
      assignedToday: todayBy.get(m.userId) ?? 0,
    };
  });
}

/**
 * Lead chưa có chủ, chưa từng vào vòng chia.
 *
 * `flagged` tách hàng chờ làm hai và đây KHÔNG phải chuyện tối ưu, mà là chống đói.
 * Lead treo (không ghép được chi nhánh) vẫn là lead cũ nhất nên trong một hàng FIFO
 * duy nhất chúng chiếm trọn cửa sổ `take` mỗi ngày, và lead mới của tỉnh ĐÃ có chi
 * nhánh sẽ không bao giờ được lấy về — hệ thống chạy, log sạch, mà không ai được
 * chia gì. Tách ra thì mỗi nhóm có cửa sổ riêng: nhóm chưa gắn cờ luôn được xét,
 * nhóm đã gắn cờ vẫn được thử lại để tự khỏi cờ khi admin lập chi nhánh.
 */
async function loadCandidateLeads(
  orgId: string,
  requirePhone: boolean,
  take: number,
  flagged: { tagId: string; has: boolean } | null,
) {
  if (take <= 0) return [];
  return prisma.contact.findMany({
    where: {
      orgId,
      assignedUserId: null,
      mergedInto: null,
      // Lead chỉ có UID mà không có SĐT thì sale mới không liên lạc được.
      ...(requirePhone ? { phoneNormalized: { not: null } } : {}),
      // Đã từng được chia rồi thì không chia lại, kể cả sau này bị gỡ chủ bằng tay.
      leadAssignments: { none: {} },
      ...(flagged
        ? {
            // Tên quan hệ là tagAssignments, KHÔNG phải contactTags — Prisma chỉ nổ khi
            // bộ lọc này thực sự được dùng, tức từ lần chạy thứ hai trở đi (lần đầu chưa
            // có tag nên nhánh này bị bỏ qua).
            tagAssignments: flagged.has
              ? { some: { tagId: flagged.tagId, removedAt: null } }
              : { none: { tagId: flagged.tagId, removedAt: null } },
          }
        : {}),
    },
    orderBy: { createdAt: 'asc' }, // FIFO — lead cũ không nằm mãi dưới đáy
    take,
    select: { id: true, createdAt: true, province: true },
  });
}

/**
 * Các dòng round 1 đã tới ngưỡng sớm nhất trong hai ngưỡng (thêm sale 2 / gắn cờ).
 * Lọc mốc thời gian ngay trong DB để không kéo cả sổ về RAM rồi mới bỏ đi.
 */
async function loadPrimaries(orgId: string, config: PlannerConfig, now: Date): Promise<PrimaryAssignment[]> {
  const earliestDays = Math.min(config.coAssignAfterDays, config.escalateAfterDays);
  const cutoff = new Date(now.getTime() - earliestDays * DAY_MS);

  const rows = await prisma.leadAssignment.findMany({
    where: { orgId, round: 1, assignedAt: { lte: cutoff } },
    select: {
      id: true,
      contactId: true,
      userId: true,
      assignedAt: true,
      escalatedAt: true,
      contact: { select: { status: true, province: true, statusRef: { select: { isTerminal: true } } } },
    },
  });
  if (rows.length === 0) return [];

  const contactIds = rows.map((r) => r.contactId);
  const [round2Rows, accessRows] = await Promise.all([
    prisma.leadAssignment.findMany({
      where: { orgId, round: 2, contactId: { in: contactIds } },
      select: { contactId: true },
    }),
    prisma.contactAccess.findMany({
      where: { orgId, contactId: { in: contactIds } },
      select: { contactId: true, userId: true },
    }),
  ]);

  const hasRound2 = new Set(round2Rows.map((r) => r.contactId));
  const accessBy = new Map<string, string[]>();
  for (const a of accessRows) {
    const list = accessBy.get(a.contactId);
    if (list) list.push(a.userId);
    else accessBy.set(a.contactId, [a.userId]);
  }

  return rows.map((r) => ({
    assignmentId: r.id,
    contactId: r.contactId,
    userId: r.userId,
    assignedAt: r.assignedAt,
    escalatedAt: r.escalatedAt,
    closed: isContactClosed({
      statusIsTerminal: r.contact.statusRef?.isTerminal ?? null,
      legacyStatus: r.contact.status,
    }),
    hasRound2: hasRound2.has(r.contactId),
    accessUserIds: accessBy.get(r.contactId) ?? [],
    province: r.contact.province,
  }));
}

/**
 * Chạy một lượt cho một org.
 *
 * @param force bỏ qua cờ `enabled` — chỉ dùng cho run-now của admin, cron KHÔNG
 *              được truyền. Có nó thì admin thử được trước khi bật thật.
 */
export async function runForOrg(
  orgId: string,
  opts: { dryRun?: boolean; force?: boolean; now?: Date } = {},
): Promise<RunSummary> {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const empty: Plan = { round1: [], round2: [], escalate: [], noBranch: [], membersWithoutBranch: [] };

  return withTenant(orgId, async () => {
    const cfg = await prisma.leadDistributionConfig.findUnique({ where: { orgId } });
    if (!cfg) return { orgId, dryRun, plan: empty, result: null, skipped: 'chưa cấu hình' };
    if (!cfg.enabled && !opts.force) {
      return { orgId, dryRun, plan: empty, result: null, skipped: 'đang tắt' };
    }

    const config: PlannerConfig = {
      dailyQuotaPerUser: cfg.dailyQuotaPerUser,
      coAssignAfterDays: cfg.coAssignAfterDays,
      escalateAfterDays: cfg.escalateAfterDays,
    };

    const members = await loadMembers(orgId, config);
    if (members.length === 0) {
      // Không có sale nào thì vòng 1 và vòng 2 đều vô nghĩa, nhưng việc gắn cờ quá
      // hạn vẫn phải chạy — đó lại đúng là lúc admin cần biết nhất.
      const primaries = await loadPrimaries(orgId, config, now);
      const plan = buildPlan({ leads: [], primaries, members: [], config, now });
      const result = dryRun ? null : await executePlan(orgId, plan);
      return { orgId, dryRun, plan, result, skipped: 'không có sale nào đang bật' };
    }

    const budget = members.reduce((sum, m) => sum + Math.max(0, m.dailyQuota - m.assignedToday), 0);

    // Tag cờ có thể chưa tồn tại (org chưa từng có lead treo) — khi đó không có gì
    // để tách, mọi lead đều là "chưa gắn cờ".
    const noBranchTag = await prisma.tag.findFirst({
      where: { orgId, scope: 'crm', source: 'segment_rule', slug: NO_BRANCH_SLUG, zaloAccountId: null },
      select: { id: true },
    });

    const [freshLeads, flaggedLeads, primaries] = await Promise.all([
      loadCandidateLeads(orgId, cfg.requirePhone, budget, noBranchTag ? { tagId: noBranchTag.id, has: false } : null),
      noBranchTag
        ? loadCandidateLeads(orgId, cfg.requirePhone, budget, { tagId: noBranchTag.id, has: true })
        : Promise.resolve([]),
      loadPrimaries(orgId, config, now),
    ]);

    // Gộp rồi để planner tự sắp FIFO. Lead treo cũ hơn nên được ưu tiên — đúng, vì
    // giờ chúng đã có chi nhánh nhận thì phải là những người chờ lâu nhất đi trước.
    const leadRows = [...freshLeads, ...flaggedLeads];

    const plan = buildPlan({
      leads: leadRows.map((c) => ({ contactId: c.id, createdAt: c.createdAt, province: c.province })),
      primaries,
      members,
      config,
      now,
    });

    const result = dryRun ? null : await executePlan(orgId, plan);
    return { orgId, dryRun, plan, result };
  });
}

/** Chạy cho mọi org đang bật. Dùng bởi cron. */
export async function runAllOrgs(now = new Date()): Promise<RunSummary[]> {
  // findMany ngoài tenant context: LeadDistributionConfig là org-scoped nên phải
  // đọc qua runSystemQuery... nhưng ở đây ta chỉ cần danh sách orgId, và cách rẻ
  // nhất là hỏi bảng Organization (không org-scoped) rồi lọc trong withTenant.
  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const out: RunSummary[] = [];
  for (const org of orgs) {
    try {
      out.push(await runForOrg(org.id, { now }));
    } catch (err) {
      logger.error(`[lead-distribution] org ${org.id} lỗi: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Nạp tồn: sinh dòng round 1 cho contact đã có chủ nhưng chưa từng vào vòng chia.
 *
 * `assignedAt = bây giờ`, KHÔNG hồi tố theo ngày tạo contact. Hồi tố thì 1844 khách
 * cũ sẽ cùng quá hạn ngay lập tức và sáng hôm sau đồng loạt bị gắn thêm sale 2 —
 * đúng thứ đã cảnh báo trong spec §7.
 */
export async function backfill(
  orgId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ count: number; provinceFilled: number }> {
  return withTenant(orgId, async () => {
    const provinceFilled = await fillProvinceFromSource(orgId, opts.dryRun ?? false);
    const rows = await prisma.contact.findMany({
      where: { orgId, assignedUserId: { not: null }, mergedInto: null, leadAssignments: { none: {} } },
      select: { id: true, assignedUserId: true },
    });
    if (opts.dryRun) return { count: rows.length, provinceFilled };

    const now = new Date();
    const data = rows
      .filter((r): r is { id: string; assignedUserId: string } => !!r.assignedUserId)
      .map((r) => ({
        orgId,
        contactId: r.id,
        userId: r.assignedUserId,
        role: 'primary',
        round: 1,
        assignedAt: now,
      }));
    // skipDuplicates: chạy lại lần nữa không nổ vì @@unique([contactId, userId]).
    const res = await prisma.leadAssignment.createMany({ data, skipDuplicates: true });
    return { count: res.count, provinceFilled };
  });
}

/**
 * Điền `Contact.province` cho khách nhập trước khi Apps Script biết gửi tỉnh.
 *
 * Tỉnh vẫn còn nguyên trong `source` dạng "khao-sat:Hà Nội" — cắt ra là xong. Không
 * làm bước này thì toàn bộ khách cũ trở thành lead treo ngay ngày đầu bật chi nhánh,
 * và admin sẽ tưởng tính năng hỏng.
 *
 * Chỉ đụng dòng `province IS NULL`: khách đã có tỉnh (nhập tay, sửa tay) không bị ghi đè.
 */
async function fillProvinceFromSource(orgId: string, dryRun: boolean): Promise<number> {
  const rows = await prisma.contact.findMany({
    where: { orgId, province: null, source: { startsWith: 'khao-sat:' } },
    select: { id: true, source: true },
  });
  if (rows.length === 0) return 0;
  if (dryRun) return rows.length;

  let done = 0;
  for (const r of rows) {
    const tinh = (r.source ?? '').slice('khao-sat:'.length).trim();
    if (!tinh) continue;
    await prisma.contact.update({ where: { id: r.id }, data: { province: tinh } });
    done++;
  }
  logger.info(`[lead-distribution] điền tỉnh cho ${done} khách cũ từ source`);
  return done;
}
