// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * tag-routes.ts — REST API cho Tag Taxonomy v2.
 *
 * Wave 3 /plan-eng-review M57 2026-05-31.
 *
 * Mount prefix: /api/v1/tags
 *
 * Routes:
 *   GET    /tags?scope=friend|crm&q=...&cursor=...      Search/autocomplete
 *   GET    /tags?recount=1                              Recount usage on-demand (Issue 4A)
 *   POST   /tags                                        Create tag (admin)
 *   PATCH  /tags/:id                                    Update color/group/priority
 *   DELETE /tags/:id                                    Archive tag
 *   POST   /tags/merge                                  Merge 2 tag (admin)
 *
 *   GET    /friends/:id/tags                            List FriendTag với Tag JOIN
 *   POST   /friends/:id/tags                            Add (autoCreate optional)
 *   DELETE /friends/:id/tags/:tagId                     Remove (soft delete)
 *
 *   GET    /contacts/:id/crm-tags                       List ContactTag với Tag JOIN
 *   POST   /contacts/:id/crm-tags                       Add (autoCreate optional)
 *   DELETE /contacts/:id/crm-tags/:tagId                Remove (soft delete)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { TagScope, TagSource } from '@prisma/client';
import { prisma, tenantTransaction } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireGrant, requireAnyGrant } from '../rbac/rbac-middleware.js';
import { userHasGrant } from '../rbac/permission-group-service.js';
import { getZaloScope } from '../zalo/zalo-scope.js';
import { logger } from '../../shared/utils/logger.js';
import {
  addFriendTag,
  removeFriendTag,
  addCrmTag,
  removeCrmTag,
  getFriendTags,
  getCrmTags,
  searchTags,
  mergeTags,
  recountUsage,
} from './tag-service.js';

// Tập source hợp lệ — guard cho filter ?source= (tránh enum lạ ném 500). 2026-06-17.
const SOURCE_VALUES = new Set<TagSource>([
  'zalo_real', 'manual_per_nick', 'auto_detect', 'auto_score', 'auto_engagement',
  'manual_crm', 'ai_suggest', 'segment_rule', 'status', 'import',
]);

/**
 * Chốt chặn cửa sau tạo nhãn.
 *
 * `autoCreate: true` nghĩa là "chưa có thì đẻ ra" — đó chính là cách sale tạo nhãn mới
 * ngay trong màn chat, đi vòng qua trang quản lý. Không chặn ở đây thì quyền tag.create
 * chỉ khoá được cửa trước, còn danh mục vẫn đầy nhãn trùng nghĩa và gõ sai chính tả.
 *
 * NHƯNG không chặn thẳng theo cờ autoCreate: findOrCreateTag() chỉ TẠO khi nhãn chưa
 * tồn tại, còn tên đã có sẵn thì nó chỉ tìm ra. Chặn theo cờ là chặn nhầm cả người đang
 * gắn một nhãn có sẵn — đúng việc mà quyết định thiết kế muốn để cho sale làm tự do.
 * Nên phải tra xem nhãn đã tồn tại chưa rồi mới quyết.
 *
 * Tra bằng (orgId, scope, slug) và CỐ Ý bỏ qua zaloAccountId, lỏng hơn điều kiện của
 * findOrCreateTag một chút: chấp nhận lọt vài trường hợp tạo biến thể theo nick, đổi lấy
 * việc không bao giờ chặn nhầm người đang làm đúng.
 *
 * @returns true nếu ĐÃ trả lời 403 — caller phải dừng ngay.
 */
async function chanTaoNhanMoi_(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: TagScope,
  body: { tagId?: string; tagSlug?: string; tagName?: string; autoCreate?: boolean },
): Promise<boolean> {
  if (!body.autoCreate || !body.tagName || body.tagId || body.tagSlug) return false;
  const user = req.user!;
  const userId = (user as any).userId ?? user.id;
  if (await userHasGrant(userId, 'tag', 'create').catch(() => false)) return false;

  const { slugifyTag } = await import('../../shared/tag-slug.js');
  const slug = slugifyTag(body.tagName);
  const daCo = slug
    ? await prisma.tag.findFirst({
        where: { orgId: user.orgId, scope, slug },
        select: { id: true },
      })
    : null;
  if (daCo) return false; // chỉ là gắn nhãn có sẵn, không phải tạo mới

  reply.code(403).send({
    error: 'Bạn không có quyền tạo nhãn mới. Nhờ quản trị thêm nhãn này vào danh mục rồi chọn lại.',
    code: 'RBAC_FORBIDDEN',
    resource: 'tag',
    action: 'create',
  });
  return true;
}

