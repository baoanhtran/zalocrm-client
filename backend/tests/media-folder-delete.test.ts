/**
 * media-folder-delete.test.ts — Xóa thư mục Kho phương tiện (2026-09-04).
 *
 * IRON RULE (regression CRITICAL): xóa thư mục CHỈ xóa hàng media_albums. Ảnh bên trong
 * KHÔNG được xóa, KHÔNG được đẩy vào thùng rác — FK media_assets.folder_id ON DELETE SET NULL
 * lo phần rơi-về-"Tất cả". Ai sau này "tiện tay" thêm archive/delete ảnh vào route sẽ đỏ test.
 *
 * Cộng: scope chủ sở hữu (sale không xóa thư mục người khác), chặn xóa album "Yêu thích"
 * tự sinh (kind='favorite'), và cổng 409 FOLDER_NOT_EMPTY khi thư mục còn ảnh mà thiếu force.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { mockUser } from './test-helpers.js';

const prismaMock = {
  mediaAlbum: { findFirst: vi.fn(), delete: vi.fn() },
  mediaAsset: { count: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
};
const userHasGrantMock = vi.fn();

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => { req.user = mockUser({ role: 'sale' }); },
}));
// requireGrant: cho qua — bài test này soi phần THÂN route (scope + cái gì bị xóa),
// còn cổng grant đã có test RBAC riêng.
vi.mock('../src/modules/rbac/rbac-middleware.js', () => ({ requireGrant: () => async () => {} }));
vi.mock('../src/modules/rbac/permission-group-service.js', () => ({ userHasGrant: userHasGrantMock }));
// Đống import nặng của media-routes — mock rỗng để nạp được module.
vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: { getInstance: vi.fn() } }));
vi.mock('../src/modules/zalo/zalo-rate-limiter.js', () => ({
  zaloRateLimiter: { checkLimits: vi.fn(), recordSend: vi.fn() },
}));
vi.mock('../src/shared/zalo-operations.js', () => ({ zaloOps: { sendFile: vi.fn() } }));
vi.mock('../src/modules/media/media-service.js', () => ({
  registerAsset: vi.fn(), bumpUsage: vi.fn(), resolveSavedVisibility: vi.fn(),
  generateWatermarkVariant: vi.fn(), disableWatermark: vi.fn(), logMediaUsage: vi.fn(),
  normalizeTags: (t: string[]) => t,
}));
vi.mock('../src/modules/chat/chat-media-helpers.js', () => ({ downloadMediaToTemp: vi.fn() }));
vi.mock('../src/modules/chat/chat-helpers.js', () => ({
  createMediaMessage: vi.fn(), getUserFullName: vi.fn(),
}));
vi.mock('../src/shared/realtime/emit-chat.js', () => ({ emitChatMessage: vi.fn() }));
vi.mock('../src/shared/video-processor.js', () => ({ generateThumbnail: vi.fn(), sendNativeVideo: vi.fn() }));
vi.mock('../src/shared/storage/minio-client.js', () => ({
  uploadBuffer: vi.fn(), getObjectBuffer: vi.fn(), keyFromPublicUrl: vi.fn(),
}));
vi.mock('../src/shared/security/clamav-client.js', () => ({ scanOrPass: vi.fn() }));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mediaRoutes } = await import('../src/modules/media/media-routes.js');

const FOLDER = { id: 'folder-1', name: 'Bảng giá EGV' };

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  userHasGrantMock.mockResolvedValue(false); // mặc định: sale thường, KHÔNG có view_all
  prismaMock.mediaAlbum.findFirst.mockResolvedValue(FOLDER);
  prismaMock.mediaAlbum.delete.mockResolvedValue(FOLDER);
  prismaMock.mediaAsset.count.mockResolvedValue(0);
  app = Fastify();
  await app.register(mediaRoutes);
  await app.ready();
});

/** Không route nào được đụng tới hàng media_assets. */
function expectNoAssetTouched() {
  expect(prismaMock.mediaAsset.delete).not.toHaveBeenCalled();
  expect(prismaMock.mediaAsset.deleteMany).not.toHaveBeenCalled();
  expect(prismaMock.mediaAsset.update).not.toHaveBeenCalled();
  expect(prismaMock.mediaAsset.updateMany).not.toHaveBeenCalled();
}

describe('DELETE /api/v1/media/folders/:id — chỉ xóa thư mục, GIỮ ảnh', () => {
  it('thư mục trống → xóa album, KHÔNG đụng ảnh (IRON RULE)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/media/folders/folder-1' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, releasedAssets: 0 });
    expect(prismaMock.mediaAlbum.delete).toHaveBeenCalledWith({ where: { id: 'folder-1' } });
    expectNoAssetTouched();
  });

  it('thư mục CÒN ảnh + force=true → vẫn chỉ xóa album, ảnh nguyên vẹn (IRON RULE)', async () => {
    prismaMock.mediaAsset.count.mockResolvedValue(12);

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/media/folders/folder-1?force=true' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, releasedAssets: 12 });
    expect(prismaMock.mediaAlbum.delete).toHaveBeenCalledTimes(1);
    expectNoAssetTouched();
  });

  it('thư mục CÒN ảnh mà thiếu force → 409 FOLDER_NOT_EMPTY, KHÔNG xóa gì', async () => {
    prismaMock.mediaAsset.count.mockResolvedValue(3);

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/media/folders/folder-1' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'FOLDER_NOT_EMPTY', assetCount: 3 });
    expect(prismaMock.mediaAlbum.delete).not.toHaveBeenCalled();
    expectNoAssetTouched();
  });

  it('đếm ảnh BỎ QUA thùng rác — con số cảnh báo đúng cái người dùng nhìn thấy', async () => {
    await app.inject({ method: 'DELETE', url: '/api/v1/media/folders/folder-1' });

    expect(prismaMock.mediaAsset.count).toHaveBeenCalledWith({
      where: { folderId: 'folder-1', archivedAt: null },
    });
  });

  it('sale (không view_all) → WHERE khóa ownerUserId + kind=folder: không xóa được thư mục người khác, không xóa được album Yêu thích', async () => {
    await app.inject({ method: 'DELETE', url: '/api/v1/media/folders/folder-1' });

    expect(prismaMock.mediaAlbum.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'folder-1', orgId: 'org-1', kind: 'folder', ownerUserId: 'user-1',
        }),
      }),
    );
  });

  it('admin (view_all) → WHERE bỏ ownerUserId nhưng VẪN khóa kind=folder', async () => {
    userHasGrantMock.mockResolvedValue(true);

    await app.inject({ method: 'DELETE', url: '/api/v1/media/folders/folder-1' });

    const where = prismaMock.mediaAlbum.findFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('ownerUserId');
    expect(where.kind).toBe('folder');
  });

  it('không tìm thấy (thư mục người khác / album Yêu thích) → 404, KHÔNG xóa gì', async () => {
    prismaMock.mediaAlbum.findFirst.mockResolvedValue(null);

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/media/folders/folder-1?force=true' });

    expect(res.statusCode).toBe(404);
    expect(prismaMock.mediaAlbum.delete).not.toHaveBeenCalled();
    expectNoAssetTouched();
  });
});
