// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
import { describe, it, expect } from 'vitest';
import { provinceKey, cleanProvince } from '../../src/shared/utils/province.js';

describe('provinceKey — ghép chi nhánh với khách', () => {
  it('coi như nhau khi chỉ khác hoa/thường, dấu cách, dấu tiếng Việt', () => {
    expect(provinceKey('Hà Nội')).toBe(provinceKey('hà nội'));
    expect(provinceKey('Hà  Nội')).toBe(provinceKey(' Hà Nội '));
    expect(provinceKey('Đà Nẵng')).toBe(provinceKey('Da Nang'));
    expect(provinceKey('Thừa Thiên Huế')).toBe(provinceKey('thua thien hue'));
  });

  it('bỏ tiền tố đơn vị hành chính — admin gõ "TP. Hà Nội", sheet ghi "Hà Nội"', () => {
    expect(provinceKey('TP. Hà Nội')).toBe(provinceKey('Hà Nội'));
    expect(provinceKey('Thành phố Hà Nội')).toBe(provinceKey('Hà Nội'));
    expect(provinceKey('Tỉnh Đà Nẵng')).toBe(provinceKey('Đà Nẵng'));
  });

  it('KHÔNG gộp nhầm hai tỉnh khác nhau', () => {
    expect(provinceKey('Hà Nội')).not.toBe(provinceKey('Hà Nam'));
    expect(provinceKey('Hà Nội')).not.toBe(provinceKey('Hải Phòng'));
    // "Tiền Giang" bắt đầu bằng "Tiền" chứ không phải tiền tố "Tỉnh" — không được cắt.
    expect(provinceKey('Tiền Giang')).toBe(provinceKey('tien giang'));
    expect(provinceKey('Tiền Giang')).not.toBe(provinceKey('Giang'));
  });

  it('rỗng/null ra chuỗi rỗng, không ném lỗi', () => {
    expect(provinceKey(null)).toBe('');
    expect(provinceKey(undefined)).toBe('');
    expect(provinceKey('   ')).toBe('');
  });
});

describe('cleanProvince — dạng đem lưu', () => {
  it('giữ dấu, dọn khoảng trắng thừa', () => {
    expect(cleanProvince('  Hà  Nội ')).toBe('Hà Nội');
  });

  it('rỗng thành null, không thành chuỗi rỗng', () => {
    // Chuỗi rỗng là một giá trị nên sẽ đụng @@unique([orgId, province]) ngay khi có
    // phòng ban thứ hai cũng để trống; NULL thì Postgres coi mỗi cái một khác.
    expect(cleanProvince('')).toBeNull();
    expect(cleanProvince('   ')).toBeNull();
    expect(cleanProvince(null)).toBeNull();
    expect(cleanProvince(undefined)).toBeNull();
  });
});
