/**
 * zalo-labels-skip-unchanged.test.ts — đồng bộ nhãn Zalo (full sync, chạy theo cron bạn bè)
 * KHÔNG ghi lại + KHÔNG bắn 'friend:updated' cho bạn bè có nhãn không đổi.
 * Trước đây mỗi chu kỳ ghi đè MỌI bạn bè + bắn 1 socket event/bạn bè tới mọi trình duyệt
 * (BMA ~5k event mỗi 15 phút).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const LABEL_ROW = {
  zaloAccountId: 'za-1', zaloLabelId: 1, text: 'VIP', textKey: '', color: '#f00', emoji: null,
  offset: 0, conversations: ['uid-1'],
};
const getLabelsMock = vi.fn();
const ioEmitMock = vi.fn();
const txMock = {
  zaloLabel: { deleteMany: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
};
const prismaMock = {
  friend: { findMany: vi.fn(), update: vi.fn() },
  zaloAccount: { findUnique: vi.fn() },
  crmTagGroup: { findUnique: vi.fn(), update: vi.fn() },
  crmTag: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  tag: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  friendTag: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
};

vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: prismaMock,
  tenantTransaction: (fn: (tx: typeof txMock) => unknown) => fn(txMock),
}));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({
  zaloPool: { getApi: () => ({ getLabels: getLabelsMock }) },
}));
vi.mock('../src/shared/event-buffer.js', () => ({
  getIo: () => ({ to: () => ({ emit: ioEmitMock }) }),
}));
vi.mock('../src/modules/zalo/alias-sync.js', () => ({
  syncAliasesForAccount: vi.fn().mockResolvedValue({ updated: 0, pulled: 0 }),
}));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({ authMiddleware: vi.fn() }));
vi.mock('../src/modules/zalo/zalo-scope.js', () => ({
  getZaloScope: vi.fn(), requireAccountManagement: vi.fn(), requireAccountVisible: vi.fn(), requireAccountChat: vi.fn(),
}));
vi.mock('../src/modules/activity/activity-logger.js', () => ({ logActivity: vi.fn() }));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { syncLabelsForAccount } = await import('../src/modules/zalo/zalo-labels-routes.js');

function friendRow(zaloLabels: unknown[], crmTagsPerNick: string[]) {
  return { id: 'f1', zaloUidInNick: 'uid-1', contactId: 'c1', zaloLabels, crmTagsPerNick };
}

beforeEach(() => {
  vi.clearAllMocks();
  getLabelsMock.mockResolvedValue({
    labelData: [{ id: 1, text: 'VIP', textKey: '', color: '#f00', emoji: '', offset: 0, conversations: ['uid-1'] }],
    version: 3,
  });
  txMock.zaloLabel.findMany.mockResolvedValue([LABEL_ROW]);
  prismaMock.zaloAccount.findUnique.mockResolvedValue({ displayName: 'Nick', phone: null });
  prismaMock.crmTagGroup.findUnique.mockResolvedValue({ id: 'g1', name: 'Zalo - Nick' });
  prismaMock.crmTag.findUnique.mockResolvedValue({ id: 't1' });
  prismaMock.tag.findFirst.mockResolvedValue({ id: 'tag1', name: 'VIP', color: '#f00', emoji: null, archivedAt: null });
});

describe('syncLabelsForAccount (full) — chỉ ghi bạn bè có nhãn đổi', () => {
  it('bạn bè giữ nguyên nhãn → không ghi DB, không bắn socket', async () => {
    const row = friendRow([{ id: 1, name: 'VIP', color: '#f00', emoji: null }], ['Khách cũ', '🔵 VIP']);
    prismaMock.friend.findMany.mockResolvedValue([row]);
    const res = await syncLabelsForAccount('za-1', 'org-1');
    expect(prismaMock.friend.update).not.toHaveBeenCalled();
    expect(ioEmitMock).not.toHaveBeenCalled();
    expect(res.friendsUpdated).toBe(0);
  });

  it('bạn bè vừa được gắn nhãn trên Zalo → ghi nhãn + tag mirror và bắn socket', async () => {
    const row = friendRow([], ['Khách cũ']);
    prismaMock.friend.findMany.mockResolvedValue([row]);
    const res = await syncLabelsForAccount('za-1', 'org-1');
    expect(prismaMock.friend.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'f1' },
      data: expect.objectContaining({
        zaloLabels: [{ id: 1, name: 'VIP', color: '#f00', emoji: null }],
        crmTagsPerNick: ['Khách cũ', '🔵 VIP'],
      }),
    }));
    expect(ioEmitMock).toHaveBeenCalledTimes(1);
    expect(res.friendsUpdated).toBe(1);
  });

  it('Zalo trả nhãn theo thứ tự khác lần trước → coi như không đổi, không ghi', async () => {
    const LABEL_2 = { ...LABEL_ROW, zaloLabelId: 2, text: 'Mới', color: '#00f' };
    getLabelsMock.mockResolvedValue({
      labelData: [
        { id: 1, text: 'VIP', textKey: '', color: '#f00', emoji: '', offset: 0, conversations: ['uid-1'] },
        { id: 2, text: 'Mới', textKey: '', color: '#00f', emoji: '', offset: 0, conversations: ['uid-1'] },
      ],
      version: 3,
    });
    txMock.zaloLabel.findMany.mockResolvedValue([LABEL_ROW, LABEL_2]);
    const row = friendRow(
      [{ id: 2, name: 'Mới', color: '#00f', emoji: null }, { id: 1, name: 'VIP', color: '#f00', emoji: null }],
      ['🔵 Mới', '🔵 VIP'],
    );
    prismaMock.friend.findMany.mockResolvedValue([row]);
    await syncLabelsForAccount('za-1', 'org-1');
    expect(prismaMock.friend.update).not.toHaveBeenCalled();
  });

  it('nhãn đổi màu trên Zalo → ghi lại', async () => {
    const row = friendRow([{ id: 1, name: 'VIP', color: '#0f0', emoji: null }], ['🔵 VIP']);
    prismaMock.friend.findMany.mockResolvedValue([row]);
    await syncLabelsForAccount('za-1', 'org-1');
    expect(prismaMock.friend.update).toHaveBeenCalledTimes(1);
  });

  it('dữ liệu cũ thiếu tag mirror "🔵 VIP" → ghi lại để bù mirror', async () => {
    const row = friendRow([{ id: 1, name: 'VIP', color: '#f00', emoji: null }], ['Khách cũ']);
    prismaMock.friend.findMany.mockResolvedValue([row]);
    await syncLabelsForAccount('za-1', 'org-1');
    expect(prismaMock.friend.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ crmTagsPerNick: ['Khách cũ', '🔵 VIP'] }),
    }));
  });
});
