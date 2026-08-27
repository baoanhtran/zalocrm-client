// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * salutation.ts — nguồn chân lý DUY NHẤT cho giá trị của biến `{gender}`.
 *
 * `Contact.gender` chỉ nhận male/female/other/unknown nên không nhét được cách gọi
 * thật ngoài đời ("Em", "Cô", "Chú", "Bác"). `Contact.salutation` là chỗ cho sale ghi
 * đè cách xưng hô riêng của từng khách; để trống thì suy từ giới tính như cũ.
 *
 * Hai thứ CỐ Ý tách rời: `gender` vẫn để SDK Zalo tự điền và dùng cho lọc/thống kê,
 * `salutation` chỉ ảnh hưởng chữ hiện ra trong tin nhắn.
 *
 * Trước đây logic suy xưng hô chép ở 2 nơi và lệch nhau — hồ sơ khách ra "Anh Chị"
 * còn lúc gửi tin ra "Anh/Chị". Gom về đây, chốt "Anh/Chị" vì đó là cái khách đang
 * thực nhận; đổi mặc định là đổi tin nhắn đang chạy.
 */

/** Xưng hô khi không biết giới tính và sale cũng chưa đặt riêng. */
export const DEFAULT_SALUTATION = 'Anh/Chị';

/** Xưng hô là 1-2 chữ. Dài hơn là sale dán nhầm cả câu vào ô. */
export const MAX_SALUTATION_LEN = 24;

export interface SalutationSource {
  /** Contact.gender — 'male' | 'female' | 'other' | 'unknown' | null */
  gender?: string | null;
  /** Contact.salutation — cách gọi riêng sale đặt cho khách này. Trống = chưa đặt. */
  salutation?: string | null;
}

/**
 * Trả về chữ sẽ thay cho `{gender}` trong tin nhắn.
 * Ưu tiên xưng hô riêng của khách, không có mới suy từ giới tính.
 */
export function resolveSalutation(src: SalutationSource): string {
  const custom = (src.salutation ?? '').trim();
  if (custom) return custom;
  if (src.gender === 'female') return 'Chị';
  if (src.gender === 'male') return 'Anh';
  return DEFAULT_SALUTATION;
}

/** Chuẩn hoá ô nhập trước khi gửi lên API. Rỗng → null (DB lưu NULL, không lưu ''). */
export function normalizeSalutationInput(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  return s.slice(0, MAX_SALUTATION_LEN);
}
