/**
 * vn-time.test.ts — Hồi quy: mốc "hôm nay" / "đầu tháng" theo giờ VN phải ĐÚNG trên
 * mọi TZ của máy chủ.
 *
 * Sự cố 2026-08-11 (org BMA, container app chạy TZ=Asia/Ho_Chi_Minh): helper cũ dựng
 * mốc bằng `new Date(y, m, d)` — hàm này đã sinh 00:00 theo giờ ĐỊA PHƯƠNG (tức đã là
 * giờ VN trên container) — rồi TRỪ TIẾP 7h. Kết quả: "hôm nay" bắt đầu lúc 17:00 chiều
 * hôm trước. Mọi KPI theo ngày (Hẹn hôm nay, Tin đã gửi, Bạn mới, Lead mới, Quota nick)
 * và theo tháng (Chốt tháng) đều lệch.
 *
 * Bất biến khoá: kết quả CHỈ phụ thuộc `now`, không phụ thuộc TZ tiến trình.
 */
import { describe, it, expect } from 'vitest';
import { vnDayRange, vnMonthStart } from '../src/shared/utils/vn-time.js';

describe('vn-time — mốc ngày/tháng theo giờ VN (UTC+7)', () => {
  it('03:29 sáng 12/8 giờ VN → ngày VN bắt đầu 00:00 12/8 (= 17:00Z ngày 11/8)', () => {
    const now = new Date('2026-08-11T20:29:28.269Z'); // 03:29 ngày 12/8 giờ VN
    const { today, tomorrow } = vnDayRange(now);

    expect(today.toISOString()).toBe('2026-08-11T17:00:00.000Z');
    expect(tomorrow.toISOString()).toBe('2026-08-12T17:00:00.000Z');
  });

  it('20:00 tối 11/8 giờ VN VẪN thuộc ngày 11/8 — ngày không nhảy sớm lúc 17:00', () => {
    const now = new Date('2026-08-11T13:00:00.000Z'); // 20:00 ngày 11/8 giờ VN
    const { today, tomorrow } = vnDayRange(now);

    expect(today.toISOString()).toBe('2026-08-10T17:00:00.000Z');
    expect(tomorrow.toISOString()).toBe('2026-08-11T17:00:00.000Z');
    // Tin nhắn gửi lúc này PHẢI lọt vào cửa sổ "hôm nay".
    expect(now >= today && now < tomorrow).toBe(true);
  });

  it('00:05 sáng giờ VN vẫn thuộc ngày mới, không rơi về ngày hôm trước', () => {
    const now = new Date('2026-08-11T17:05:00.000Z'); // 00:05 ngày 12/8 giờ VN
    const { today, tomorrow } = vnDayRange(now);

    expect(today.toISOString()).toBe('2026-08-11T17:00:00.000Z');
    expect(now >= today && now < tomorrow).toBe(true);
  });

  it('vnMonthStart: 00:00 VN ngày 1 của tháng VN đang xét', () => {
    const now = new Date('2026-08-11T20:29:28.269Z'); // 12/8 giờ VN
    expect(vnMonthStart(now).toISOString()).toBe('2026-07-31T17:00:00.000Z'); // 00:00 1/8 VN
  });

  it('vnMonthStart sát giao thừa tháng: 00:30 VN ngày 1/9 → mốc là 1/9, không phải 1/8', () => {
    const now = new Date('2026-08-31T17:30:00.000Z'); // 00:30 ngày 1/9 giờ VN
    expect(vnMonthStart(now).toISOString()).toBe('2026-08-31T17:00:00.000Z'); // 00:00 1/9 VN
  });
});
