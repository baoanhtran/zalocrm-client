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
