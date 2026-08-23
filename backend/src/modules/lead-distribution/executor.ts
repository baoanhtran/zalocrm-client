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
/** Nhãn ghi vào cột JSON Contact.tags — xem addJsonTag() về lý do phải ghi 2 nơi. */
const CO_CARE_LABEL = '🤝 Cùng chăm';

/** Cờ "không ghép được chi nhánh". runner.ts đọc slug này để tách hàng chờ. */
export const NO_BRANCH_SLUG = 'chua-co-chi-nhanh';
const NO_BRANCH_NAME = '📍 Chưa có chi nhánh';
const NO_BRANCH_COLOR = '#B0BEC5';

export interface ExecuteResult {
  round1: number;
  round2: number;
  escalated: number;
  /** Số lead vừa bị gắn cờ chưa có chi nhánh. */
  noBranch: number;
  /** Số lead được gỡ cờ vì cuối cùng cũng chia được. */
  unflagged: number;
  errors: string[];
}

interface TagSpec {
  slug: string;
  name: string;
  color: string;
  priority: number;
  autoRule: string;
  description: string;
}

/**
 * Tag CRM báo "quá hạn chưa chốt". Cùng khuôn với cung-cham-tag-service.ts:
 * scope 'crm' + source 'segment_rule' + slug, upsert idempotent.
 */
async function ensureCrmTag(orgId: string, spec: TagSpec): Promise<string> {
  // `as const` bắt buộc: gán where ra biến làm TS nới 'crm' thành string, không còn
  // khớp enum TagScope của Prisma nữa.
  const where = { orgId, scope: 'crm' as const, source: 'segment_rule' as const, slug: spec.slug, zaloAccountId: null };
  const found = await prisma.tag.findFirst({ where });
  if (found) return found.id;

  const created = await prisma.tag
    .create({
      data: {
        orgId,
        name: spec.name,
        slug: spec.slug,
        color: spec.color,
        scope: 'crm',
        source: 'segment_rule',
        priority: spec.priority,
        autoRule: spec.autoRule,
        description: spec.description,
      },
    })
    // Race giữa 2 lần chạy song song → đọc lại bản người kia vừa tạo.
    .catch(async () => prisma.tag.findFirstOrThrow({ where }));
  return created.id;
}

const ESCALATE_TAG: TagSpec = {
  slug: ESCALATE_SLUG,
  name: ESCALATE_NAME,
  color: ESCALATE_COLOR,
  priority: 6,
  autoRule: 'LeadAssignment.round=1 quá escalateAfterDays mà contact chưa chốt',
  description: 'Tự gắn khi khách đã có 2 sale chăm mà vẫn chưa chốt sau thời hạn cấu hình.',
};

const NO_BRANCH_TAG: TagSpec = {
  slug: NO_BRANCH_SLUG,
  name: NO_BRANCH_NAME,
  color: NO_BRANCH_COLOR,
  priority: 7,
  autoRule: 'Contact.province không khớp chi nhánh nào đang có sale nhận lead',
  description:
    'Khách chưa chia được vì tỉnh chưa lập chi nhánh, chi nhánh hết sale, hoặc khách không có tỉnh. Cờ tự gỡ khi chia được.',
};

/**
 * Thêm nhãn vào cột JSON `Contact.tags` nếu chưa có.
 *
 * Vì sao phải ghi HAI nơi: hệ thống đang giữa đợt chuyển sang taxonomy mới
 * (Tag + ContactTag). Nhãn ghi vào bảng junction hiển thị trong khung chat, NHƯNG
 * màn Khách hàng đọc thẳng cột JSON cũ (`ContactsView.vue:419`) và API contacts
 * không trả junction về. Chỉ ghi junction thì nhãn vô hình đúng ở chỗ admin cần
 * nhìn — mà mục đích của việc gắn cờ là để admin lọc ra xem.
 *
 * Giới hạn đã biết: `PUT /contacts/:id/tags` ghi đè cả mảng, nên sale sửa nhãn tay
 * có thể xoá mất nhãn này. Chấp nhận — đây là tín hiệu cho admin, không phải khoá.
 */
