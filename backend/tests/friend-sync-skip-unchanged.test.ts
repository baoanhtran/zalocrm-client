/**
 * friend-sync-skip-unchanged.test.ts — chu kỳ đồng bộ KHÔNG xử lý lại bạn bè không đổi.
 * Đo VPS BMA 2026-10-28: xử lý lại MỌI bạn bè mỗi chu kỳ tốn 24s CPU cho ~5k bạn bè,
 * lên 100 nick thì luồng Node nghẽn. Bạn bè không đổi chỉ được soát đầy đủ 1 lần/ngày.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockZaloOps } from './test-helpers.js';

const zaloOpsMock = mockZaloOps();
const prismaMock = {
  friend: { findMany: vi.fn(), update: vi.fn() },
  contact: { findUnique: vi.fn() },
};
const applyFriendTransitionMock = vi.fn();
const resolveOrCreateContactMock = vi.fn();

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: zaloOpsMock }));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/zalo/friend-event-handler.js', () => ({
  applyFriendTransition: applyFriendTransitionMock,
}));
vi.mock('../src/modules/contacts/resolve-contact.js', () => ({
  resolveOrCreateContact: resolveOrCreateContactMock,
}));
vi.mock('../src/shared/database/safe-contact-write.js', () => ({ safeContactUpdate: vi.fn() }));
vi.mock('../src/modules/activity/activity-logger.js', () => ({ logActivity: vi.fn() }));

const { syncFriendsForAccount } = await import('../src/modules/zalo/friend-sync-service.js');

const LIVE_FRIEND = { userId: 'uid-1', zaloName: 'Anh Tuấn', avatar: 'http://a.png', globalId: 'g1', username: 'tuan' };
const UNCHANGED_ROW = {
  id: 'f1', contactId: 'c1', zaloUidInNick: 'uid-1',
  zaloDisplayName: 'Anh Tuấn', zaloAvatarUrl: 'http://a.png', zaloGlobalId: 'g1', zaloUsername: 'tuan',
  friendshipStatus: 'accepted', relationshipKind: 'friend',
};
const CONTACT_ROW = {
  id: 'c1', fullName: 'Anh Tuấn', gender: 'male', genderLocked: false, birthDate: null,
  phone: null, phone2: null, phone3: null, phonesExtra: [], metadata: {},
};

/** Chạy đồng bộ ở `hours` giờ liên tiếp (phút :07 như cron), trả tổng số bạn bè bị bỏ qua. */
async function runHourly(accountId: string, trigger: 'cron' | 'connect' | 'manual', hours: number): Promise<number> {
  let skipped = 0;
  for (let h = 0; h < hours; h++) {
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 28, h, 7)));
    const r = await syncFriendsForAccount(accountId, 'org-1', { trigger });
    skipped += (r as { skippedUnchanged?: number }).skippedUnchanged ?? NaN;
  }
  return skipped;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.clearAllMocks();
  zaloOpsMock.getAllFriends.mockResolvedValue([LIVE_FRIEND]);
  zaloOpsMock.getSentFriendRequests.mockResolvedValue([]);
  prismaMock.friend.findMany.mockResolvedValue([UNCHANGED_ROW]);
  prismaMock.contact.findUnique.mockResolvedValue(CONTACT_ROW);
  resolveOrCreateContactMock.mockResolvedValue({ id: 'c1', orgId: 'org-1', created: false, matchedVia: 'friend' });
  applyFriendTransitionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('đồng bộ bạn bè — bỏ qua bạn bè không đổi', () => {
  it('cron: bạn bè không đổi chỉ được xử lý đầy đủ 1 lần trong 24 chu kỳ giờ', async () => {
    const skipped = await runHourly('za-cron', 'cron', 24);
    expect(applyFriendTransitionMock).toHaveBeenCalledTimes(1);
    expect(skipped).toBe(23);
  });

  it('connect (nick vừa kết nối lại): cũng bỏ qua bạn bè không đổi', async () => {
    await runHourly('za-connect', 'connect', 24);
    expect(applyFriendTransitionMock).toHaveBeenCalledTimes(1);
  });

  it('manual (bấm "Làm mới ngay"): xử lý mọi bạn bè, kể cả không đổi', async () => {
    await runHourly('za-manual', 'manual', 3);
    expect(applyFriendTransitionMock).toHaveBeenCalledTimes(3);
  });

  it('bạn bè vừa chấp nhận lời mời (pending_sent → accepted) được xử lý ở mọi chu kỳ', async () => {
    prismaMock.friend.findMany.mockResolvedValue([
      { ...UNCHANGED_ROW, friendshipStatus: 'pending_sent', relationshipKind: 'pending_friend' },
    ]);
    await runHourly('za-status', 'cron', 24);
    expect(applyFriendTransitionMock).toHaveBeenCalledTimes(24);
    expect(applyFriendTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({ zaloUidInNick: 'uid-1', newFriendshipStatus: 'accepted' }),
    );
  });

  it('bạn bè đổi tên trên Zalo được xử lý ngay (cập nhật tên)', async () => {
    zaloOpsMock.getAllFriends.mockResolvedValue([{ ...LIVE_FRIEND, zaloName: 'Anh Tuấn MỚI' }]);
    prismaMock.friend.update.mockResolvedValue({ id: 'f1', contactId: 'c1', zaloAccountId: 'za-rename', zaloUidInNick: 'uid-1' });
    await runHourly('za-rename', 'cron', 1);
    expect(prismaMock.friend.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { zaloDisplayName: 'Anh Tuấn MỚI' } }),
    );
  });

  it('bạn bè mới (chưa có trong CRM) được xử lý ngay', async () => {
    prismaMock.friend.findMany.mockResolvedValue([]);
    await runHourly('za-new', 'cron', 1);
    expect(applyFriendTransitionMock).toHaveBeenCalledTimes(1);
  });
});
