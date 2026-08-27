// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * message-template-service.ts — hàm THUẦN cho Mẫu tin nhắn (bản Community).
 *
 * Bối cảnh: route CRUD Mẫu tin nhắn vốn nằm trong bundle `_ee/automation`. Bản
 * Community không có bundle đó, trong khi bảng `message_templates` +
 * `message_template_folders` và toàn bộ UI chat (popup gõ "/") ĐÃ có sẵn trong
 * core → module này lấp đúng phần thiếu, không đụng seam `_ee`.
 *
 * File này chỉ chứa logic thuần (không chạm Prisma) để test được bằng unit test
 * thường — xem tests/message-template-service.test.ts. Phần I/O ở
 * message-template-routes.ts.
 *
 * MÔ HÌNH QUYỀN (bám comment trong schema.prisma: model MessageTemplate)
 *   Gộp chung resource RBAC 'block', theo nguyên tắc "là chủ HOẶC có grant":
 *     - chủ (createdById === userId) tạo/sửa/xoá mẫu RIÊNG của mình → chỉ cần block.access
 *     - đăng CÔNG KHAI (private → public) → cần block.create
 *     - đụng mẫu người khác → cần block.edit / block.delete
 *     - block.view_all (hoặc legacy role owner/admin) → đọc toàn org
 *
 * VISIBILITY
 *   - Mẫu LẺ (folderId = null) dùng cột `visibility` của chính nó.
 *   - Mẫu TRONG THƯ MỤC kế thừa `folder.visibility` (cột visibility của mẫu bị bỏ qua).
 *   - Không cần nhánh legacy `ownerUserId IS NULL`: migration 20260609160000 đã
 *     backfill sẵn (ownerUserId NULL → 'public', khác NULL → 'private' + created_by_id).
 */

export interface Style {
  st: string;
  start: number;
  len: number;
}

export interface RichPayload {
  text: string;
  styles?: Style[];
}

export interface Grants {
  access: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
}

export type Visibility = 'public' | 'private';

/** Phần của bản ghi mẫu mà tầng quyền cần biết. */
export interface TemplateRow {
  createdById: string | null;
  visibility: string;
  folderId: string | null;
}

export type PermissionResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Chuẩn hoá từ khoá gõ tắt.
 *
 * PHẢI khớp `normQuery()` trong frontend/src/components/chat/quick-template-popup.vue —
 * popup so prefix giữa chuỗi sale gõ và `shortcut` lưu ở DB. Lệch một bước là sale
 * gõ "/giaegv" không ra mẫu nào mà không có lỗi gì hiện lên.
 *
 * @returns chuỗi đã chuẩn hoá, hoặc null nếu rỗng (để lưu NULL thay vì '' vào DB —
 *          '' sẽ khớp prefix với MỌI truy vấn ở popup).
 */
export function normalizeShortcut(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const out = raw
    .trim()
    .replace(/^\/+/, '') // sale hay gõ luôn cả dấu "/"
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return out.length ? out : null;
}

/** Style hợp lệ: neo được vào text, không âm, không rỗng, không tràn. */
function isValidStyle(s: unknown, textLen: number): s is Style {
  if (!s || typeof s !== 'object') return false;
  const { st, start, len } = s as Record<string, unknown>;
  if (typeof st !== 'string' || !st) return false;
  if (!Number.isInteger(start) || !Number.isInteger(len)) return false;
  if ((start as number) < 0 || (len as number) <= 0) return false;
  return (start as number) + (len as number) <= textLen;
}

/**
 * Chuẩn hoá cặp (content, contentRich).
 *
 * Schema quy định `content` (plain) LUÔN derive từ `contentRich.text` — plain dùng để
 * tìm kiếm và chèn vào ô chat, rich giữ định dạng đậm/màu kiểu Zalo. Không tin
 * `content` client gửi lên: lệch một ký tự là offset đậm/màu trượt khi gửi sang Zalo.
 *
 * Style sai định dạng bị LOẠI thay vì sửa — style trượt offset gây bôi đậm nhầm đoạn
 * trên tin đã gửi cho khách, không sửa lại được.
 */
