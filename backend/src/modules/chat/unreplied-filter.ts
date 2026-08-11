// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * unreplied-filter.ts — NGUỒN SỰ THẬT DUY NHẤT cho luật "chưa rep".
 *
 * Định nghĩa: hội thoại mà TIN CUỐI là của khách, sale chưa trả lời → `isReplied=false`.
 * `isReplied` được message-handler set khi có tin mới (xem message-handler.ts), và mọi
 * đường gửi tin đều set lại `true`.
 *
 * BUG 2026-08-11 (org BMA) — vì sao phải gom về một chỗ:
 *   Dashboard đếm `isReplied=false` VÀ `unreadCount>0`, còn màn Tin nhắn + chuông thông
 *   báo chỉ đếm `isReplied=false`. Hai màn lệch nhau. Toàn org có 45 hội thoại chưa rep
 *   nhưng chỉ 14 cái còn unread → Dashboard hiện 0 dù Tin nhắn đầy việc.
 *
 *   `unreadCount` KHÔNG phải proxy của "chưa rep": nó về 0 ngay khi chủ nick mở hội
 *   thoại (và khi gửi tin). Sale đọc tin trên điện thoại rồi quên trả lời — đúng ca cần
 *   nhắc nhất — lại bị loại khỏi KPI.
 *
 * ĐỪNG thêm điều kiện unreadCount vào đây. Cần "còn tin chưa đọc" thì đó là chỉ số
 * KHÁC (unread), đếm riêng — xem chat-routes /conversations/counts trả cả `unread` lẫn
 * `unreplied`.
 */

/** Mảnh where Prisma dùng chung. Caller tự AND thêm orgId/scope nick. */
export const UNREPLIED_WHERE = { isReplied: false } as const;

/** Cùng luật với UNREPLIED_WHERE, dạng JS — dùng cho lọc trong bộ nhớ và cho test. */
export function isUnreplied(c: { isReplied: boolean; unreadCount?: number }): boolean {
  return c.isReplied === false;
}

/**
 * Where cho KPI "Chưa rep" của Dashboard: giới hạn trong các nick truyền vào, CHỈ hội
 * thoại 1-1 (nhóm Zalo không phải KH cần rep — luật CRM 2026-05-29) và chưa xóa mềm.
 */
export function unrepliedKpiWhere(orgId: string, zaloAccountIds: string[]) {
  return {
    orgId,
    zaloAccountId: { in: zaloAccountIds },
    threadType: 'user',
    deletedAt: null,
    ...UNREPLIED_WHERE,
  };
}

/**
 * Where cho DANH SÁCH "Cần rep gấp" trên Dashboard — cùng luật với thẻ KPI ở trên nó,
 * thêm ràng buộc phải gắn KH (thẻ render tên + avatar contact).
 *
 * 2026-08-11 (anh chốt): trước đây danh sách này lọc `unreadCount>0` (chốt 2026-06-11)
 * còn thẻ KPI lọc kiểu khác → thẻ báo "Chưa rep 2" mà danh sách dưới vẫn in "Không có
 * tin nào chưa rep". Nay dùng chung một luật để hai chỗ luôn khớp.
 */
export function urgentConversationWhere(orgId: string, zaloAccountIds: string[]) {
  return {
    ...unrepliedKpiWhere(orgId, zaloAccountIds),
    contactId: { not: null },
  };
}
