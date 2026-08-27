// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * message-template-routes.ts — CRUD Mẫu tin nhắn + Thư mục (bản Community).
 *
 * VÌ SAO MODULE NÀY TỒN TẠI
 *   Bảng `message_templates` / `message_template_folders`, popup gõ "/" trong khung
 *   chat (quick-template-popup.vue) và composable use-message-templates.ts đều nằm
 *   trong core và đã hoàn chỉnh — chỉ mỗi tầng route nằm trong bundle `_ee/automation`.
 *   Bản Community không có bundle đó nên mọi lời gọi rơi vào 404 và popup luôn trống.
 *   Module này lấp đúng khoảng trống ấy.
 *
 * ĐƯỜNG DẪN giữ nguyên `/api/v1/automation/...` để frontend không phải sửa. app.ts
 * chỉ đăng ký module này khi bundle `_ee` VẮNG MẶT → bản Extension vẫn dùng route
 * gốc của nó, không đụng độ trùng path lúc boot.
 *
 * Endpoints:
 *   GET    /api/v1/automation/templates                 — danh sách (lọc folder/visibility/tag/category/search)
 *   POST   /api/v1/automation/templates                 — tạo
 *   PUT    /api/v1/automation/templates/:id             — sửa
 *   DELETE /api/v1/automation/templates/:id             — xoá MỀM (archivedAt)
 *   POST   /api/v1/automation/templates/:id/track-use   — đếm lượt dùng
 *   GET    /api/v1/automation/template-folders          — danh sách thư mục + đếm mẫu
 *   POST   /api/v1/automation/template-folders          — tạo thư mục
 *   PUT    /api/v1/automation/template-folders/:id      — sửa thư mục
 *   DELETE /api/v1/automation/template-folders/:id      — xoá thư mục (?force=true nếu còn mẫu)
 *
 * Quyền: gộp resource 'block' theo mô hình "là chủ HOẶC có grant" — chi tiết ở
 * message-template-service.ts.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { hasGrant, type GrantsJson } from '../rbac/permission-types.js';
import {
  normalizeShortcut,
  deriveContent,
  buildTemplateReadWhere,
  buildFolderReadWhere,
  checkWritePermission,
  type Grants,
  type RichPayload,
} from './message-template-service.js';

/** Trần số mẫu trả về 1 lần — popup chat nạp toàn bộ danh sách nên phải có trần. */
const MAX_TEMPLATES = 500;
const MAX_NAME_LEN = 120;
const MAX_CONTENT_LEN = 8000;
const MAX_TAGS = 20;

interface TemplateBody {
  name?: string;
  shortcut?: string | null;
  content?: string;
  contentRich?: RichPayload | null;
  category?: string | null;
  folderId?: string | null;
  visibility?: string;
  tagIds?: string[];
}

/**
 * Nạp 5 grant của resource 'block' trong MỘT truy vấn.
 *
 * Không dùng userHasGrant() 5 lần: GET /templates chạy mỗi lần sale mở khung chat,
 * 5 roundtrip cho cùng một dòng user là lãng phí thấy rõ. Giữ nguyên quy tắc fallback
 * legacy role owner/admin → toàn quyền (khớp userHasGrant).
 */
async function loadBlockGrants(userId: string): Promise<Grants> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      permissionGroup: { select: { grants: true, archivedAt: true } },
    },
  });
  if (!user) return { access: false, create: false, edit: false, delete: false, viewAll: false };

  if (user.role === 'owner' || user.role === 'admin') {
    return { access: true, create: true, edit: true, delete: true, viewAll: true };
  }

  const g = (user.permissionGroup && !user.permissionGroup.archivedAt
    ? (user.permissionGroup.grants ?? {})
    : {}) as GrantsJson;

  return {
    access: hasGrant(g, 'block', 'access'),
    create: hasGrant(g, 'block', 'create'),
    edit: hasGrant(g, 'block', 'edit'),
    delete: hasGrant(g, 'block', 'delete'),
    viewAll: hasGrant(g, 'block', 'view_all'),
  };
}