export function deriveContent(input: {
  content?: string | null;
  contentRich?: RichPayload | null;
}): { content: string; contentRich: RichPayload | null } {
  const rich = input.contentRich;
  const text = typeof rich?.text === 'string' ? rich.text : (input.content ?? '');
  const rawStyles = Array.isArray(rich?.styles) ? rich.styles : [];
  const styles = rawStyles.filter((s) => isValidStyle(s, text.length));
  return { content: text, contentRich: { text, styles } };
}

/**
 * Where đọc danh sách mẫu.
 *
 * Ba nhánh OR (thứ tự giữ nguyên để test so khớp được):
 *   1. mẫu mình tạo — luôn thấy, dù nằm ở đâu
 *   2. mẫu LẺ công khai
 *   3. mẫu nằm trong thư mục công khai (kế thừa folder.visibility)
 *
 * canViewAll → bỏ hẳn OR, thấy toàn org.
 */
export function buildTemplateReadWhere(args: {
  orgId: string;
  userId: string;
  canViewAll: boolean;
}): Record<string, unknown> {
  const { orgId, userId, canViewAll } = args;
  if (canViewAll) return { orgId };
  return {
    orgId,
    OR: [
      { createdById: userId },
      { folderId: null, visibility: 'public' },
      { folder: { is: { visibility: 'public' } } },
    ],
  };
}

/** Where đọc thư mục: công khai, hoặc của mình (owner cũ hoặc người tạo). */
export function buildFolderReadWhere(args: {
  orgId: string;
  userId: string;
  canViewAll: boolean;
}): Record<string, unknown> {
  const { orgId, userId, canViewAll } = args;
  if (canViewAll) return { orgId };
  return {
    orgId,
    OR: [{ visibility: 'public' }, { ownerUserId: userId }, { createdById: userId }],
  };
}

const deny = (code: string, message: string): PermissionResult => ({ ok: false, code, message });

/**
 * Quyết định cho phép ghi hay không.
 *
 * @param row             bản ghi hiện tại; null = đang tạo mới
 * @param nextVisibility  visibility HIỆU LỰC sau thao tác (route phải resolve thư mục
 *                        trước rồi truyền vào — mẫu vào thư mục thì lấy theo thư mục)
 */
export function checkWritePermission(args: {
  row: TemplateRow | null;
  userId: string;
  grants: Grants;
  nextVisibility: string;
  action: 'create' | 'edit' | 'delete';
}): PermissionResult {
  const { row, userId, grants, nextVisibility, action } = args;

  if (!grants.access) {
    return deny('NEED_BLOCK_ACCESS', 'Bạn không có quyền dùng Mẫu tin nhắn');
  }

  // createdById null (mẫu mồ côi sau khi user bị xoá) → không ai là chủ.
  const isOwner = row !== null && row.createdById !== null && row.createdById === userId;

  if (action === 'create') {
    if (nextVisibility === 'public' && !grants.create) {
      return deny('NEED_BLOCK_CREATE', 'Bạn không có quyền đăng mẫu công khai cho cả tổ chức');
    }
    return { ok: true };
  }

  if (action === 'delete') {
    if (!isOwner && !grants.delete) {
      return deny('NEED_BLOCK_DELETE', 'Bạn không có quyền xoá mẫu của người khác');
    }
    return { ok: true };
  }

  // action === 'edit'
  if (!isOwner && !grants.edit) {
    return deny('NEED_BLOCK_EDIT', 'Bạn không có quyền sửa mẫu của người khác');
  }
  // Chỉ chặn lúc CHUYỂN sang công khai. Mẫu vốn đã công khai thì sửa nội dung
  // không đòi lại block.create (nếu không chủ mẫu sẽ tự khoá mình khỏi mẫu của mình).
  const becomingPublic = nextVisibility === 'public' && row?.visibility !== 'public';
  if (becomingPublic && !grants.create) {
    return deny('NEED_BLOCK_CREATE', 'Bạn không có quyền đăng mẫu công khai cho cả tổ chức');
  }
  return { ok: true };
}
