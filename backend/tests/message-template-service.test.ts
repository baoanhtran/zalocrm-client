/**
 * message-template-service.test.ts — hàm THUẦN của module Mẫu tin nhắn (Community).
 *
 * Phủ 4 vùng dễ sai nhất:
 *   1. normalizeShortcut — bỏ dấu / lowercase / lọc ký tự, PHẢI khớp normQuery ở
 *      quick-template-popup.vue, nếu lệch thì sale gõ "/giaegv" không ra mẫu.
 *   2. deriveContent    — content plain LUÔN = contentRich.text (schema bắt buộc).
 *   3. buildTemplateReadWhere — mẫu riêng của người khác KHÔNG được lộ.
 *   4. checkWritePermission   — đăng công khai cần block.create; sửa/xoá mẫu người
 *      khác cần block.edit/delete; mẫu của mình thì không cần grant.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeShortcut,
  deriveContent,
  buildTemplateReadWhere,
  buildFolderReadWhere,
  checkWritePermission,
  type Grants,
} from '../src/modules/message-templates/message-template-service.js';

const ME = 'user-me';
const OTHER = 'user-other';
const ORG = 'org-1';

/** Grants của nhóm "Sale" mặc định: chỉ access, không create/edit/delete/view_all. */
const SALE: Grants = { access: true, create: false, edit: false, delete: false, viewAll: false };
/** Grants nhóm "Sale Senior": access + create + edit. */
const SENIOR: Grants = { access: true, create: true, edit: true, delete: false, viewAll: false };
/** Grants nhóm "Trưởng phòng"/Marketing: full. */
const MANAGER: Grants = { access: true, create: true, edit: true, delete: true, viewAll: true };

describe('normalizeShortcut — khớp normQuery của popup chat', () => {
  it('bỏ dấu tiếng Việt + đ/Đ → d', () => {
    expect(normalizeShortcut('giáĐất')).toBe('giadat');
    expect(normalizeShortcut('Tiến Độ')).toBe('tiendo');
  });

  it('bỏ khoảng trắng, lowercase, giữ [a-z0-9_-]', () => {
    expect(normalizeShortcut('  Gia EGV  ')).toBe('giaegv');
    expect(normalizeShortcut('bao_gia-2026')).toBe('bao_gia-2026');
  });

  it('lọc sạch ký tự lạ (emoji, dấu câu)', () => {
    expect(normalizeShortcut('giá!!! 💰(EGV)')).toBe('giaegv');
  });

  it('bỏ dấu "/" đầu — sale hay gõ cả dấu gạch', () => {
    expect(normalizeShortcut('/giaegv')).toBe('giaegv');
    expect(normalizeShortcut('///gia')).toBe('gia');
  });

  it('rỗng / chỉ ký tự lạ → null (không lưu chuỗi rỗng vào DB)', () => {
    expect(normalizeShortcut('')).toBeNull();
    expect(normalizeShortcut('   ')).toBeNull();
    expect(normalizeShortcut('!!!')).toBeNull();
    expect(normalizeShortcut(null)).toBeNull();
    expect(normalizeShortcut(undefined)).toBeNull();
  });
});

describe('deriveContent — content plain luôn bám contentRich.text', () => {
  it('có contentRich → content = contentRich.text, kể cả khi client gửi content lệch', () => {
    const out = deriveContent({
      content: 'CHUỖI LỆCH DO CLIENT GỬI',
      contentRich: { text: 'Chào {gender} {name}', styles: [{ st: 'b', start: 0, len: 4 }] },
    });
    expect(out.content).toBe('Chào {gender} {name}');
    expect(out.contentRich).toEqual({ text: 'Chào {gender} {name}', styles: [{ st: 'b', start: 0, len: 4 }] });
  });

  it('không có contentRich → dựng rich từ content plain (styles rỗng)', () => {
    const out = deriveContent({ content: 'Xin chào' });
    expect(out.content).toBe('Xin chào');
    expect(out.contentRich).toEqual({ text: 'Xin chào', styles: [] });
  });

  it('styles thiếu → mặc định mảng rỗng, không để undefined lọt xuống DB', () => {
    const out = deriveContent({ contentRich: { text: 'abc' } });
    expect(out.contentRich).toEqual({ text: 'abc', styles: [] });
  });

  it('loại style sai định dạng (thiếu start/len) để không lệch offset khi gửi Zalo', () => {
    const out = deriveContent({
      contentRich: {
        text: 'abcdef',
        styles: [
          { st: 'b', start: 0, len: 3 },
          { st: 'c_db342e', start: 2, len: 2 },
          { st: 'b', start: -1, len: 2 } as never, // start âm → loại
          { st: 'b', start: 4, len: 0 } as never, // len 0 → loại
          { st: 'b', start: 5, len: 99 } as never, // vượt độ dài text → loại
        ],
      },
    });
    expect(out.contentRich?.styles).toEqual([
      { st: 'b', start: 0, len: 3 },
      { st: 'c_db342e', start: 2, len: 2 },
    ]);
  });

  it('cả hai rỗng → content rỗng (route tự chặn bằng validate riêng)', () => {
    const out = deriveContent({});
    expect(out.content).toBe('');
  });
});

