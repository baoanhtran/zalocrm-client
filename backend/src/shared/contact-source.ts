// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * contact-source.ts — Giá trị chuẩn của `Contact.source` (ô "Nguồn khách").
 *
 * Anh chốt 2026-09-05: ô lọc Nguồn khách chỉ còn 2 nguồn — quét nhóm Zalo và
 * phiếu khảo sát. Nguồn cũ (FB/TT/GT/CN) gỡ khỏi dropdown; dữ liệu cũ trong DB
 * KHÔNG đụng tới, khách cũ vẫn giữ nguyên source của họ.
 *
 * Khảo sát lưu kèm tỉnh ngay trong source — "khao-sat:Hà Nội" — mỗi tỉnh một giá
 * trị riêng. Nên lọc theo nguồn gộp "Phiếu khảo sát" phải so TIỀN TỐ, không so
 * bằng; chọn đúng một tỉnh thì vẫn so bằng như thường. Đây cũng là dạng mà
 * lead-distribution/runner.fillProvinceFromSource() cắt tỉnh ra.
 */

/** Khách sinh ra từ màn Quét nhóm (GroupMember → Contact). */
export const SOURCE_GROUP_SCAN = 'quet-nhom';

/** Nguồn gộp của phiếu khảo sát — giá trị thật trong DB là `khao-sat:<Tỉnh>`. */
export const SOURCE_SURVEY = 'khao-sat';

/** Tiền tố đứng trước tên tỉnh trong source của khách khảo sát. */
export const SOURCE_SURVEY_PREFIX = `${SOURCE_SURVEY}:`;

/**
 * Nguồn gộp của khách nhập từ file Excel — giá trị thật trong DB là
 * `nhap-excel:<Tỉnh>`, cùng lối đặt tên với phiếu khảo sát.
 *
 * Tách riêng khỏi `khao-sat` (anh chốt 2026-09-10): hai nguồn này khác nhau về chất
 * lượng dữ liệu và cách về — phiếu khảo sát là khách tự điền, còn đây là danh sách
 * mua/xin về rồi nhập hàng loạt. Gộp chung thì sau không tách ra để đánh giá được.
 */
export const SOURCE_EXCEL_IMPORT = 'nhap-excel';

/** Tiền tố đứng trước tên tỉnh trong source của khách nhập từ Excel. */
export const SOURCE_EXCEL_IMPORT_PREFIX = `${SOURCE_EXCEL_IMPORT}:`;

/**
 * Nguồn GỘP → tiền tố tương ứng; nguồn thường trả null (so bằng như cũ).
 *
 * Có hai nguồn lưu kèm tỉnh ngay trong `source` nên bộ lọc phải so TIỀN TỐ. Luật này
 * trước nằm rải ở màn Khách hàng và báo cáo; thêm nguồn thứ hai mà chép tiếp là kiểu
 * gì cũng có chỗ quên, rồi bộ lọc ra rỗng mà không ai hiểu vì sao.
 */
export function aggregateSourcePrefix(source: string | null | undefined): string | null {
  if (source === SOURCE_SURVEY) return SOURCE_SURVEY_PREFIX;
  if (source === SOURCE_EXCEL_IMPORT) return SOURCE_EXCEL_IMPORT_PREFIX;
  return null;
}