type TemplateWithFolder = {
  id: string;
  name: string;
  shortcut: string | null;
  content: string;
  contentRich: unknown;
  category: string | null;
  folderId: string | null;
  visibility: string;
  tagIds: string[];
  usageCount: number;
  manualSendCount: number;
  archivedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  folder?: { visibility: string } | null;
};

/** Mẫu trong thư mục kế thừa visibility của thư mục; mẫu lẻ dùng cột của chính nó. */
function effectiveVisibility(row: { visibility: string; folder?: { visibility: string } | null }): string {
  return row.folder ? row.folder.visibility : row.visibility;
}

function serializeTemplate(row: TemplateWithFolder, userId: string) {
  const vis = effectiveVisibility(row);
  return {
    id: row.id,
    name: row.name,
    shortcut: row.shortcut,
    content: row.content,
    contentRich: row.contentRich,
    category: row.category,
    folderId: row.folderId,
    visibility: vis,
    tagIds: row.tagIds,
    // isPersonal điều khiển icon trong popup chat (mdi-account vs mdi-account-group).
    isPersonal: vis !== 'public',
    isMine: row.createdById === userId,
    usageCount: row.usageCount,
    manualSendCount: row.manualSendCount,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeTagIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = input
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter(Boolean);
  return Array.from(new Set(out)).slice(0, MAX_TAGS);
}

function parseVisibility(input: unknown, fallback: 'public' | 'private'): 'public' | 'private' {
  return input === 'public' || input === 'private' ? input : fallback;
}

export async function messageTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // ─── GET /templates ────────────────────────────────────────────────────────
  app.get<{
    Querystring: {
      folderId?: string;
      visibility?: string;
      tags?: string;
      category?: string;
      search?: string;
      includeArchived?: string;
    };
  }>('/api/v1/automation/templates', async (request, reply) => {
    const user = request.user!;
    const grants = await loadBlockGrants(user.id);
    if (!grants.access) {
      return reply.status(403).send({ error: 'Bạn không có quyền dùng Mẫu tin nhắn', code: 'RBAC_FORBIDDEN' });
    }

    const { folderId, visibility, tags, category, search, includeArchived } = request.query;
    const where: any = buildTemplateReadWhere({
      orgId: user.orgId,
      userId: user.id,
      canViewAll: grants.viewAll,
    });

    if (includeArchived !== 'true') where.archivedAt = null;
    // 'root' = mẫu lẻ (không nằm trong thư mục nào).
    if (folderId) where.folderId = folderId === 'root' ? null : folderId;
    if (category) where.category = category;

    const tagList = (tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    if (tagList.length) where.tagIds = { hasSome: tagList };

    if (search?.trim()) {
      const q = search.trim();
      where.AND = [
        ...(where.AND ?? []),
        { OR: [{ name: { contains: q, mode: 'insensitive' } }, { content: { contains: q, mode: 'insensitive' } }] },
      ];
    }

    // Lọc theo visibility HIỆU LỰC (mẫu trong thư mục tính theo thư mục) → phải là
    // AND riêng, không gộp vào OR quyền đọc ở trên kẻo nới lỏng phạm vi thấy.
    if (visibility === 'public' || visibility === 'private') {
      where.AND = [
        ...(where.AND ?? []),
        { OR: [{ folderId: null, visibility }, { folder: { is: { visibility } } }] },
      ];
    }

    const rows = (await prisma.messageTemplate.findMany({
      where,
      include: { folder: { select: { visibility: true } } },
      orderBy: [{ usageCount: 'desc' }, { updatedAt: 'desc' }],
      take: MAX_TEMPLATES,
    })) as unknown as TemplateWithFolder[];

    return reply.send({ templates: rows.map((r) => serializeTemplate(r, user.id)) });
  });

  // ─── POST /templates ───────────────────────────────────────────────────────
  app.post<{ Body: TemplateBody }>('/api/v1/automation/templates', async (request, reply) => {
    const user = request.user!;
    const grants = await loadBlockGrants(user.id);
    const body = request.body ?? {};

    const name = (body.name ?? '').trim();
    if (!name) return reply.status(400).send({ error: 'Tên mẫu không được để trống' });
    if (name.length > MAX_NAME_LEN) return reply.status(400).send({ error: `Tên mẫu tối đa ${MAX_NAME_LEN} ký tự` });

    const { content, contentRich } = deriveContent(body);
    if (!content.trim()) return reply.status(400).send({ error: 'Nội dung mẫu không được để trống' });
    if (content.length > MAX_CONTENT_LEN) {
      return reply.status(400).send({ error: `Nội dung mẫu tối đa ${MAX_CONTENT_LEN} ký tự` });
    }

    // Thư mục quyết định visibility hiệu lực → resolve trước khi xét quyền.
    let folderVisibility: string | null = null;
    if (body.folderId) {
      const folder = await prisma.messageTemplateFolder.findFirst({
        where: { id: body.folderId, orgId: user.orgId },
        select: { visibility: true },
      });
      if (!folder) return reply.status(404).send({ error: 'Thư mục không tồn tại' });
      folderVisibility = folder.visibility;
    }
    const ownVisibility = parseVisibility(body.visibility, 'private');
    const nextVisibility = folderVisibility ?? ownVisibility;

    const perm = checkWritePermission({ row: null, userId: user.id, grants, nextVisibility, action: 'create' });
    if (!perm.ok) return reply.status(403).send({ error: perm.message, code: perm.code });

    const shortcut = normalizeShortcut(body.shortcut);
    if (shortcut) {
      const dup = await prisma.messageTemplate.findFirst({
        where: { orgId: user.orgId, shortcut, archivedAt: null },
        select: { id: true, name: true },
      });
      if (dup) {
        return reply.status(409).send({
          error: `Từ khoá gõ tắt "/${shortcut}" đã dùng cho mẫu "${dup.name}"`,
          code: 'SHORTCUT_TAKEN',
        });
      }
    }

    const created = await prisma.messageTemplate.create({
      data: {
        orgId: user.orgId,
        name,
        shortcut,
        content,
        contentRich: contentRich as any,
        category: body.category?.trim() || null,
        folderId: body.folderId || null,
        visibility: ownVisibility,
        tagIds: normalizeTagIds(body.tagIds),
        createdById: user.id,
      },
      include: { folder: { select: { visibility: true } } },
    });

    return reply.status(201).send(serializeTemplate(created as unknown as TemplateWithFolder, user.id));
  });

  // ─── PUT /templates/:id ────────────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: TemplateBody }>(
    '/api/v1/automation/templates/:id',
    async (request, reply) => {
      const user = request.user!;
      const grants = await loadBlockGrants(user.id);
      const body = request.body ?? {};

      // Đọc qua where-quyền: mẫu riêng của người khác trả 404 chứ không phải 403 —
      // 403 sẽ tiết lộ là có tồn tại mẫu đó.
      const readWhere: any = buildTemplateReadWhere({
        orgId: user.orgId,
        userId: user.id,
        canViewAll: grants.viewAll,
      });
      const existing = await prisma.messageTemplate.findFirst({
        where: { ...readWhere, id: request.params.id },
        include: { folder: { select: { visibility: true } } },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tìm thấy mẫu tin nhắn' });

      // Resolve visibility hiệu lực SAU khi sửa.
      const nextFolderId = body.folderId !== undefined ? body.folderId || null : existing.folderId;
      let folderVisibility: string | null = null;
      if (nextFolderId) {
        const folder = await prisma.messageTemplateFolder.findFirst({
          where: { id: nextFolderId, orgId: user.orgId },
          select: { visibility: true },
        });
        if (!folder) return reply.status(404).send({ error: 'Thư mục không tồn tại' });
        folderVisibility = folder.visibility;
      }
      const ownVisibility = parseVisibility(body.visibility, existing.visibility as 'public' | 'private');
      const nextVisibility = folderVisibility ?? ownVisibility;

      const perm = checkWritePermission({
        row: {
          createdById: existing.createdById,
          // So sánh trạng thái CÔNG KHAI hiện tại theo visibility hiệu lực, không
          // theo cột thô — mẫu nằm trong thư mục công khai vốn đã là công khai.
          visibility: effectiveVisibility(existing as any),
          folderId: existing.folderId,
        },
        userId: user.id,
        grants,
        nextVisibility,
        action: 'edit',
      });
      if (!perm.ok) return reply.status(403).send({ error: perm.message, code: perm.code });

      const data: any = {};

      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name) return reply.status(400).send({ error: 'Tên mẫu không được để trống' });
        if (name.length > MAX_NAME_LEN) return reply.status(400).send({ error: `Tên mẫu tối đa ${MAX_NAME_LEN} ký tự` });
        data.name = name;
      }

      if (body.content !== undefined || body.contentRich !== undefined) {
        const { content, contentRich } = deriveContent({
          content: body.content ?? existing.content,
          contentRich: (body.contentRich ?? null) as RichPayload | null,
        });
        if (!content.trim()) return reply.status(400).send({ error: 'Nội dung mẫu không được để trống' });
        if (content.length > MAX_CONTENT_LEN) {
          return reply.status(400).send({ error: `Nội dung mẫu tối đa ${MAX_CONTENT_LEN} ký tự` });
        }
        data.content = content;
        data.contentRich = contentRich as any;
      }

      if (body.shortcut !== undefined) {
        const shortcut = normalizeShortcut(body.shortcut);
        if (shortcut && shortcut !== existing.shortcut) {
          const dup = await prisma.messageTemplate.findFirst({
            where: { orgId: user.orgId, shortcut, archivedAt: null, id: { not: existing.id } },
            select: { id: true, name: true },
          });
          if (dup) {
            return reply.status(409).send({
              error: `Từ khoá gõ tắt "/${shortcut}" đã dùng cho mẫu "${dup.name}"`,
              code: 'SHORTCUT_TAKEN',
            });
          }
        }
        data.shortcut = shortcut;
      }

      if (body.category !== undefined) data.category = body.category?.trim() || null;
      if (body.folderId !== undefined) data.folderId = nextFolderId;
      if (body.visibility !== undefined) data.visibility = ownVisibility;
      if (body.tagIds !== undefined) data.tagIds = normalizeTagIds(body.tagIds);

      const updated = await prisma.messageTemplate.update({
        where: { id: existing.id },
        data,
        include: { folder: { select: { visibility: true } } },
      });

      return reply.send(serializeTemplate(updated as unknown as TemplateWithFolder, user.id));
    },
  );

  // ─── DELETE /templates/:id — xoá MỀM ───────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/api/v1/automation/templates/:id', async (request, reply) => {
    const user = request.user!;
    const grants = await loadBlockGrants(user.id);

    const readWhere: any = buildTemplateReadWhere({
      orgId: user.orgId,
      userId: user.id,
      canViewAll: grants.viewAll,
    });
    const existing = await prisma.messageTemplate.findFirst({
      where: { ...readWhere, id: request.params.id },
      include: { folder: { select: { visibility: true } } },
    });
    if (!existing) return reply.status(404).send({ error: 'Không tìm thấy mẫu tin nhắn' });

    const perm = checkWritePermission({
      row: {
        createdById: existing.createdById,
        visibility: effectiveVisibility(existing as any),
        folderId: existing.folderId,
      },
      userId: user.id,
      grants,
      nextVisibility: effectiveVisibility(existing as any),
      action: 'delete',
    });
    if (!perm.ok) return reply.status(403).send({ error: perm.message, code: perm.code });

    // Xoá mềm: mẫu đã chèn vào hội thoại vẫn cần tra ngược được, và còn giữ số liệu
    // usageCount cho báo cáo. Giữ nguyên shortcut — kiểm tra trùng đã lọc
    // archivedAt: null nên mẫu đã xoá không chiếm chỗ từ khoá của ai.
    await prisma.messageTemplate.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });

    return reply.send({ ok: true });
  });

  // ─── POST /templates/:id/track-use ─────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/api/v1/automation/templates/:id/track-use',
    async (request, reply) => {
      const user = request.user!;
      const grants = await loadBlockGrants(user.id);
      if (!grants.access) return reply.status(403).send({ error: 'Không có quyền', code: 'RBAC_FORBIDDEN' });

      const readWhere: any = buildTemplateReadWhere({
        orgId: user.orgId,
        userId: user.id,
        canViewAll: grants.viewAll,
      });

      // updateMany + where-quyền: không lộ sự tồn tại của mẫu người khác, và không
      // cần thêm một truy vấn đọc trước.
      const now = new Date();
      const res = await prisma.messageTemplate.updateMany({
        where: { ...readWhere, id: request.params.id },
        data: {
          usageCount: { increment: 1 },
          manualSendCount: { increment: 1 },
          lastUsedAt: now,
          lastManualSentAt: now,
        },
      });

      return reply.send({ ok: res.count > 0 });
    },
  );

  // ─── GET /template-folders ─────────────────────────────────────────────────
  app.get('/api/v1/automation/template-folders', async (request, reply) => {
    const user = request.user!;
    const grants = await loadBlockGrants(user.id);
    if (!grants.access) {
      return reply.status(403).send({ error: 'Bạn không có quyền dùng Mẫu tin nhắn', code: 'RBAC_FORBIDDEN' });
    }

    const where: any = buildFolderReadWhere({
      orgId: user.orgId,
      userId: user.id,
      canViewAll: grants.viewAll,
    });

    const folders = await prisma.messageTemplateFolder.findMany({
      where,
      orderBy: [{ visibility: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { templates: true } } },
    });

    return reply.send({
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        visibility: f.visibility,
        ownerUserId: f.ownerUserId,
        isMine: f.createdById === user.id || f.ownerUserId === user.id,
        _count: f._count,
      })),
    });
  });

  // ─── POST /template-folders ────────────────────────────────────────────────
  app.post<{ Body: { name?: string; visibility?: string } }>(
    '/api/v1/automation/template-folders',
    async (request, reply) => {
      const user = request.user!;
      const grants = await loadBlockGrants(user.id);
      const name = (request.body?.name ?? '').trim();
      if (!name) return reply.status(400).send({ error: 'Tên thư mục không được để trống' });
      if (name.length > MAX_NAME_LEN) return reply.status(400).send({ error: `Tên thư mục tối đa ${MAX_NAME_LEN} ký tự` });

      const visibility = parseVisibility(request.body?.visibility, 'public');
      const perm = checkWritePermission({
        row: null, userId: user.id, grants, nextVisibility: visibility, action: 'create',
      });
      if (!perm.ok) return reply.status(403).send({ error: perm.message, code: perm.code });

      const folder = await prisma.messageTemplateFolder.create({
        data: {
          orgId: user.orgId,
          name,
          visibility,
          // Phase 1 khoá 1 cấp (schema giữ parentId cho Phase 2).
          parentId: null,
          ownerUserId: visibility === 'private' ? user.id : null,
          createdById: user.id,
        },
        include: { _count: { select: { templates: true } } },
      });

      return reply.status(201).send({
        id: folder.id,
        name: folder.name,
        visibility: folder.visibility,
        ownerUserId: folder.ownerUserId,
        isMine: true,
        _count: folder._count,
      });
    },
  );

  // ─── PUT /template-folders/:id ─────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: { name?: string; visibility?: string } }>(
    '/api/v1/automation/template-folders/:id',
    async (request, reply) => {
      const user = request.user!;
      const grants = await loadBlockGrants(user.id);

      const readWhere: any = buildFolderReadWhere({
        orgId: user.orgId, userId: user.id, canViewAll: grants.viewAll,
      });
      const existing = await prisma.messageTemplateFolder.findFirst({
        where: { ...readWhere, id: request.params.id },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tìm thấy thư mục' });

      const nextVisibility = parseVisibility(request.body?.visibility, existing.visibility as 'public' | 'private');
      const perm = checkWritePermission({
        row: {
          createdById: existing.createdById,
          visibility: existing.visibility,
          folderId: null,
        },
        userId: user.id,
        grants,
        nextVisibility,
        action: 'edit',
      });
      if (!perm.ok) return reply.status(403).send({ error: perm.message, code: perm.code });

      const data: any = {};
      if (request.body?.name !== undefined) {
        const name = request.body.name.trim();
        if (!name) return reply.status(400).send({ error: 'Tên thư mục không được để trống' });
        data.name = name;
      }
      if (request.body?.visibility !== undefined) {
        data.visibility = nextVisibility;
        // Riêng tư → gắn chủ; công khai → gỡ chủ (mọi người trong org dùng chung).
        data.ownerUserId = nextVisibility === 'private' ? (existing.ownerUserId ?? user.id) : null;
      }

      const updated = await prisma.messageTemplateFolder.update({
        where: { id: existing.id },
        data,
        include: { _count: { select: { templates: true } } },
      });

      return reply.send({
        id: updated.id,
        name: updated.name,
        visibility: updated.visibility,
        ownerUserId: updated.ownerUserId,
        isMine: updated.createdById === user.id || updated.ownerUserId === user.id,
        _count: updated._count,
      });
    },
  );

  // ─── DELETE /template-folders/:id ──────────────────────────────────────────
  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/api/v1/automation/template-folders/:id',
    async (request, reply) => {
      const user = request.user!;
      const grants = await loadBlockGrants(user.id);

      const readWhere: any = buildFolderReadWhere({
        orgId: user.orgId, userId: user.id, canViewAll: grants.viewAll,
      });
      const existing = await prisma.messageTemplateFolder.findFirst({
        where: { ...readWhere, id: request.params.id },
        include: { _count: { select: { templates: true } } },
      });
      if (!existing) return reply.status(404).send({ error: 'Không tìm thấy thư mục' });

      const perm = checkWritePermission({
        row: { createdById: existing.createdById, visibility: existing.visibility, folderId: null },
        userId: user.id,
        grants,
        nextVisibility: existing.visibility,
        action: 'delete',
      });
      if (!perm.ok) return reply.status(403).send({ error: perm.message, code: perm.code });

      // Còn mẫu bên trong mà không có ?force → dừng, để người dùng biết mình sắp
      // đẩy bao nhiêu mẫu ra ngoài thư mục.
      if (existing._count.templates > 0 && request.query.force !== 'true') {
        return reply.status(409).send({
          error: `Thư mục còn ${existing._count.templates} mẫu. Xoá thư mục sẽ đưa các mẫu này ra ngoài.`,
          code: 'FOLDER_NOT_EMPTY',
          templateCount: existing._count.templates,
        });
      }

      // FK message_templates.folder_id ON DELETE SET NULL → mẫu tự rơi về "mẫu lẻ".
      // Mẫu lẻ dùng cột visibility của chính nó, mặc định 'private' → không có mẫu
      // nào vô tình lộ ra công khai sau khi thư mục biến mất.
      await prisma.messageTemplateFolder.delete({ where: { id: existing.id } });

      return reply.send({ ok: true, releasedTemplates: existing._count.templates });
    },
  );
}
