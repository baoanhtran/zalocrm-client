// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * province.ts — chuẩn hoá tên tỉnh/thành để ghép chi nhánh với khách.
 *
 * Tên tỉnh đi vào hệ thống từ hai phía do hai người khác nhau gõ: admin gõ khi lập
 * chi nhánh trong CRM, còn tên tab tỉnh trong Google Sheet do người vận hành đặt.
 * So khớp thô thì "Hà Nội" / "hà nội" / "TP. Hà Nội" thành ba tỉnh khác nhau, chia
 * lead sai mà không có lỗi nào nổi lên — nên mọi so sánh phải đi qua provinceKey().
 */

/**
 * Khoá so sánh: bỏ dấu, bỏ khoảng trắng, bỏ tiền tố đơn vị hành chính, thường hoá.
 * CHỈ dùng để so khớp — không bao giờ lưu xuống DB hay hiện cho người dùng.
 */
export function provinceKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const base = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // bỏ dấu thanh + dấu mũ
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // "TP. Hà Nội", "Thành phố Hà Nội", "Tỉnh Đà Nẵng" đều phải ra cùng khoá với tên trần.
  const stripped = base.replace(/^(tinh|thanh pho|tp|t\/p)\s+/, '');
  return stripped.replace(/\s+/g, '');
}

/**
 * Dạng đem lưu: giữ nguyên dấu để hiện cho người dùng, chỉ dọn khoảng trắng thừa.
 * Chuỗi rỗng trả null — cột `province` dùng NULL để nói "phòng ban này không phải
 * chi nhánh", còn chuỗi rỗng thì lại là một giá trị và sẽ đụng ràng buộc unique
 * ngay khi có phòng ban thứ hai cũng để trống.
 */
export function cleanProvince(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}
