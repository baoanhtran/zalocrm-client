// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * sheet-reader.spec.ts — Đọc CSV: phần dễ sai âm thầm nhất của luồng nhập file.
 *
 * Bản cũ (nằm trong CreateListModal) cắt dòng bằng split(',') nên "Nguyễn Văn A, GĐ"
 * thành hai cột và mọi cột phía sau lệch một nhịp mà không có lỗi nào hiện ra. Các
 * trường hợp dưới đây khoá lại hành vi đúng.
 *
 * Chạy môi trường 'node' nên phải tự dựng File tối giản — chỉ cần name + arrayBuffer.
 */
import { describe, it, expect } from 'vitest';
import { readSheetFile, SheetReadError } from './sheet-reader';

function csvFile(name: string, content: string): File {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

describe('readSheetFile — CSV', () => {
  it('giữ nguyên ô có dấu phẩy khi ô được bọc ngoặc kép', async () => {
    const data = await readSheetFile(
      csvFile('kh.csv', 'Ho ten,Ghi chu,SDT\n"Nguyễn Văn A, Giám đốc",khách quen,0904294048'),
    );
    expect(data.headers).toEqual(['Ho ten', 'Ghi chu', 'SDT']);
    expect(data.rows[0]).toEqual(['Nguyễn Văn A, Giám đốc', 'khách quen', '0904294048']);
  });

  it('hiểu hai ngoặc kép liền nhau là một ngoặc kép thật', async () => {
    const data = await readSheetFile(csvFile('kh.csv', 'Ten,SDT\n"Anh ""Bảo"" Trần",0904294048'));
    expect(data.rows[0][0]).toBe('Anh "Bảo" Trần');
  });

  it('nhận CSV xuất từ Excel tiếng Việt (dấu chấm phẩy)', async () => {
    const data = await readSheetFile(csvFile('kh.csv', 'Ho ten;Ngay sinh;SDT\nNguyễn Văn A;01/02/1990;0904294048'));
    expect(data.headers).toEqual(['Ho ten', 'Ngay sinh', 'SDT']);
    expect(data.rows[0]).toEqual(['Nguyễn Văn A', '01/02/1990', '0904294048']);
  });

  it('bỏ BOM của file UTF-8 xuất từ Excel', async () => {
    const data = await readSheetFile(csvFile('kh.csv', '﻿Ho ten,SDT\nNguyễn Văn A,0904294048'));
    expect(data.headers[0]).toBe('Ho ten');
  });

  it('file không có dòng tiêu đề: đặt tên cột và giữ nguyên dòng đầu làm dữ liệu', async () => {
    const data = await readSheetFile(csvFile('kh.csv', 'Nguyễn Văn A,0904294048\nTrần Thị B,0912345678'));
    expect(data.hasHeaderRow).toBe(false);
    expect(data.headers).toEqual(['Cột 1', 'Cột 2']);
    expect(data.rows).toHaveLength(2);
  });

  it('bỏ dòng trống ở giữa file', async () => {
    const data = await readSheetFile(csvFile('kh.csv', 'Ten,SDT\nA,0904294048\n\n,\nB,0912345678'));
    expect(data.rows).toHaveLength(2);
  });

  it('dòng thiếu ô cuối vẫn đủ cột, không lệch', async () => {
    const data = await readSheetFile(csvFile('kh.csv', 'Ten,Ngay sinh,SDT\nA,,0904294048\nB'));
    expect(data.rows[1]).toEqual(['B', '', '']);
  });

  it('từ chối .xls đời cũ bằng câu người dùng hiểu được', async () => {
    await expect(readSheetFile(csvFile('kh.xls', 'x'))).rejects.toBeInstanceOf(SheetReadError);
    await expect(readSheetFile(csvFile('kh.xls', 'x'))).rejects.toThrow(/\.xlsx/);
  });

  it('từ chối định dạng lạ', async () => {
    await expect(readSheetFile(csvFile('kh.txt', 'x'))).rejects.toBeInstanceOf(SheetReadError);
  });

  it('file rỗng báo lỗi thay vì trả bảng trống', async () => {
    await expect(readSheetFile(csvFile('kh.csv', '\n\n'))).rejects.toThrow('File rỗng.');
  });
});
