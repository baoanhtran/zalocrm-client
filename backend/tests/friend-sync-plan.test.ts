/**
 * friend-sync-plan.test.ts — chọn bạn bè nào cần xử lý ĐẦY ĐỦ trong 1 chu kỳ đồng bộ.
 * Mục tiêu: bạn bè không đổi thì bỏ qua (không ghi DB), nhưng vẫn được soát lại đúng
 * 1 lần mỗi ngày để giữ các bước tự-chữa (ContactAccess, gắn lại hội thoại...).
 */
import { describe, it, expect } from 'vitest';
import { shouldProcessFriend, isDueForRecheck } from '../src/modules/zalo/friend-sync-plan.js';

const HOUR = 3_600_000;
const UNCHANGED_ACCEPTED = { friendshipStatus: 'accepted', relationshipKind: 'friend' };

describe('shouldProcessFriend', () => {
  it('xử lý bạn bè mới (chưa có row Friend)', () => {
    expect(shouldProcessFriend({ existing: undefined, targetStatus: 'accepted', identityChanged: false, dueForRecheck: false })).toBe(true);
  });

  it('xử lý khi trạng thái kết bạn đổi (đã gửi lời mời → đã kết bạn)', () => {
    expect(shouldProcessFriend({
      existing: { friendshipStatus: 'pending_sent', relationshipKind: 'pending_friend' },
      targetStatus: 'accepted', identityChanged: false, dueForRecheck: false,
    })).toBe(true);
  });

  it('xử lý khi relationshipKind lệch với trạng thái (dữ liệu cũ sai)', () => {
    expect(shouldProcessFriend({
      existing: { friendshipStatus: 'accepted', relationshipKind: 'chatting_stranger' },
      targetStatus: 'accepted', identityChanged: false, dueForRecheck: false,
    })).toBe(true);
  });

  it('xử lý khi tên/avatar/globalId/username đổi', () => {
    expect(shouldProcessFriend({ existing: UNCHANGED_ACCEPTED, targetStatus: 'accepted', identityChanged: true, dueForRecheck: false })).toBe(true);
  });

  it('BỎ QUA bạn bè không đổi gì khi chưa tới lượt soát lại', () => {
    expect(shouldProcessFriend({ existing: UNCHANGED_ACCEPTED, targetStatus: 'accepted', identityChanged: false, dueForRecheck: false })).toBe(false);
  });

  it('bỏ qua lời mời đã gửi không đổi gì', () => {
    expect(shouldProcessFriend({
      existing: { friendshipStatus: 'pending_sent', relationshipKind: 'pending_friend' },
      targetStatus: 'pending_sent', identityChanged: false, dueForRecheck: false,
    })).toBe(false);
  });

  it('xử lý bạn bè không đổi khi tới lượt soát lại hằng ngày', () => {
    expect(shouldProcessFriend({ existing: UNCHANGED_ACCEPTED, targetStatus: 'accepted', identityChanged: false, dueForRecheck: true })).toBe(true);
  });
});

describe('isDueForRecheck', () => {
  const uids = Array.from({ length: 50 }, (_, i) => `${7_000_000_000_000_000 + i * 7919}`);

  it('mỗi bạn bè tới lượt đúng 1 lần trong 24 chu kỳ giờ liên tiếp, bắt đầu từ giờ nào cũng vậy', () => {
    for (const startHour of [0, 5, 13, 490_000]) {
      for (const uid of uids) {
        let due = 0;
        for (let h = startHour; h < startHour + 24; h++) {
          if (isDueForRecheck(uid, h * HOUR + 7 * 60_000)) due++;
        }
        expect(due).toBe(1);
      }
    }
  });

  it('rải đều: giờ nào trong ngày cũng có bạn bè tới lượt (không dồn cả ngày vào 1 giờ)', () => {
    const many = Array.from({ length: 2400 }, (_, i) => String(1_000_000 + i * 104_729));
    const perHour = new Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      for (const uid of many) if (isDueForRecheck(uid, h * HOUR)) perHour[h]++;
    }
    // Trung bình 100/giờ; hàm băm hỏng (trả hằng số) sẽ dồn 2400 vào 1 giờ.
    expect(Math.min(...perHour)).toBeGreaterThan(40);
    expect(Math.max(...perHour)).toBeLessThan(200);
  });
});
