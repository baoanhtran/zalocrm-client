/**
 * salutation.spec.ts — hàm suy xưng hô dùng chung cho {gender}.
 *
 * Trước đây logic này chép ở 2 nơi và LỆCH nhau: hồ sơ khách hiện "Anh Chị" còn lúc
 * gửi tin ra "Anh/Chị". Gom về 1 hàm, chốt "Anh/Chị" (cái khách đang thực nhận).
 */
import { describe, it, expect } from 'vitest';
import { resolveSalutation, DEFAULT_SALUTATION } from './salutation';

describe('resolveSalutation — suy từ giới tính khi không có xưng hô riêng', () => {
  it('nam → Anh, nữ → Chị', () => {
    expect(resolveSalutation({ gender: 'male' })).toBe('Anh');
    expect(resolveSalutation({ gender: 'female' })).toBe('Chị');
  });

  it('other / unknown / null / thiếu hẳn → mặc định Anh/Chị', () => {
    expect(resolveSalutation({ gender: 'other' })).toBe(DEFAULT_SALUTATION);
    expect(resolveSalutation({ gender: 'unknown' })).toBe(DEFAULT_SALUTATION);
    expect(resolveSalutation({ gender: null })).toBe(DEFAULT_SALUTATION);
    expect(resolveSalutation({})).toBe(DEFAULT_SALUTATION);
  });

  it('mặc định là "Anh/Chị" (có gạch chéo) — khớp cái khách đang thực nhận', () => {
    expect(DEFAULT_SALUTATION).toBe('Anh/Chị');
  });
});

describe('resolveSalutation — xưng hô riêng của khách đè lên giới tính', () => {
  it('có xưng hô riêng → dùng nó, bất kể giới tính', () => {
    expect(resolveSalutation({ gender: 'female', salutation: 'Em' })).toBe('Em');
    expect(resolveSalutation({ gender: 'male', salutation: 'Cô' })).toBe('Cô');
    expect(resolveSalutation({ gender: null, salutation: 'Bác' })).toBe('Bác');
  });

  it('cắt khoảng trắng thừa — sale gõ " Em " vẫn ra "Em", không lệch câu chào', () => {
    expect(resolveSalutation({ gender: 'male', salutation: '  Em  ' })).toBe('Em');
  });

  it('xưng hô rỗng / chỉ khoảng trắng → coi như chưa đặt, quay về suy từ giới tính', () => {
    expect(resolveSalutation({ gender: 'female', salutation: '' })).toBe('Chị');
    expect(resolveSalutation({ gender: 'female', salutation: '   ' })).toBe('Chị');
    expect(resolveSalutation({ gender: 'male', salutation: null })).toBe('Anh');
  });
});

describe('normalizeSalutationInput — chuẩn hoá trước khi lưu', () => {
  it('trim; rỗng → null để DB lưu NULL chứ không phải chuỗi rỗng', async () => {
    const { normalizeSalutationInput } = await import('./salutation');
    expect(normalizeSalutationInput('  Em ')).toBe('Em');
    expect(normalizeSalutationInput('')).toBeNull();
    expect(normalizeSalutationInput('   ')).toBeNull();
    expect(normalizeSalutationInput(null)).toBeNull();
    expect(normalizeSalutationInput(undefined)).toBeNull();
  });

  it('cắt độ dài — xưng hô là 1-2 chữ, dán cả đoạn văn vào là nhầm', async () => {
    const { normalizeSalutationInput, MAX_SALUTATION_LEN } = await import('./salutation');
    const long = 'x'.repeat(MAX_SALUTATION_LEN + 20);
    expect(normalizeSalutationInput(long)?.length).toBe(MAX_SALUTATION_LEN);
  });
});
