/**
 * chat-attachment-routes.test.ts — Gửi đính kèm kèm caption qua ô soạn chat.
 *
 * Bug 2026-09-04: FE mới gộp chữ + đính kèm vào 1 request (`caption`). Route cũ nhét
 * caption vào CẢ 3 nhánh gửi (batch ảnh / mỗi video / mỗi file) → chọn hỗn hợp
 * ảnh + file thì khách nhận caption LẶP nhiều lần. Caption chỉ được đi đúng 1 lần.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { mockUser, mockPrisma, mockIO } from './test-helpers.js';

const prismaMock = mockPrisma();
const sendMessageMock = vi.fn().mockResolvedValue({ message: { msgId: 'zalo-img-1' } });
const sendFileMock = vi.fn().mockResolvedValue({ message: { msgId: 'zalo-file-1' } });
const zaloPoolMock = { getInstance: vi.fn() };
const zaloRateLimiterMock = { checkLimits: vi.fn(), recordSend: vi.fn() };

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => { req.user = mockUser(); },
}));
vi.mock('../src/modules/zalo/zalo-access-middleware.js', () => ({
  requireZaloAccess: () => async () => {},
}));
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: zaloPoolMock }));
vi.mock('../src/modules/zalo/zalo-rate-limiter.js', () => ({ zaloRateLimiter: zaloRateLimiterMock }));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { sendFile: sendFileMock } }));
vi.mock('../src/shared/storage/minio-client.js', () => ({
  uploadBuffer: vi.fn(async (_buf: Buffer, mime: string, name: string) => ({
    url: `https://cdn.test/${name}`, size: 10, mimeType: mime,
  })),
}));
vi.mock('../src/modules/media/media-service.js', () => ({
  compressImage: vi.fn(async (buffer: Buffer, mimeType: string) => ({ buffer, mimeType })),
}));
vi.mock('../src/shared/video-processor.js', () => ({
  generateThumbnail: vi.fn(), sendNativeVideo: vi.fn(),
}));
vi.mock('../src/shared/realtime/emit-chat.js', () => ({ emitChatMessage: vi.fn() }));
vi.mock('../src/modules/chat/chat-helpers.js', async (importOriginal) => ({
  // buildReplyQuote là hàm thuần → dùng bản THẬT để test bắt được lỗi dựng quote.
  ...(await importOriginal<typeof import('../src/modules/chat/chat-helpers.js')>()),
  getUserFullName: vi.fn(async () => 'Sale A'),
  createMediaMessage: vi.fn(async (input: any) => ({ id: `msg-${input.contentType}`, ...input })),
}));

const { chatAttachmentRoutes } = await import('../src/modules/chat/chat-attachment-routes.js');

const CONV = {
  id: 'conv-1',
  orgId: 'org-1',
  threadType: 'user',
  externalThreadId: 'ext-1',
  zaloAccountId: 'za-1',
  zaloAccount: { id: 'za-1', zaloUid: 'own-1', archivedAt: null, privacyMode: 'off', ownerUserId: 'user-1' },
};

const BOUNDARY = '----zalocrmtest';

/** Dựng body multipart: field caption (+ replyMessageId nếu có) + N file. */
function multipartBody(
  caption: string,
  files: Array<{ name: string; type: string; data: string }>,
  replyMessageId?: string,
): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`,
  ));
  if (replyMessageId) {
    parts.push(Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="replyMessageId"\r\n\r\n${replyMessageId}\r\n`,
    ));
  }
  for (const f of files) {
    parts.push(Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\n` +
      `Content-Type: ${f.type}\r\n\r\n${f.data}\r\n`,
    ));
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(parts);
}

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate('io', mockIO());
  app.register(fastifyMultipart);
  app.register(chatAttachmentRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.conversation.findFirst.mockResolvedValue(CONV);
  prismaMock.conversation.update.mockResolvedValue({});
  zaloPoolMock.getInstance.mockReturnValue({ api: { sendMessage: sendMessageMock } });
  zaloRateLimiterMock.checkLimits.mockResolvedValue({ allowed: true });
  sendMessageMock.mockResolvedValue({ message: { msgId: 'zalo-img-1' } });
  sendFileMock.mockResolvedValue({ message: { msgId: 'zalo-file-1' } });
});

describe('POST /api/v1/conversations/:id/attachments', () => {
  it('gửi caption kèm ảnh trong cùng một tin Zalo', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/conv-1/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody('bảng giá tháng 9', [{ name: 'a.png', type: 'image/png', data: 'PNGDATA' }]),
    });

    expect(res.statusCode).toBe(200);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'bảng giá tháng 9' }),
      'ext-1',
      0,
    );
  });

  it('không lặp caption khi gửi cùng lúc ảnh và file', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/conv-1/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody('bảng giá tháng 9', [
        { name: 'a.png', type: 'image/png', data: 'PNGDATA' },
        { name: 'b.pdf', type: 'application/pdf', data: 'PDFDATA' },
      ]),
    });

    expect(res.statusCode).toBe(200);
    // Ảnh đi trước → nhận caption.
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'bảng giá tháng 9' }),
      'ext-1',
      0,
    );
    // File đi sau → KHÔNG được mang caption nữa (tham số cuối của zaloOps.sendFile).
    expect(sendFileMock).toHaveBeenCalledTimes(1);
    expect(sendFileMock.mock.calls[0][5]).toBe('');
  });

  // Bug 2026-09-04: đính ảnh khi đang Reply thì trạng thái trả lời bị nuốt mất im lặng —
  // khách nhận ảnh trơ không rõ đang nói về tin nào. Route phải chuyển quote sang Zalo.
  // (zca-js KHÔNG gắn được quote vào chính tin ảnh nên nó gửi chữ-có-quote riêng rồi mới
  // tới ảnh — giới hạn thư viện, nhưng ngữ cảnh trả lời được giữ.)
  it('chuyển quote sang Zalo khi gửi đính kèm lúc đang trả lời tin', async () => {
    prismaMock.message.findFirst.mockResolvedValue({
      zaloMsgId: 'zalo-reply-1',
      senderUid: 'contact-1',
      content: 'cái này bao nhiêu ạ',
      contentType: 'text',
      sentAt: new Date('2026-09-04T03:00:00.000Z'),
    });

    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/conv-1/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody('2 triệu anh nhé', [{ name: 'a.png', type: 'image/png', data: 'PNGDATA' }], 'reply-1'),
    });

    expect(res.statusCode).toBe(200);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: '2 triệu anh nhé',
        quote: expect.objectContaining({ msgId: 'zalo-reply-1', uidFrom: 'contact-1', msgType: 'webchat' }),
      }),
      'ext-1',
      0,
    );
  });

  it('không gắn quote khi không phải đang trả lời', async () => {
    const app = buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/conv-1/attachments',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody('', [{ name: 'a.png', type: 'image/png', data: 'PNGDATA' }]),
    });

    expect(sendMessageMock.mock.calls[0][0]).not.toHaveProperty('quote');
  });
});
