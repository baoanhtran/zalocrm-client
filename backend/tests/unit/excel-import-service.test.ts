// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * excel-import-service.test.ts — Nhập khách từ Excel: phần đoán cột và đọc dữ liệu.
 *
 * Đây là chỗ tính năng dễ hỏng âm thầm nhất: đoán nhầm cột thì vài trăm khách vào CRM
 * với tên là số điện thoại, mà không có lỗi nào nổi lên. Nên toàn bộ hàm thuần ở đây
 * được khoá bằng test, kể cả các dạng file lệch chuẩn mà người dùng hay gửi.
 */
import { describe, it, expect } from 'vitest';
import {
  detectColumns,
  parseBirth,
  normalizeImportRow,
  dedupeRowsInFile,
} from '../../src/modules/contacts/import/excel-import-service.ts';

describe('detectColumns — đoán theo tiêu đề', () => {
  it('nhận tiêu đề tiếng Việt có dấu', () => {
    const headers = ['STT', 'Họ và tên', 'Ngày sinh', 'Số điện thoại'];
    const rows = [['1', 'Nguyễn Văn A', '01/02/1990', '0904294048']];
    expect(detectColumns(headers, rows)).toEqual({ fullName: 1, birth: 2, phone: 3 });
  });

  it('nhận tiêu đề không dấu và viết tắt', () => {
    const headers = ['ho ten', 'ns', 'sdt'];
    const rows = [['Trần Bảo Anh', '1990', '0904294048']];
    expect(detectColumns(headers, rows)).toEqual({ fullName: 0, birth: 1, phone: 2 });
  });

  it('nhận tiêu đề tiếng Anh', () => {
    const headers = ['Full Name', 'DOB', 'Phone Number'];
    const rows = [['Nguyen Van A', '1990-02-01', '0904294048']];
    expect(detectColumns(headers, rows)).toEqual({ fullName: 0, birth: 1, phone: 2 });
  });

  it('không nhầm "Ngày tạo" thành ngày sinh', () => {
    const headers = ['Tên khách', 'Ngày tạo', 'Điện thoại'];
    const rows = [['Nguyễn Văn A', '01/02/2026', '0904294048']];
    const got = detectColumns(headers, rows);
    expect(got.fullName).toBe(0);
    expect(got.phone).toBe(2);
    expect(got.birth).toBeNull();
  });
});

describe('detectColumns — đoán theo nội dung khi tiêu đề vô dụng', () => {
  it('file không có tiêu đề: nhìn dữ liệu mà đoán', () => {
    const headers = ['Cột 1', 'Cột 2', 'Cột 3'];
    const rows = [
      ['Nguyễn Văn A', '0904294048', '01/02/1990'],
      ['Trần Thị B', '0912345678', '15/07/1985'],
      ['Lê Văn C', '0987654321', '20/12/1992'],
    ];
    expect(detectColumns(headers, rows)).toEqual({ fullName: 0, phone: 1, birth: 2 });
  });

  it('tiêu đề lạ nhưng cột SĐT nhận ra được từ dữ liệu', () => {
    const headers = ['Mã', 'Liên hệ', 'Ghi chú'];
    const rows = [
      ['KH001', '0904294048', 'khách quen'],
      ['KH002', '+84912345678', 'gọi buổi tối'],
    ];
    expect(detectColumns(headers, rows).phone).toBe(1);
  });

  it('không lấy cột toàn số nhưng không phải SĐT làm cột SĐT', () => {
    const headers = ['Cột 1', 'Cột 2'];
    const rows = [
      ['12345', 'Nguyễn Văn A'],
      ['67890', 'Trần Thị B'],
    ];
    expect(detectColumns(headers, rows).phone).toBeNull();
  });

  it('cột họ tên là cột chữ có nhiều từ nhất', () => {
    const headers = ['Cột 1', 'Cột 2', 'Cột 3'];
    const rows = [
      ['Hà Nội', 'Nguyễn Văn A', '0904294048'],
      ['Hà Nội', 'Trần Thị Bích Ngọc', '0912345678'],
    ];
    expect(detectColumns(headers, rows).fullName).toBe(1);
  });
});

