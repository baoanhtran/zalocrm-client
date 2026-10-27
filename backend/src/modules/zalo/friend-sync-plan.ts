// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * friend-sync-plan.ts — chọn bạn bè nào cần xử lý ĐẦY ĐỦ (processFriend) trong 1 chu kỳ
 * đồng bộ cron/connect.
 *
 * processFriend tốn ~13 truy vấn/bạn bè (resolve contact + transaction applyFriendTransition
 * + gắn lại hội thoại + event danh sách KH). Chạy cho MỌI bạn bè mỗi chu kỳ thì luồng Node
 * bị chiếm gần hết khi lên 100 nick (đo VPS BMA 2026-10-28: 24s CPU mỗi chu kỳ cho ~5k bạn bè).
 * → Chỉ xử lý bạn bè mới / đổi trạng thái / đổi danh tính. Bạn bè không đổi vẫn được soát
 *   đầy đủ 1 lần/ngày (rải đều theo giờ) để giữ các bước tự-chữa của processFriend:
 *   ContactAccess cho chủ nick, assignedUser, gắn lại hội thoại lệch contact, bù
 *   gender/ngày sinh/SĐT cho Contact.
 */

// Cron chạy mỗi giờ → 24 lượt = mỗi bạn bè được soát lại 1 lần/ngày.
const RECHECK_SLOTS = 24;
const HOUR_MS = 3_600_000;

// Khớp deriveRelationshipKind (friend-event-handler.ts) cho 2 trạng thái sync xử lý.
const KIND_FOR_STATUS: Record<string, string> = {
  accepted: 'friend',
  pending_sent: 'pending_friend',
};

export function shouldProcessFriend(input: {
  existing: { friendshipStatus: string; relationshipKind: string } | undefined;
  targetStatus: 'accepted' | 'pending_sent';
  identityChanged: boolean;
  dueForRecheck: boolean;
}): boolean {
  const { existing, targetStatus } = input;
  if (!existing) return true;
  if (existing.friendshipStatus !== targetStatus) return true;
  if (existing.relationshipKind !== KIND_FOR_STATUS[targetStatus]) return true;
  return input.identityChanged || input.dueForRecheck;
}

// FNV-1a 32-bit — rải uid đều vào các giờ, ổn định qua các lần restart.
function recheckSlotOf(uid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % RECHECK_SLOTS;
}

export function isDueForRecheck(uid: string, nowMs: number): boolean {
  return recheckSlotOf(uid) === Math.floor(nowMs / HOUR_MS) % RECHECK_SLOTS;
}
