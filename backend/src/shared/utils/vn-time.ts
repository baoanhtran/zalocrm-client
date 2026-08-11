// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * vn-time.ts — Mốc "hôm nay" / "đầu tháng" theo giờ VN (UTC+7), trả về Date UTC để
 * so trực tiếp với cột timestamp trong DB.
 *
 * BUG 2026-08-11 (org BMA) — vì sao phải có file này:
 *   Helper cũ (nhân bản trong dashboard-routes + dashboard-action-hub-routes) dựng mốc
 *   bằng `new Date(y, m, d)`. Constructor này diễn giải tham số theo TZ ĐỊA PHƯƠNG của
 *   tiến trình. Container app chạy TZ=Asia/Ho_Chi_Minh nên nó đã trả 00:00 giờ VN —
 *   rồi code TRỪ TIẾP 7h nữa. Kết quả: "hôm nay" bắt đầu lúc 17:00 chiều hôm trước.
 *   Chỉ đúng khi TZ tiến trình là UTC.
 *
 * Cách làm đúng: chỉ dùng getUTC* + Date.UTC → kết quả độc lập hoàn toàn với TZ máy
 * chủ. VN không có DST nên offset +7 là hằng số, không cần thư viện timezone.
 */

/** Lệch giờ VN so với UTC. Cố định — VN không đổi giờ theo mùa. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Cửa sổ [today, tomorrow) của NGÀY VN chứa `now`, biểu diễn bằng mốc UTC.
 * Dùng cho các KPI "hôm nay": tin đã gửi, KH phản hồi, bạn mới, lead mới, hẹn hôm nay.
 */
export function vnDayRange(now: Date = new Date()): { today: Date; tomorrow: Date } {
  const vnNow = new Date(now.getTime() + VN_OFFSET_MS);
  const vnMidnightAsUtc = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), vnNow.getUTCDate());
  const today = new Date(vnMidnightAsUtc - VN_OFFSET_MS);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  return { today, tomorrow };
}

/** Mốc 00:00 VN ngày 1 của THÁNG VN chứa `now`. Dùng cho KPI "chốt tháng". */
export function vnMonthStart(now: Date = new Date()): Date {
  const vnNow = new Date(now.getTime() + VN_OFFSET_MS);
  const vnMonthStartAsUtc = Date.UTC(vnNow.getUTCFullYear(), vnNow.getUTCMonth(), 1);
  return new Date(vnMonthStartAsUtc - VN_OFFSET_MS);
}
