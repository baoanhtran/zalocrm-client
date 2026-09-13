// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit test cho hàm extension Prisma dùng để tự suy Contact.phoneNormalized (hàm thuần, không DB).
import { describe, it, expect } from 'vitest';
import { deriveContactPhoneNormalized } from '../../src/shared/utils/phone.js';

describe('deriveContactPhoneNormalized', () => {
  it('ghi SĐT thật thì suy ra số chuẩn hoá', () => {
    expect(deriveContactPhoneNormalized({ phone: '0343014625' })).toEqual({
      phone: '0343014625',
      phoneNormalized: '84343014625',
    });
  });

  // Lỗi 2026-09-13 trên VPS BMA: 9 khách có SĐT nhưng phone_normalized NULL, ô tìm kiếm Khách hàng
  // (chỉ khớp qua phoneNormalized) không bao giờ thấy, kể cả với admin. Thủ phạm là payload dạng
  // { phone: body.phone, tags: body.tags } khi body không gửi phone: key phone CÓ nhưng undefined.
  it('phone: undefined KHÔNG được xoá số chuẩn hoá', () => {
    const out = deriveContactPhoneNormalized({ phone: undefined, tags: ['khao-sat'] });
    expect('phoneNormalized' in out).toBe(false);
  });

  it('không có key phone thì trả nguyên payload', () => {
    const payload = { tags: ['khao-sat'] };
    expect(deriveContactPhoneNormalized(payload)).toBe(payload);
  });

  it('xoá số có chủ ý (null hoặc chuỗi rỗng) thì số chuẩn hoá cũng về null', () => {
    expect(deriveContactPhoneNormalized({ phone: null })).toEqual({ phone: null, phoneNormalized: null });
    expect(deriveContactPhoneNormalized({ phone: '' })).toEqual({ phone: '', phoneNormalized: null });
  });

  it('mọi cách viết của cùng một số đều về cùng một khoá', () => {
    for (const phone of ['0343014625', '84343014625', '+84 343 014 625', '343014625']) {
      const out = deriveContactPhoneNormalized({ phone }) as { phoneNormalized?: string | null };
      expect(out.phoneNormalized).toBe('84343014625');
    }
  });
});