async function addJsonTag(
  tx: { contact: { findUnique: Function; update: Function } },
  contactId: string,
  label: string,
): Promise<void> {
  const c = await tx.contact.findUnique({ where: { id: contactId }, select: { tags: true } });
  if (!c) return;
  const cur: string[] = Array.isArray(c.tags) ? (c.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  if (cur.includes(label)) return;
  // Chèn vào ĐẦU mảng, không phải cuối: cột Tags CRM chỉ hiện 2 nhãn đầu rồi gộp
  // phần còn lại thành "+N" (ContactsView.vue:419). Ghi vào cuối thì cờ bị nuốt vào
  // "+N" và admin vẫn không thấy — đúng thứ vừa hỏng. Nhãn nguồn/tỉnh bị đẩy xuống
  // cũng không mất thông tin gì vì đã có cột Nguồn và Tỉnh riêng.
  await tx.contact.update({ where: { id: contactId }, data: { tags: [label, ...cur] } });
}

/** Gỡ nhãn khỏi cột JSON `Contact.tags` nếu đang có. Cặp với addJsonTag(). */
async function removeJsonTag(contactId: string, label: string): Promise<void> {
  const c = await prisma.contact.findUnique({ where: { id: contactId }, select: { tags: true } });
  if (!c) return;
  const cur: string[] = Array.isArray(c.tags) ? (c.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  if (!cur.includes(label)) return;
  await prisma.contact.update({
    where: { id: contactId },
    data: { tags: cur.filter((t) => t !== label) },
  });
}

/**
 * Gắn cờ "chưa có chi nhánh" cho lead không ghép được địa bàn.
 *
 * Idempotent cả hai phía: junction upsert theo (contactId, tagId), nhãn JSON có
 * kiểm tra trùng. Cron chạy lại mỗi ngày trên cùng đống lead treo cũng không sinh
 * thêm gì — nếu không thì mảng tags phình ra vô hạn.
 */
async function applyNoBranch(orgId: string, contactIds: string[], errors: string[]): Promise<number> {
  if (contactIds.length === 0) return 0;
  const tagId = await ensureCrmTag(orgId, NO_BRANCH_TAG);
  let done = 0;
  for (const contactId of contactIds) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.contactTag.upsert({
          where: { contactId_tagId: { contactId, tagId } },
          create: { contactId, tagId, addedVia: 'segment_rule', addedBy: null },
          update: { removedAt: null, removedBy: null },
        });
        await addJsonTag(tx as never, contactId, NO_BRANCH_NAME);
      });
      done++;
    } catch (err) {
      errors.push(`noBranch ${contactId}: ${(err as Error).message}`);
    }
  }
  return done;
}

/**
 * Gỡ cờ cho lead vừa chia được — admin lập chi nhánh xong thì cờ phải tự biến mất,
 * không bắt họ đi dọn tay từng khách.
 *
 * Chạy sau vòng 1 và cố ý KHÔNG nằm trong transaction của nó: cờ chỉ là thứ hiển
 * thị, gỡ hụt thì thừa một nhãn, còn rollback việc gán chỉ vì gỡ nhãn hỏng thì mất
 * hẳn một lead.
 */
async function clearNoBranch(orgId: string, contactIds: string[]): Promise<number> {
  if (contactIds.length === 0) return 0;
  const tag = await prisma.tag.findFirst({
    where: { orgId, scope: 'crm', source: 'segment_rule', slug: NO_BRANCH_SLUG, zaloAccountId: null },
    select: { id: true },
  });
  if (!tag) return 0; // chưa từng gắn cờ cho org này

  const flagged = await prisma.contactTag.findMany({
    where: { tagId: tag.id, removedAt: null, contactId: { in: contactIds } },
    select: { contactId: true },
  });
  if (flagged.length === 0) return 0;

  const ids = flagged.map((f) => f.contactId);
  await prisma.contactTag.updateMany({
    where: { tagId: tag.id, contactId: { in: ids }, removedAt: null },
    data: { removedAt: new Date() },
  });
  for (const id of ids) {
    try {
      await removeJsonTag(id, NO_BRANCH_NAME);
    } catch (err) {
      logger.warn(`[lead-distribution] gỡ nhãn chi nhánh lỗi cho ${id}: ${(err as Error).message}`);
    }
  }
  return ids.length;
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
        // Nhãn JSON để hiện trên màn Khách hàng — xem addJsonTag(). Junction do
        // recomputeCungChamTag() lo, nhưng nó chỉ ghi bảng mới nên màn KH không thấy.
        await addJsonTag(tx as never, a.contactId, CO_CARE_LABEL);
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
  const tagId = await ensureCrmTag(orgId, ESCALATE_TAG);
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
        await addJsonTag(tx as never, it.contactId, ESCALATE_NAME);
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
  // Gỡ cờ NGAY sau vòng 1: lead treo hôm qua mà hôm nay chia được thì cờ phải rụng
  // trong cùng lần chạy, không để admin nhìn thấy khách đã có sale mà vẫn đeo cờ.
  const unflagged = await clearNoBranch(orgId, plan.round1.map((a) => a.contactId));
  const round2 = await applyRound2(orgId, plan.round2, errors);
  const escalated = await applyEscalations(orgId, plan.escalate, errors);
  const noBranch = await applyNoBranch(orgId, plan.noBranch, errors);
  return { round1, round2, escalated, noBranch, unflagged, errors };
}
