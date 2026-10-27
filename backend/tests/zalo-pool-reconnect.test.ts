/**
 * zalo-pool-reconnect.test.ts — zaloPool.reconnect():
 *  - Giãn cách đăng nhập: khởi động app với nhiều nick, trước đây mọi nick login cùng 1 giây
 *    từ 1 IP (dễ bị Zalo chặn tạm, CPU/RAM vọt).
 *  - Proxy: boot / health-check / zalo-operations gọi reconnect KHÔNG truyền proxy → nick có
 *    proxy vẫn phải đi qua proxy lưu trong DB.
 *  - "Ngắt là ngắt thật": sale ngắt thủ công lúc nick đang chờ lượt → không login lại.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type AccountRow = {
  id: string; orgId: string; zaloUid: string | null; archivedAt: Date | null;
  disconnectReason: string | null; proxyUrl: string | null;
};
const accounts = new Map<string, AccountRow>();
const logins: Array<{ accountId: string; at: number }> = [];

const createZaloClientMock = vi.fn((_proxyUrl?: string | null) => ({
  login: vi.fn(async (cred: { imei: string }) => {
    logins.push({ accountId: cred.imei, at: Date.now() });
    return {
      getOwnId: async () => accounts.get(cred.imei)!.zaloUid,
      getUserInfo: async () => ({}),
      listener: { stop: vi.fn() },
    };
  }),
}));

// Các bảng ngoài zalo_accounts: trả rỗng (luồng phụ fire-and-forget sau khi login).
function permissiveModel() {
  return new Proxy({}, {
    get: (_t, method) => vi.fn(async () => (method === 'findMany' ? [] : method === 'updateMany' ? { count: 0 } : null)),
  });
}
const prismaMock = new Proxy({
  zaloAccount: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => accounts.get(where.id) ?? null),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async ({ where }: { where: { id: string } }) => ({ orgId: accounts.get(where.id)?.orgId, ownerUserId: 'u1' })),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
} as Record<string | symbol, unknown>, {
  get: (t, model) => (model in t ? t[model] : permissiveModel()),
});

vi.mock('@prisma/client', () => ({ Prisma: { JsonNull: null } }));
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/shared/tenant/tenant-context.js', () => ({
  runSystemQuery: (fn: () => unknown) => fn(),
  withTenant: (_orgId: string, fn: () => unknown) => fn(),
}));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/modules/zalo/zalo-client-factory.js', () => ({ createZaloClient: createZaloClientMock }));
vi.mock('../src/modules/zalo/zalo-listener-factory.js', () => ({ attachZaloListener: vi.fn() }));
vi.mock('../src/modules/api/webhook-service.js', () => ({ emitWebhook: vi.fn() }));
vi.mock('../src/modules/zalo/zalo-message-sync.js', () => ({ startMessageSync: vi.fn(), stopMessageSync: vi.fn() }));
vi.mock('../src/modules/zalo/zalo-history-backfill.js', () => ({ backfillIfEmpty: vi.fn(async () => {}) }));
vi.mock('../src/modules/zalo/status-log-service.js', () => ({ writeTransition: vi.fn(async () => {}) }));
vi.mock('../src/modules/zalo/friend-sync-service.js', () => ({
  syncAccountFully: vi.fn(async () => ({ friends: null, aliasesUpdated: 0, labelsUpdated: 0, errors: [] })),
}));
vi.mock('../src/shared/ee-registry/automation.js', () => ({ respawnNickWorkerIfActive: vi.fn(async () => {}) }));

const { zaloPool } = await import('../src/modules/zalo/zalo-pool.js');

function addAccount(id: string, extra: Partial<AccountRow> = {}): void {
  accounts.set(id, { id, orgId: 'org-1', zaloUid: `uid-${id}`, archivedAt: null, disconnectReason: null, proxyUrl: null, ...extra });
}
const session = (id: string) => ({ cookie: [], imei: id, userAgent: 'ua' });

let hourOffset = 0;
beforeEach(() => {
  vi.useFakeTimers();
  // Mỗi test cách nhau 1 giờ → lượt đăng nhập của test trước không dồn sang test sau.
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 28) + hourOffset++ * 3_600_000));
  logins.length = 0;
  createZaloClientMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('zaloPool.reconnect — giãn cách đăng nhập', () => {
  it('3 nick khởi động cùng lúc → đăng nhập lần lượt cách nhau 3 giây', async () => {
    for (const id of ['a1', 'a2', 'a3']) addAccount(id);
    const t0 = Date.now();
    const all = Promise.all(['a1', 'a2', 'a3'].map((id) => zaloPool.reconnect(id, session(id))));
    await vi.runAllTimersAsync();
    await all;
    expect(logins.map((l) => [l.accountId, l.at - t0])).toEqual([['a1', 0], ['a2', 3000], ['a3', 6000]]);
  });

  it('sale bấm Ngắt lúc nick đang chờ lượt → nick đó không đăng nhập lại', async () => {
    addAccount('m1');
    addAccount('m2');
    const first = zaloPool.reconnect('m1', session('m1'));
    const second = zaloPool.reconnect('m2', session('m2'));
    await vi.advanceTimersByTimeAsync(1000);
    accounts.get('m2')!.disconnectReason = 'manual';
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(logins.map((l) => l.accountId)).toEqual(['m1']);
  });
});

describe('zaloPool.reconnect — không kẹt cờ chống chạy trùng', () => {
  it('nick bị disconnect (không phải Ngắt tay) lúc đang chờ lượt → vẫn đăng nhập lại được', async () => {
    addAccount('x0');
    addAccount('x1');
    const warmup = zaloPool.reconnect('x1', session('x1'));
    await vi.runAllTimersAsync();
    await warmup;

    const first = zaloPool.reconnect('x0', session('x0'));
    const queued = zaloPool.reconnect('x1', session('x1'));
    await vi.advanceTimersByTimeAsync(1000);
    zaloPool.disconnect('x1'); // vd cron làm mới phiên 4h sáng: disconnect rồi mới reconnect
    await vi.runAllTimersAsync();
    await Promise.all([first, queued]);

    expect(logins.filter((l) => l.accountId === 'x1')).toHaveLength(2);
  });
});

describe('zaloPool.reconnect — proxy của nick', () => {
  it('gọi reconnect không kèm proxy (boot/health-check) vẫn dùng proxy lưu trong DB', async () => {
    addAccount('p1', { proxyUrl: 'http://user:pass@10.0.0.9:8080' });
    const done = zaloPool.reconnect('p1', session('p1'));
    await vi.runAllTimersAsync();
    await done;
    expect(createZaloClientMock).toHaveBeenCalledWith('http://user:pass@10.0.0.9:8080');
    expect(logins.map((l) => l.accountId)).toEqual(['p1']);
  });
});
