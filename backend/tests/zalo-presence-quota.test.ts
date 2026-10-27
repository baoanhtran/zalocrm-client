/**
 * zalo-presence-quota.test.ts — cron trạng thái online KHÔNG được ăn quota friend_read.
 * Đo VPS BMA 2026-10-28: cron online gọi getFriendOnlines mỗi phút × mỗi nick, trừ vào
 * friend_read (500/ngày) → cạn sau ~8 giờ → đồng bộ bạn bè (getSentFriendRequests cũng là
 * friend_read) lỗi "Đã đạt giới hạn 500 friend_read/ngày" tới hết ngày (164 lần/ngày).
 * Dùng bộ giới hạn thật (chế độ không Redis), mỗi nhóm quota 3 lượt/ngày để chạm trần nhanh.
 */
import { describe, it, expect, vi } from 'vitest';

const fakeApi = {
  getFriendOnlines: vi.fn(async () => ({ onlines: [] })),
  getSentFriendRequest: vi.fn(async () => ({})),
};

vi.mock('../src/modules/zalo/zalo-pool.js', () => ({
  zaloPool: { getInstance: () => ({ api: fakeApi, status: 'connected' }) },
}));
vi.mock('../src/shared/redis-client.js', () => ({ getRedis: async () => null }));
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: {} }));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/zalo/sdk-limit-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/zalo/sdk-limit-service.js')>()),
  getEffectiveLimit: async () => ({ daily: 3, burst: 100, burstWindowMs: 30_000 }),
}));

const { zaloOps } = await import('../src/shared/zalo-operations.js');

describe('quota của cron trạng thái online', () => {
  it('cron online chạm trần vẫn để nguyên quota friend_read cho đồng bộ bạn bè', async () => {
    for (let i = 0; i < 3; i++) await zaloOps.getFriendOnlines('nick-1');
    await expect(zaloOps.getSentFriendRequests('nick-1')).resolves.toBeDefined();
  });

  it('cron online vẫn có trần riêng của nó (không gọi Zalo vô hạn)', async () => {
    for (let i = 0; i < 3; i++) await zaloOps.getFriendOnlines('nick-2');
    await expect(zaloOps.getFriendOnlines('nick-2')).rejects.toThrow(/giới hạn 3 presence\/ngày/);
  });
});