export async function registerTagRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ─────────────────────────────────────────────────────────────────────
  // Tag definitions
  // ─────────────────────────────────────────────────────────────────────

  // ĐỌC danh mục nhãn không chỉ phục vụ trang quản lý — ô chọn nhãn trong chat và màn
  // khách hàng cũng gọi đúng endpoint này. Nên ai làm việc với khách cũng phải đọc được,
  // kể cả nhóm không có tag.access. Thiếu vế contact.access là sale mất ô chọn nhãn.
  app.get<{ Querystring: { scope?: string; source?: string; q?: string; cursor?: string; limit?: string; recount?: string; zaloAccountId?: string } }>('/', { preHandler: requireAnyGrant(['tag', 'access'], ['contact', 'access']) }, async (req: FastifyRequest<{ Querystring: { scope?: string; source?: string; q?: string; cursor?: string; limit?: string; recount?: string; zaloAccountId?: string } }>, reply: FastifyReply) => {
    const user = req.user!;
    const scope = (req.query.scope ?? 'friend') as TagScope;
    if (scope !== 'friend' && scope !== 'crm') {
      return reply.code(400).send({ error: 'INVALID_SCOPE' });
    }

    if (req.query.recount === '1') {
      const result = await recountUsage(user.orgId, scope);
      return reply.send({ recount: result.updated });
    }

    // Search tags + include ZaloAccount cho FE render slug nick-prefix + filter theo nick.
    const limit = Math.min(req.query.limit ? parseInt(req.query.limit, 10) : 20, 500);
    // Filter theo source ngay ở DB (2026-06-17) — tránh bug: client kéo limit tag rồi mới
    // lọc manual_per_nick; nếu zalo_real (priority 1) ≥ limit thì manual bị đẩy khỏi response.
    const sourceFilter = req.query.source && SOURCE_VALUES.has(req.query.source as TagSource)
      ? (req.query.source as TagSource)
      : undefined;

    const tags = await prisma.tag.findMany({
      where: {
        orgId: user.orgId,
        scope,
        archivedAt: null,
        ...(sourceFilter ? { source: sourceFilter } : {}),
        ...(req.query.zaloAccountId ? { zaloAccountId: req.query.zaloAccountId } : {}),
        ...(req.query.q
          ? {
              OR: [
                { name: { contains: req.query.q, mode: 'insensitive' } },
                { slug: { contains: req.query.q } },
              ],
            }
          : {}),
      },
      orderBy: [{ priority: 'asc' }, { usageCount: 'desc' }, { name: 'asc' }],
      take: limit,
      skip: req.query.cursor ? 1 : 0,
      ...(req.query.cursor ? { cursor: { id: req.query.cursor } } : {}),
    });

    // Bulk fetch ZaloAccount cho tags có zaloAccountId. Avoid N+1.
    const zaloAccountIds = Array.from(new Set(tags.map((t) => t.zaloAccountId).filter((id): id is string => !!id)));
    const zaloAccounts = zaloAccountIds.length
      ? await prisma.zaloAccount.findMany({
          where: { id: { in: zaloAccountIds } },
          select: { id: true, displayName: true, phone: true, avatarUrl: true },
        })
      : [];
    const accMap = new Map(zaloAccounts.map((a) => [a.id, a]));

    const enriched = tags.map((t) => ({
      ...t,
      zaloAccount: t.zaloAccountId ? accMap.get(t.zaloAccountId) ?? null : null,
    }));

    return reply.send({ tags: enriched });
  });

  // GET /tags/zalo-accounts — list nick zalo cho filter dropdown (Friend tab).
  // 2026-06-10 FIX: thêm getZaloScope (chỉ nick user được phép) + ẩn nick đã xóa mềm.
  // Bug cũ: chỉ lọc orgId → sale thường thấy nick ngoài quyền + nick đã archived.
  app.get<{ Body: { name: string; scope: TagScope; source: TagSource; color?: string; emoji?: string; groupId?: string } }>('/zalo-accounts', { preHandler: requireAnyGrant(['tag', 'access'], ['contact', 'access']) }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user!;
    const scope = await getZaloScope(user.id, user.orgId, user.role);
    const accounts = await prisma.zaloAccount.findMany({
      where: {
        orgId: user.orgId,
        archivedAt: null,
        ...(scope.isOrgAdmin ? {} : { id: { in: scope.accessibleIds } }),
      },
      select: { id: true, displayName: true, phone: true, avatarUrl: true, status: true },
      orderBy: { displayName: 'asc' },
    });
    return reply.send({ accounts });
  });

  app.post<{ Body: { name: string; scope: TagScope; source: TagSource; color?: string; emoji?: string; groupId?: string } }>('/', { preHandler: requireGrant('tag', 'create') }, async (req: FastifyRequest<{ Body: { name: string; scope: TagScope; source: TagSource; color?: string; emoji?: string; groupId?: string } }>, reply: FastifyReply) => {
    const user = req.user!;
    const { name, scope, source, color, emoji, groupId } = req.body;
    if (!name || !scope || !source) return reply.code(400).send({ error: 'MISSING_FIELDS' });

    try {
      const tag = await tenantTransaction(async (tx) => {
        const { findOrCreateTag } = await import('./tag-service.js');
        return findOrCreateTag(tx, { orgId: user.orgId, scope, source, name, color, emoji });
      });
      if (groupId) {
        await prisma.tag.update({ where: { id: tag.id }, data: { groupId } });
      }
      return reply.send({ tag });
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn('[tag-routes] create failed: %s', msg);
      return reply.code(400).send({ error: msg });
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: string; emoji?: string; groupId?: string | null; priority?: number } }>('/:id', { preHandler: requireGrant('tag', 'edit') }, async (req: FastifyRequest<{ Params: { id: string }; Body: { name?: string; color?: string; emoji?: string; groupId?: string | null; priority?: number } }>, reply: FastifyReply) => {
    const user = req.user!;
    const tag = await prisma.tag.findUnique({ where: { id: req.params.id } });
    if (!tag || tag.orgId !== user.orgId) return reply.code(404).send({ error: 'TAG_NOT_FOUND' });

    const isZaloReal = tag.source === 'zalo_real' && tag.zaloAccountId && tag.sourceZaloLabelId != null;
    const wantsPushZalo = isZaloReal && (req.body.name !== undefined || req.body.color !== undefined || req.body.emoji !== undefined);

    // Validate color palette cho Zalo Real (SDK accept hex bất kỳ nhưng Zalo App
    // chỉ render đúng 8 màu palette — non-palette → fallback grey, lệch zalocrm).
    if (isZaloReal && req.body.color !== undefined) {
      const ZALO_PALETTE = ['#D91B1B', '#0068FF', '#FF6905', '#4BC377', '#FAC000', '#F31BC8', '#6F3FCF', '#FF6B6B'];
      if (!ZALO_PALETTE.includes(req.body.color.toUpperCase())) {
        return reply.code(400).send({
          error: 'ZALO_COLOR_NOT_IN_PALETTE',
          message: 'Tag Zalo Real chỉ chấp nhận 8 màu palette: ' + ZALO_PALETTE.join(', '),
        });
      }
    }

    // Push Zalo Real: text/color/emoji → SDK updateLabels({labelData, version}).
    // Priority + groupId là CRM-local (Zalo Real không có khái niệm priority/group).
    if (wantsPushZalo) {
      try {
        const { zaloPool } = await import('../zalo/zalo-pool.js');
        const api = zaloPool.getApi(tag.zaloAccountId!);
        if (!api || typeof api.updateLabels !== 'function') {
          return reply.code(503).send({ error: 'ZALO_NOT_CONNECTED', message: 'Nick Zalo chưa kết nối — không thể đổi tag' });
        }
        const current = await api.getLabels();
        const labelData = (current?.labelData || []).map((l: { id: number | string; text: string; color: string; emoji?: string }) => {
          if (Number(l.id) !== tag.sourceZaloLabelId) return l;
          return {
            ...l,
            text: req.body.name ?? l.text,
            color: req.body.color ?? l.color,
            emoji: req.body.emoji ?? l.emoji,
          };
        });
        await api.updateLabels({ labelData, version: current?.version || 0 });
        logger.info(`[tag-routes] Pushed Zalo update for Tag ${tag.id} (zaloLabelId=${tag.sourceZaloLabelId})`);
      } catch (err) {
        logger.error('[tag-routes] Push Zalo failed:', err);
        return reply.code(502).send({ error: 'ZALO_PUSH_FAILED', message: (err as Error).message });
      }
    }

    const newSlug = req.body.name ? (await import('../../shared/tag-slug.js')).slugifyTag(req.body.name) : undefined;
    const updated = await prisma.tag.update({
      where: { id: tag.id },
      data: {
        ...(req.body.name !== undefined ? { name: req.body.name, slug: newSlug ?? tag.slug } : {}),
        ...(req.body.color !== undefined ? { color: req.body.color } : {}),
        ...(req.body.emoji !== undefined ? { emoji: req.body.emoji } : {}),
        ...(req.body.groupId !== undefined ? { groupId: req.body.groupId } : {}),
        ...(req.body.priority !== undefined ? { priority: req.body.priority } : {}),
      },
    });
    return reply.send({ tag: updated, pushedZalo: wantsPushZalo });
  });

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: requireGrant('tag', 'delete') }, async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const user = req.user!;
    const tag = await prisma.tag.findUnique({ where: { id: req.params.id } });
    if (!tag || tag.orgId !== user.orgId) return reply.code(404).send({ error: 'TAG_NOT_FOUND' });
    await prisma.tag.update({ where: { id: tag.id }, data: { archivedAt: new Date() } });
    return reply.send({ ok: true });
  });

  // Gộp làm biến mất nhãn nguồn nên xếp cùng bậc với xoá, không phải sửa.
  app.post<{ Body: { sourceTagId: string; targetTagId: string } }>('/merge', { preHandler: requireGrant('tag', 'delete') }, async (req: FastifyRequest<{ Body: { sourceTagId: string; targetTagId: string } }>, reply: FastifyReply) => {
    const user = req.user!;
    try {
      const result = await mergeTags({
        orgId: user.orgId,
        sourceTagId: req.body.sourceTagId,
        targetTagId: req.body.targetTagId,
        mergedBy: user.id,
      });
      return reply.send(result);
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(400).send({ error: msg });
    }
  });
}

