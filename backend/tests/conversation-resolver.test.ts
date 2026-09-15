/**
 * conversation-resolver.test.ts — chat nội bộ (isVirtual) không bao giờ được coi là hội thoại Zalo.
 *
 * Bước 3 (theo contactId) từng trả cả hội thoại ảo `virtual:<contact>:<nick>` → tin Zalo thật của
 * KH rơi vào chat nội bộ, và "Tìm Zalo" gắn KH xong lại mở đúng chat nội bộ thay vì chat Zalo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ convs: [] as any[], friends: [] as any[] }));

function matches(row: Record<string, unknown>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).includes(row[k]);
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
    return row[k] === v;
  });
}

vi.mock('../src/shared/database/prisma-client.js', () => ({
  prisma: {
    conversation: {
      findFirst: vi.fn(async ({ where }: any) => db.convs.find((r) => matches(r, where)) ?? null),
    },
    friend: {
      findFirst: vi.fn(async ({ where }: any) => db.friends.find((r) => matches(r, where)) ?? null),
      findMany: vi.fn(async ({ where }: any) => db.friends.filter((r) => matches(r, where))),
    },
  },
}));

const { findExistingUserConversation } = await import('../src/modules/chat/conversation-resolver.js');

const virtualConv = {
  id: 'conv-virtual', zaloAccountId: 'nick-1', contactId: 'c-1', threadType: 'user',
  externalThreadId: 'virtual:c-1:nick-1', isVirtual: true,
};
const realConv = {
  id: 'conv-real', zaloAccountId: 'nick-1', contactId: 'c-1', threadType: 'user',
  externalThreadId: 'uid-old', isVirtual: false,
};

beforeEach(() => {
  db.convs = [];
  db.friends = [];
});

describe('findExistingUserConversation — bỏ qua chat nội bộ', () => {
  it('KH chỉ có chat nội bộ trên nick → tin Zalo đầu tiên KHÔNG gộp vào chat nội bộ', async () => {
    db.convs = [virtualConv];
    const id = await findExistingUserConversation({
      orgId: 'org-1', nickId: 'nick-1', externalThreadId: 'uid-new', contactId: 'c-1',
    });
    expect(id).toBeNull();
  });

  it('KH có cả chat nội bộ lẫn chat Zalo → trả chat Zalo', async () => {
    db.convs = [virtualConv, realConv];
    const id = await findExistingUserConversation({
      orgId: 'org-1', nickId: 'nick-1', externalThreadId: 'uid-new', contactId: 'c-1',
    });
    expect(id).toBe('conv-real');
  });

  it('khớp đúng UID vẫn trả hội thoại đó như cũ', async () => {
    db.convs = [realConv];
    const id = await findExistingUserConversation({
      orgId: 'org-1', nickId: 'nick-1', externalThreadId: 'uid-old', contactId: null,
    });
    expect(id).toBe('conv-real');
  });
});