describe('parseBirth', () => {
  it('đọc dd/mm/yyyy', () => {
    expect(parseBirth('01/02/1990')).toEqual({ birthDate: '1990-02-01', birthYear: 1990 });
  });

  it('đọc d-m-yyyy và d.m.yyyy', () => {
    expect(parseBirth('1-2-1990')).toEqual({ birthDate: '1990-02-01', birthYear: 1990 });
    expect(parseBirth('1.2.1990')).toEqual({ birthDate: '1990-02-01', birthYear: 1990 });
  });

  it('đọc yyyy-mm-dd', () => {
    expect(parseBirth('1990-02-01')).toEqual({ birthDate: '1990-02-01', birthYear: 1990 });
  });

  it('đọc mỗi năm sinh', () => {
    expect(parseBirth('1990')).toEqual({ birthDate: null, birthYear: 1990 });
    expect(parseBirth(1990)).toEqual({ birthDate: null, birthYear: 1990 });
  });

  it('đọc ô Date thật của Excel', () => {
    expect(parseBirth(new Date(Date.UTC(1990, 1, 1)))).toEqual({
      birthDate: '1990-02-01',
      birthYear: 1990,
    });
  });

  it('đọc số serial của Excel', () => {
    // 32905 = 01/02/1990 theo lịch serial 1900 của Excel.
    expect(parseBirth(32905)).toEqual({ birthDate: '1990-02-01', birthYear: 1990 });
  });

  it('trả rỗng với ô trống hoặc rác', () => {
    expect(parseBirth('')).toEqual({ birthDate: null, birthYear: null });
    expect(parseBirth(null)).toEqual({ birthDate: null, birthYear: null });
    expect(parseBirth('không rõ')).toEqual({ birthDate: null, birthYear: null });
  });

  it('bỏ ngày vô lý thay vì đẩy năm sai vào CRM', () => {
    expect(parseBirth('32/13/1990')).toEqual({ birthDate: null, birthYear: null });
    expect(parseBirth('01/02/1850')).toEqual({ birthDate: null, birthYear: null });
    expect(parseBirth('01/02/2090')).toEqual({ birthDate: null, birthYear: null });
  });

  it('không nhận ngày ở tương lai làm ngày sinh', () => {
    const sangNam = new Date().getFullYear() + 1;
    expect(parseBirth(`01/02/${sangNam}`)).toEqual({ birthDate: null, birthYear: null });
  });
});

describe('normalizeImportRow', () => {
  const cols = { fullName: 0, birth: 1, phone: 2 };

  it('dòng đủ và hợp lệ', () => {
    const got = normalizeImportRow(['Nguyễn Văn A', '01/02/1990', '0904294048'], cols, 2);
    expect(got).toEqual({
      ok: true,
      row: {
        rowNumber: 2,
        fullName: 'Nguyễn Văn A',
        phone: '0904294048',
        phoneNormalized: '84904294048',
        birthDate: '1990-02-01',
        birthYear: 1990,
      },
    });
  });

  it('SĐT có khoảng trắng, dấu chấm, +84 đều nhận', () => {
    for (const p of ['0904 294 048', '0904.294.048', '+84904294048', '84904294048']) {
      const got = normalizeImportRow(['Nguyễn Văn A', '', p], cols, 2);
      expect(got.ok && got.row.phoneNormalized).toBe('84904294048');
    }
  });

  it('SĐT mất số 0 đầu do Excel định dạng số', () => {
    const got = normalizeImportRow(['Nguyễn Văn A', '', 904294048], cols, 2);
    expect(got.ok && got.row.phoneNormalized).toBe('84904294048');
  });

  it('thiếu SĐT thì báo lỗi kèm số dòng', () => {
    const got = normalizeImportRow(['Nguyễn Văn A', '01/02/1990', ''], cols, 7);
    expect(got).toEqual({ ok: false, rowNumber: 7, reason: 'missing_phone' });
  });

  it('SĐT sai định dạng thì báo lỗi', () => {
    const got = normalizeImportRow(['Nguyễn Văn A', '', '123'], cols, 9);
    expect(got).toEqual({ ok: false, rowNumber: 9, reason: 'invalid_phone' });
  });

  it('thiếu tên vẫn nhận — SĐT mới là thứ định danh khách', () => {
    const got = normalizeImportRow(['', '', '0904294048'], cols, 3);
    expect(got.ok && got.row.fullName).toBeNull();
  });

  it('bỏ tên chứa ký tự che ▒ thay vì lưu rác', () => {
    const got = normalizeImportRow(['Nguyễn ▒▒▒ A', '', '0904294048'], cols, 4);
    expect(got.ok && got.row.fullName).toBeNull();
  });

  it('không có cột ngày sinh thì thôi, không nổ', () => {
    const got = normalizeImportRow(['Nguyễn Văn A', '', '0904294048'], { fullName: 0, birth: null, phone: 2 }, 2);
    expect(got.ok && got.row.birthYear).toBeNull();
  });
});

describe('dedupeRowsInFile', () => {
  it('giữ dòng đầu, đếm số dòng trùng trong chính file', () => {
    const rows = [
      { rowNumber: 2, fullName: 'A', phone: '0904294048', phoneNormalized: '84904294048', birthDate: null, birthYear: null },
      { rowNumber: 3, fullName: 'B', phone: '0912345678', phoneNormalized: '84912345678', birthDate: null, birthYear: null },
      { rowNumber: 4, fullName: 'A lần 2', phone: '+84904294048', phoneNormalized: '84904294048', birthDate: null, birthYear: null },
    ];
    const got = dedupeRowsInFile(rows);
    expect(got.kept.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(got.duplicateRowNumbers).toEqual([4]);
  });
});