/**
 * Register friend-tag routes ở prefix /api/v1/friends.
 */
export async function registerFriendTagRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get('/:id/tags', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const friendTags = await getFriendTags(req.params.id);
    return reply.send({ friendTags });
  });

  app.post('/:id/tags', async (req: FastifyRequest<{ Params: { id: string }; Body: { tagId?: string; tagSlug?: string; tagName?: string; source: TagSource; autoCreate?: boolean; color?: string } }>, reply: FastifyReply) => {
    const user = req.user!;
    if (await chanTaoNhanMoi_(req, reply, 'friend', req.body)) return reply;
    try {
      const result = await addFriendTag({
        friendId: req.params.id,
        tagId: req.body.tagId,
        tagSlug: req.body.tagSlug,
        tagName: req.body.tagName,
        source: req.body.source,
        addedBy: user.id,
        autoCreate: req.body.autoCreate,
        color: req.body.color,
      });
      // CareSession 2026-06-07 (anh chốt): gắn friend tag → đóng phiên nếu tag ∈ closeConditions.
      try {
        const fr = await prisma.friend.findUnique({ where: { id: req.params.id }, select: { contactId: true, orgId: true } });
        if (fr?.contactId) {
          const { onTagAdded } = await import('../../shared/ee-registry/automation.js');
          await onTagAdded({ orgId: fr.orgId, contactId: fr.contactId, tagKind: 'friendTag', tagId: result.tag.id });
        }
      } catch { /* non-fatal */ }
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/:id/tags/:tagId', async (req: FastifyRequest<{ Params: { id: string; tagId: string } }>, reply: FastifyReply) => {
    const user = req.user!;
    await removeFriendTag({ friendId: req.params.id, tagId: req.params.tagId, removedBy: user.id });
    return reply.send({ ok: true });
  });
}

