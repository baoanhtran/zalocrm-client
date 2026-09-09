// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * extracted-entities-bma.test.ts — Trích xuất thông tin khách cho ngành du học /
 * xuất khẩu lao động (BMA), thay khối bất động sản cũ.
 *
 * safeParseEntities cố tình "fail open": field nào sai thì bỏ RIÊNG field đó và
 * giữ phần còn lại — AI trả sai một chỗ không được làm mất cả bản ghi.
 */
import { describe, it, expect } from 'vitest';
import { safeParseEntities } from '../../src/modules/ai/schemas/extracted-entities.ts';

const ok = (input: unknown) => {
  const r = safeParseEntities(input);
  if (!r.success) throw new Error(`parse thất bại: ${r.error}`);
  return r.data;
};

const base = { confidenceScore: 0.9, missingFields: [] };

describe('safeParseEntities — khối du học', () => {
  it('bóc đủ một hồ sơ du học hoàn chỉnh', () => {
    const d = ok({
      ...base,
      fullName: 'Nguyễn Văn An',
      gender: 'M',
      birthYear: 2008,
      province: 'Bắc Ninh',
      studyAbroadNeed: {
        serviceType: 'du_hoc',
        country: 'Hàn Quốc',
        eduLevel: 'thpt',
        gpa: 7.5,
        language: 'TOPIK 2',
        budgetMin: 250,
        budgetMax: 300,
        departureTimeline: '6_thang',
        visaRejected: false,
        decisionMaker: 'Bố mẹ',
      },
    });

    expect(d.studyAbroadNeed).toEqual({
      serviceType: 'du_hoc',
      country: 'Hàn Quốc',
      eduLevel: 'thpt',
      gpa: 7.5,
      language: 'TOPIK 2',
      budgetMin: 250,
      budgetMax: 300,
      departureTimeline: '6_thang',
      visaRejected: false,
      decisionMaker: 'Bố mẹ',
    });
    expect(d.fullName).toBe('Nguyễn Văn An');
  });

  it('nhận cả hồ sơ xuất khẩu lao động', () => {
    expect(ok({ ...base, studyAbroadNeed: { serviceType: 'xkld' } }).studyAbroadNeed)
      .toEqual({ serviceType: 'xkld' });
  });

  it('serviceType ngoài danh mục thì bỏ riêng field đó', () => {
    const d = ok({ ...base, studyAbroadNeed: { serviceType: 'mua_nha', country: 'Nhật Bản' } });
    expect(d.studyAbroadNeed).toEqual({ country: 'Nhật Bản' });
  });

  it('điểm trung bình phải nằm trong thang 0–10', () => {
    expect(ok({ ...base, studyAbroadNeed: { gpa: 8.2 } }).studyAbroadNeed).toEqual({ gpa: 8.2 });
    for (const bad of [-1, 11, 100]) {
      expect(ok({ ...base, studyAbroadNeed: { gpa: bad } }).studyAbroadNeed, `gpa=${bad}`).toBeUndefined();
    }
  });

  it('ngân sách tính bằng TRIỆU, chặn số vô lý', () => {
    expect(ok({ ...base, studyAbroadNeed: { budgetMin: 250 } }).studyAbroadNeed).toEqual({ budgetMin: 250 });
    // 0.3 là dấu hiệu AI còn nghĩ theo đơn vị "tỷ" của prompt bất động sản cũ.
    for (const bad of [0, -5, 0.3, 999999]) {
      expect(ok({ ...base, studyAbroadNeed: { budgetMin: bad } }).studyAbroadNeed, `budget=${bad}`).toBeUndefined();
    }
  });

  it('visaRejected chỉ nhận boolean thật, không nhận chuỗi', () => {
    expect(ok({ ...base, studyAbroadNeed: { visaRejected: true } }).studyAbroadNeed).toEqual({ visaRejected: true });
    expect(ok({ ...base, studyAbroadNeed: { visaRejected: 'true' } }).studyAbroadNeed).toBeUndefined();
  });

  it('eduLevel và departureTimeline phải đúng danh mục', () => {
    expect(ok({ ...base, studyAbroadNeed: { eduLevel: 'cao_dang' } }).studyAbroadNeed).toEqual({ eduLevel: 'cao_dang' });
    expect(ok({ ...base, studyAbroadNeed: { eduLevel: 'tien_si' } }).studyAbroadNeed).toBeUndefined();
    expect(ok({ ...base, studyAbroadNeed: { departureTimeline: '1_nam' } }).studyAbroadNeed).toEqual({ departureTimeline: '1_nam' });
    expect(ok({ ...base, studyAbroadNeed: { departureTimeline: 'nam_sau' } }).studyAbroadNeed).toBeUndefined();
  });

  it('khối rỗng thì không tạo key thừa', () => {
    expect(ok({ ...base, studyAbroadNeed: {} }).studyAbroadNeed).toBeUndefined();
  });

  it('KHÔNG còn nhận propertyNeed của ngành bất động sản', () => {
    const d = ok({ ...base, propertyNeed: { type: '2PN', budgetMin: 2.8 } }) as Record<string, unknown>;
    expect(d.propertyNeed).toBeUndefined();
    expect(d.studyAbroadNeed).toBeUndefined();
  });

  it('các field vô hướng cũ vẫn giữ nguyên hành vi', () => {
    const d = ok({
      ...base,
      fullName: 'Trần Thị Bình', gender: 'F', birthYear: 2007,
      occupation: 'Học sinh', incomeRange: '10-20',
      province: 'Hưng Yên', district: 'Văn Lâm',
      leadSource: 'facebook', tags: ['du-hoc-han'],
    });
    expect(d.gender).toBe('F');
    expect(d.birthYear).toBe(2007);
    expect(d.incomeRange).toBe('10-20');
    expect(d.leadSource).toBe('facebook');
    expect(d.tags).toEqual(['du-hoc-han']);
  });
});
