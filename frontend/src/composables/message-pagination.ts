// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * message-pagination.ts — tải tin nhắn cũ trong khung chat (2026-09-20).
 *
 * Gốc bug: khung chat chỉ gọi /messages ĐÚNG MỘT LẦN với limit=100 và không bao
 * giờ gửi trang tiếp theo. Hội thoại nhiều tin (50 hội thoại đang > 100 tin, cá
 * biệt 3.764 tin) bị cắt cụt: sale mở ra chỉ thấy vài giờ cuối, tin cũ hơn KHÔNG
 * có đường nào chạm tới. Backend đã hỗ trợ phân trang sẵn — chỉ thiếu phía FE.
 *
 * Tách ra file riêng để test được thuần tuý (không cần mock HTTP/Vue).
 */

/**
 * Vị trí bắt đầu của trang cũ kế tiếp = SỐ TIN ĐÃ TẢI (không phải số trang).
 *
 * Vì sao không dùng `page`: danh sách sắp xếp mới-nhất-trước, nên mỗi tin mới đến
 * trong lúc sale đang đọc sẽ đẩy cả cửa sổ xuống 1 nấc. Đếm theo trang thì nấc
 * lệch đó làm NHẢY CÓC mất tin. Đếm theo số tin đã tải thì trường hợp xấu nhất chỉ
 * là lấy chồng lên vài tin đã có — `mergeOlderMessages` loại trùng, không mất gì.
 */
export function olderPageOffset(loadedCount: number): number {
  if (!Number.isFinite(loadedCount) || loadedCount < 0) return 0;
  return Math.floor(loadedCount);
}

/** Cuộn gần đỉnh khung chat bao nhiêu px thì bắt đầu tải tin cũ. */
export const OLDER_SCROLL_THRESHOLD_PX = 160;

export function shouldLoadOlder(opts: {
  scrollTop: number;
  hasMore: boolean;
  loading: boolean;
  threshold?: number;
}): boolean {
  if (!opts.hasMore || opts.loading) return false;
  return opts.scrollTop <= (opts.threshold ?? OLDER_SCROLL_THRESHOLD_PX);
}

/**
 * Ghép trang tin cũ vào danh sách đang hiển thị: loại trùng theo `id`, sắp lại theo
 * `compare` (dùng chung comparator với luồng socket để thứ tự nhất quán).
 *
 * Trả về CHÍNH mảng cũ khi không có tin nào mới — giữ reference để Vue khỏi
 * re-render cả thread và để watcher `messages.length` không nổ vô ích.
 */
export function mergeOlderMessages<T extends { id: string }>(
  existing: T[],
  older: T[],
  compare: (a: T, b: T) => number,
): T[] {
  if (!older.length) return existing;
  const have = new Set(existing.map((m) => m.id));
  const fresh = older.filter((m) => !have.has(m.id));
  if (!fresh.length) return existing;
  return [...fresh, ...existing].sort(compare);
}
