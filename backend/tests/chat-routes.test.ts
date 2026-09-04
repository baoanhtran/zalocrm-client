/**
 * chat-routes.test.ts — Integration tests for conversation message send flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mockUser, mockPrisma, mockIO } from './test-helpers.js';

const prismaMock = mockPrisma();
const sendMessageMock = vi.fn().mockResolvedValue({ msgId: 'zalo-msg-2' });
const zaloPoolMock = {
  getInstance: vi.fn(),
};


const zaloRateLimiterMock = {
  checkLimits: vi.fn(),
  recordSend: vi.fn(),
};

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => { req.user = mockUser(); },
}));
vi.mock('../src/modules/zalo/zalo-access-middleware.js', () => ({
  requireZaloAccess: () => async () => {},
}));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: zaloPoolMock }));
vi.mock('../src/modules/zalo/zalo-rate-limiter.js', () => ({ zaloRateLimiter: zaloRateLimiterMock }));

const { chatRoutes } = await import('../src/modules/chat/chat-routes.js');

const CONV = {
  id: 'conv-1',
  orgId: 'org-1',
  threadType: 'user',
  externalThreadId: 'ext-1',
  zaloAccountId: 'za-1',
  zaloAccount: { id: 'za-1', zaloUid: 'own-1' },
};

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate('io', mockIO());
  app.register(chatRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.conversation.findFirst.mockResolvedValue(CONV);
  prismaMock.message.findFirst.mockResolvedValue({
    id: 'reply-1',
    zaloMsgId: 'zalo-reply-1',
    senderUid: 'contact-1',
    content: 'hello',
    contentType: 'text',
    sentAt: new Date('2026-04-17T10:00:00.000Z'),
  });
  prismaMock.message.create.mockResolvedValue({ id: 'msg-2', content: 'thanks' });
  prismaMock.user.findUnique.mockResolvedValue({ fullName: 'Sale A', email: 'sale@example.com' });
  prismaMock.conversation.update.mockResolvedValue({});
  zaloPoolMock.getInstance.mockReturnValue({
    api: {
      sendMessage: sendMessageMock,
    },
  });
  zaloRateLimiterMock.checkLimits.mockResolvedValue({ allowed: true });
  zaloRateLimiterMock.recordSend.mockReturnValue(undefined);
});

describe('POST /api/v1/conversations/:id/messages', () => {
  it('sends a reply quote when replyMessageId is provided', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/conv-1/messages',
      payload: { content: 'thanks', replyMessageId: 'reply-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'thanks',
        quote: expect.objectContaining({
          msgId: 'zalo-reply-1',
          cliMsgId: 'zalo-reply-1',
          uidFrom: 'contact-1',
          propertyExt: {},
        }),
      }),
      'ext-1',
      0,
    );
    expect(prismaMock.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ quote: expect.objectContaining({ msgId: 'zalo-reply-1' }) }),
    }));
  });

  // Bug 2026-09-04: sale gõ tin trên web → Zalo NHẬN được, nhưng listener echo chèn row
  // trước khi route kịp create → P2002 unique (conversation_id, zalo_msg_id) → route ném
  // → 500 "Không gửi được tin nhắn" DÙ tin đã tới khách. Sale gửi lại → khách nhận trùng.
  // Nhánh cứu P2002 cũ chỉ chạy khi có echoId (app mobile), web không gửi field này.
  it('returns the row the listener already saved when zaloMsgId hits P2002 without echoId', async () => {
    // zca-js trả { message: { msgId } } — route đọc shape này để lấy zaloMsgId.
    sendMessageMock.mockResolvedValue({ message: { msgId: 'zalo-msg-2' } });
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prismaMock.message.create.mockRejectedValue(p2002);
    prismaMock.message.findUnique.mockResolvedValue({
      id: 'msg-from-echo',
      content: 'thanks',
      zaloMsgId: 'zalo-msg-2',
      zaloMsgIdNum: null,
    });

    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/conv-1/messages',
      payload: { content: 'thanks' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ id: 'msg-from-echo' }));
    expect(prismaMock.message.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { conversationId_zaloMsgId: { conversationId: 'conv-1', zaloMsgId: 'zalo-msg-2' } },
    }));
  });
});
