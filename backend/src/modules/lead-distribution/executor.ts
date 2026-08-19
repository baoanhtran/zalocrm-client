// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * executor.ts — Ghi DB theo kế hoạch của planner.ts. Cố ý KHÔNG chứa nhánh quyết
 * định nào: mọi luật nằm ở planner (hàm thuần, có test). Ở đây chỉ là I/O.
 *
 * Người gọi phải bọc sẵn withTenant(orgId, ...) — 3 model này đều org-scoped nên
 * tenant-guard sẽ ném lỗi nếu chạy ngoài context.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { logActivity } from '../activity/activity-logger.js';
import type { Plan, PlannedAssignment } from './planner.js';

const ESCALATE_SLUG = 'cham-qua-han';
const ESCALATE_NAME = '⏳ Chăm quá hạn';
const ESCALATE_COLOR = '#F5A623';

export interface ExecuteResult {
  round1: number;
  round2: number;
  escalated: number;
  errors: string[];
}

/**
 * Tag CRM báo "quá hạn chưa chốt". Cùng khuôn với cung-cham-tag-service.ts:
 * scope 'crm' + source 'segment_rule' + slug, upsert idempotent.
 */
async function ensureEscalateTag(orgId: string): Promise<string> {
  const found = await prisma.tag.findFirst({
    where: { orgId, scope: 'crm', source: 'segment_rule', slug: ESCALATE_SLUG, zaloAccountId: null },
  });
  if (found) return found.id;

  const created = await prisma.tag
    .create({
      data: {
        orgId,
        name: ESCALATE_NAME,
        slug: ESCALATE_SLUG,
        color: ESCALATE_COLOR,
        scope: 'crm',
        source: 'segment_rule',
        priority: 6,
        autoRule: 'LeadAssignment.round=1 quá escalateAfterDays mà contact chưa chốt',
        description: 'Tự gắn khi khách đã có 2 sale chăm mà vẫn chưa chốt sau thời hạn cấu hình.',
      },
    })
    // Race giữa 2 lần chạy song song → đọc lại bản người kia vừa tạo.
    .catch(async () =>
      prisma.tag.findFirstOrThrow({
        where: { orgId, scope: 'crm', source: 'segment_rule', slug: ESCALATE_SLUG, zaloAccountId: null },
      }),
    );
  return created.id;
}

/**
 * VÒNG 1 — gán chủ chính. Ba việc trong một transaction: nếu ContactAccess ghi
 * được mà LeadAssignment hỏng thì sale thấy khách nhưng đồng hồ 2 tuần không bao
 * giờ chạy; ngược lại thì sổ có mà sale không thấy khách. Cả hai đều là sai lệch
 * âm thầm, nên phải cùng sống cùng chết.
 */
async function applyRound1(orgId: string, items: PlannedAssignment[], errors: string[]): Promise<number> {
  let done = 0;
  for (const a of items) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.contact.update({
          where: { id: a.contactId },
          data: { assignedUserId: a.userId },
        });
        await tx.contactAccess.upsert({
          where: { contactId_userId: { contactId: a.contactId, userId: a.userId } },
          update: { role: 'primary' },
          create: {
            orgId,
            contactId: a.contactId,
            userId: a.userId,
            role: 'primary',
            source: 'lead_distribution',
          },
        });
        await tx.leadAssignment.create({
          data: { orgId, contactId: a.contactId, userId: a.userId, role: 'primary', round: 1 },
        });
      });
      done++;
    } catch (err) {
      // Một lead hỏng không được kéo đổ cả lần chạy — các lead còn lại vẫn phải chia.
      errors.push(`round1 ${a.contactId}→${a.userId}: ${(err as Error).message}`);
    }
  }
  return done;
}

/**
 * VÒNG 2 — thêm sale chăm cùng.
 *
 * Cố ý KHÔNG dùng attachContactCollaboratorByUser(): hàm đó nuốt lỗi (best-effort,
 * hợp lý cho luồng chat) nên nếu ContactAccess ghi hỏng ta vẫn tạo LeadAssignment
 * và sổ sách báo "đã thêm sale" trong khi sale không hề thấy khách. Ở đây upsert
 * thẳng để lỗi nổi lên, rồi gọi recomputeCungChamTag() để vẫn có tag "🤝 Cùng chăm".
 *
 * `update: {}` để KHÔNG hạ cấp người đang là primary xuống collaborator.
 */
async function applyRound2(orgId: string, items: PlannedAssignment[], errors: string[]): Promise<number> {
  let done = 0;
  for (const a of items) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.contactAccess.upsert({
          where: { contactId_userId: { contactId: a.contactId, userId: a.userId } },
          update: {},
          create: {
            orgId,
            contactId: a.contactId,
            userId: a.userId,
            role: 'collaborator',
            source: 'lead_distribution_round2',
          },
        });
        await tx.leadAssignment.create({
          data: { orgId, contactId: a.contactId, userId: a.userId, role: 'collaborator', round: 2 },
        });
      });
      done++;

      // Ngoài transaction: tag là thứ trang trí, hỏng cũng không được rollback việc gán.
      try {
        const { recomputeCungChamTag } = await import('../tags/cung-cham-tag-service.js');
        await recomputeCungChamTag(a.contactId);
      } catch (err) {
        logger.warn(`[lead-distribution] tag Cùng chăm lỗi cho ${a.contactId}: ${(err as Error).message}`);
      }

      logActivity({
        orgId,
        systemSource: 'lead_distribution',
        action: 'lead_co_assigned',
        entityType: 'contact',
        entityId: a.contactId,
        details: { userId: a.userId, round: 2 },
      });
    } catch (err) {
      errors.push(`round2 ${a.contactId}→${a.userId}: ${(err as Error).message}`);
    }
  }
  return done;
}

/**
 * VIỆC 3 — gắn cờ quá hạn. `escalatedAt` là thứ chặn báo lặp, nên phải ghi CÙNG
 * transaction với tag: ghi tag mà không ghi escalatedAt thì mai lại báo tiếp.
 */
async function applyEscalations(
  orgId: string,
  items: Plan['escalate'],
  errors: string[],
): Promise<number> {
  if (items.length === 0) return 0;
  const tagId = await ensureEscalateTag(orgId);
  const now = new Date();
  let done = 0;

  for (const it of items) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.contactTag.upsert({
          where: { contactId_tagId: { contactId: it.contactId, tagId } },
          create: { contactId: it.contactId, tagId, addedVia: 'segment_rule', addedBy: null },
          update: { removedAt: null, removedBy: null },
        });
        await tx.leadAssignment.update({
          where: { id: it.assignmentId },
          data: { escalatedAt: now },
        });
      });
      done++;
      logActivity({
        orgId,
        systemSource: 'lead_distribution',
        action: 'lead_escalated',
        entityType: 'contact',
        entityId: it.contactId,
        details: { assignmentId: it.assignmentId },
      });
    } catch (err) {
      errors.push(`escalate ${it.contactId}: ${(err as Error).message}`);
    }
  }
  return done;
}

/** Thi hành trọn kế hoạch. Người gọi phải đã ở trong withTenant(orgId, ...). */
export async function executePlan(orgId: string, plan: Plan): Promise<ExecuteResult> {
  const errors: string[] = [];
  const round1 = await applyRound1(orgId, plan.round1, errors);
  const round2 = await applyRound2(orgId, plan.round2, errors);
  const escalated = await applyEscalations(orgId, plan.escalate, errors);
  return { round1, round2, escalated, errors };
}