/**
 * Register CRM-tag routes ở prefix /api/v1/contacts.
 */
export async function registerContactCrmTagRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  app.get('/:id/crm-tags', async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const contactTags = await getCrmTags(req.params.id);
    return reply.send({ contactTags });
  });

  app.post('/:id/crm-tags', async (req: FastifyRequest<{ Params: { id: string }; Body: { tagId?: string; tagSlug?: string; tagName?: string; source: TagSource; autoCreate?: boolean; color?: string } }>, reply: FastifyReply) => {
    const user = req.user!;
    if (await chanTaoNhanMoi_(req, reply, 'crm', req.body)) return reply;
    try {
      const result = await addCrmTag({
        contactId: req.params.id,
        tagId: req.body.tagId,
        tagSlug: req.body.tagSlug,
        tagName: req.body.tagName,
        source: req.body.source ?? 'manual_crm',
        addedBy: user.id,
        autoCreate: req.body.autoCreate,
        color: req.body.color,
      });
      // CareSession 2026-06-07 (anh chốt): gắn CRM tag → đóng phiên nếu tag ∈ closeConditions.
      try {
        const { onTagAdded } = await import('../../shared/ee-registry/automation.js');
        await onTagAdded({ orgId: user.orgId, contactId: req.params.id, tagKind: 'crmTag', tagId: result.tag.id });
      } catch { /* non-fatal */ }
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/:id/crm-tags/:tagId', async (req: FastifyRequest<{ Params: { id: string; tagId: string } }>, reply: FastifyReply) => {
    const user = req.user!;
    await removeCrmTag({ contactId: req.params.id, tagId: req.params.tagId, removedBy: user.id });
    return reply.send({ ok: true });
  });
}