describe('buildTemplateReadWhere — mẫu riêng của người khác không được lộ', () => {
  it('user thường: chỉ thấy mẫu mình tạo + mẫu lẻ công khai + mẫu trong thư mục công khai', () => {
    const where = buildTemplateReadWhere({ orgId: ORG, userId: ME, canViewAll: false });
    expect(where.orgId).toBe(ORG);
    expect(where.OR).toEqual([
      { createdById: ME },
      { folderId: null, visibility: 'public' },
      { folder: { is: { visibility: 'public' } } },
    ]);
  });

  it('canViewAll → không áp nhánh OR nào (thấy toàn org)', () => {
    const where = buildTemplateReadWhere({ orgId: ORG, userId: ME, canViewAll: true });
    expect(where.orgId).toBe(ORG);
    expect(where.OR).toBeUndefined();
  });

  it('thư mục: user thường thấy thư mục công khai + thư mục của mình', () => {
    const where = buildFolderReadWhere({ orgId: ORG, userId: ME, canViewAll: false });
    expect(where.OR).toEqual([
      { visibility: 'public' },
      { ownerUserId: ME },
      { createdById: ME },
    ]);
  });
});

describe('checkWritePermission — tạo', () => {
  it('không có block.access → chặn hết', () => {
    const r = checkWritePermission({
      row: null, userId: ME, action: 'create', nextVisibility: 'private',
      grants: { access: false, create: false, edit: false, delete: false, viewAll: false },
    });
    expect(r.ok).toBe(false);
  });

  it('Sale tạo mẫu RIÊNG → được, không cần grant create', () => {
    const r = checkWritePermission({ row: null, userId: ME, action: 'create', nextVisibility: 'private', grants: SALE });
    expect(r.ok).toBe(true);
  });

  it('Sale đăng mẫu CÔNG KHAI → 403 vì thiếu block.create', () => {
    const r = checkWritePermission({ row: null, userId: ME, action: 'create', nextVisibility: 'public', grants: SALE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NEED_BLOCK_CREATE');
  });

  it('Sale Senior đăng mẫu công khai → được', () => {
    const r = checkWritePermission({ row: null, userId: ME, action: 'create', nextVisibility: 'public', grants: SENIOR });
    expect(r.ok).toBe(true);
  });
});

describe('checkWritePermission — sửa', () => {
  const myPrivate = { createdById: ME, visibility: 'private', folderId: null };
  const otherPrivate = { createdById: OTHER, visibility: 'private', folderId: null };
  const otherPublic = { createdById: OTHER, visibility: 'public', folderId: null };

  it('sửa mẫu riêng CỦA MÌNH → được, không cần grant edit', () => {
    const r = checkWritePermission({ row: myPrivate, userId: ME, action: 'edit', nextVisibility: 'private', grants: SALE });
    expect(r.ok).toBe(true);
  });

  it('Sale sửa mẫu của NGƯỜI KHÁC → 403 vì thiếu block.edit', () => {
    const r = checkWritePermission({ row: otherPrivate, userId: ME, action: 'edit', nextVisibility: 'private', grants: SALE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NEED_BLOCK_EDIT');
  });

  it('Sale đổi mẫu riêng của mình thành CÔNG KHAI → 403 (đây là hành vi đăng public)', () => {
    const r = checkWritePermission({ row: myPrivate, userId: ME, action: 'edit', nextVisibility: 'public', grants: SALE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NEED_BLOCK_CREATE');
  });

  it('mẫu ĐÃ công khai sẵn, chủ sửa nội dung (vẫn public) → không đòi lại block.create', () => {
    const myPublic = { createdById: ME, visibility: 'public', folderId: null };
    const r = checkWritePermission({ row: myPublic, userId: ME, action: 'edit', nextVisibility: 'public', grants: SALE });
    expect(r.ok).toBe(true);
  });

  it('Trưởng phòng sửa mẫu công khai của người khác → được', () => {
    const r = checkWritePermission({ row: otherPublic, userId: ME, action: 'edit', nextVisibility: 'public', grants: MANAGER });
    expect(r.ok).toBe(true);
  });

  it('hạ mẫu công khai xuống riêng tư → chỉ cần quyền sửa, không cần create', () => {
    const r = checkWritePermission({ row: otherPublic, userId: ME, action: 'edit', nextVisibility: 'private', grants: SENIOR });
    expect(r.ok).toBe(true);
  });
});

describe('checkWritePermission — xoá', () => {
  it('xoá mẫu của mình → được với block.access', () => {
    const r = checkWritePermission({
      row: { createdById: ME, visibility: 'private', folderId: null },
      userId: ME, action: 'delete', nextVisibility: 'private', grants: SALE,
    });
    expect(r.ok).toBe(true);
  });

  it('Sale Senior (không có block.delete) xoá mẫu người khác → 403', () => {
    const r = checkWritePermission({
      row: { createdById: OTHER, visibility: 'public', folderId: null },
      userId: ME, action: 'delete', nextVisibility: 'public', grants: SENIOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NEED_BLOCK_DELETE');
  });

  it('Trưởng phòng xoá mẫu người khác → được', () => {
    const r = checkWritePermission({
      row: { createdById: OTHER, visibility: 'public', folderId: null },
      userId: ME, action: 'delete', nextVisibility: 'public', grants: MANAGER,
    });
    expect(r.ok).toBe(true);
  });

  it('mẫu mồ côi (createdById null, legacy) → cần grant, không ai "là chủ"', () => {
    const r = checkWritePermission({
      row: { createdById: null, visibility: 'public', folderId: null },
      userId: ME, action: 'delete', nextVisibility: 'public', grants: SALE,
    });
    expect(r.ok).toBe(false);
  });
});
