/**
 * unreplied-filter.test.ts — Hồi quy: KPI "Chưa rep" trên Dashboard phải đếm CÙNG luật
 * với màn Tin nhắn và chuông thông báo.
 *
 * Sự cố 2026-08-11 (org BMA): Dashboard đòi `isReplied=false` VÀ `unreadCount>0`, trong
 * khi màn Tin nhắn (chat-routes /conversations/counts) và notification-routes chỉ dùng
 * `isReplied=false`. Toàn org lúc đó có 45 hội thoại chưa rep nhưng chỉ 14 cái còn
 * unread → Dashboard bỏ sót 31 cái và hiện 0.
 *
 * Nguyên nhân sâu: `unreadCount` bị reset về 0 ngay khi chủ nick MỞ hội thoại (và khi
 * gửi tin). Sale đọc tin trên điện thoại rồi chưa trả lời là ca phổ biến nhất — đúng
 * ca cần nhắc thì lại bị loại.
 *
 * Bất biến khoá: luật "chưa rep" = CHỈ `isReplied=false`. Thêm bất kỳ điều kiện nào
 * về unreadCount là làm lệch Dashboard khỏi màn Tin nhắn.
 *
 * Convention contact-ghost-filter (test predicate đếm, KHÔNG mock DB).
 */
import { describe, it, expect } from 'vitest';
import {
  UNREPLIED_WHERE,
  isUnreplied,
  unrepliedKpiWhere,
  urgentConversationWhere,
} from '../src/modules/chat/unreplied-filter.js';

describe('unreplied-filter — luật "chưa rep" dùng chung Dashboard ↔ Tin nhắn', () => {
  it('luật canonical CHỈ là isReplied=false — không kèm unreadCount', () => {
    expect(UNREPLIED_WHERE).toEqual({ isReplied: false });
    expect(UNREPLIED_WHERE).not.toHaveProperty('unreadCount');
  });

  it('KH nhắn cuối, sale ĐÃ MỞ đọc (unreadCount=0) → VẪN tính là chưa rep', () => {
    expect(isUnreplied({ isReplied: false, unreadCount: 0 })).toBe(true);
  });

  it('KH nhắn cuối, còn tin chưa đọc → tính là chưa rep', () => {
    expect(isUnreplied({ isReplied: false, unreadCount: 3 })).toBe(true);
  });

  it('sale đã trả lời → KHÔNG tính, dù còn tin chưa đọc', () => {
    expect(isUnreplied({ isReplied: true, unreadCount: 3 })).toBe(false);
  });

  it('unrepliedKpiWhere: scope nick + chỉ 1-1 + chưa xóa, và KHÔNG có unreadCount', () => {
    const where = unrepliedKpiWhere('org-1', ['za-1', 'za-2']);

    expect(where).toEqual({
      orgId: 'org-1',
      zaloAccountId: { in: ['za-1', 'za-2'] },
      threadType: 'user',
      deletedAt: null,
      isReplied: false,
    });
    expect(where).not.toHaveProperty('unreadCount');
  });

  it('urgentConversationWhere: cùng luật với thẻ KPI, thêm ràng buộc phải gắn KH', () => {
    const where = urgentConversationWhere('org-1', ['za-1']);

    // Danh sách "Cần rep gấp" phải khớp thẻ KPI "Chưa rep" — nếu lệch, dashboard sẽ
    // hiện "Chưa rep 2" mà danh sách bên dưới lại báo "Không có tin nào chưa rep".
    expect(where).toMatchObject(unrepliedKpiWhere('org-1', ['za-1']));
    // Thẻ trong danh sách render tên + avatar KH nên bắt buộc có contactId.
    expect(where.contactId).toEqual({ not: null });
    expect(where).not.toHaveProperty('unreadCount');
  });

  it('ca thật của nick "Gia Linh" 11/8: 2 hội thoại chưa rep, unread=0 → đếm 2 (trước đây 0)', () => {
    // 3 hội thoại 1-1 của nick còn sống, không cái nào còn unread.
    const giaLinhThreads = [
      { isReplied: false, unreadCount: 0 },
      { isReplied: false, unreadCount: 0 },
      { isReplied: true, unreadCount: 0 },
    ];
    expect(giaLinhThreads.filter(isUnreplied).length).toBe(2);
  });
});
