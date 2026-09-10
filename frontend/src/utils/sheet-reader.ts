// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * sheet-reader.ts — Đọc file .xlsx/.csv thành mảng ô 2 chiều, ngay trên trình duyệt.
 *
 * Dùng chung cho hộp thoại "Tệp khách hàng" (marketing) và "Nhập khách từ Excel" (màn
 * Khách hàng). Đọc ở trình duyệt chứ không upload: file danh sách khách là dữ liệu cá
 * nhân, không có lý do gì để nó nằm lại trên đĩa server, mà server cũng đỡ một đường
 * nhận file.
 *
 * exceljs được import động — thư viện nặng, người không mở hộp thoại nhập file thì
 * không phải tải.
 *
 * Chỉ đọc .xlsx và .csv. Định dạng .xls đời 97-2003 KHÔNG đọc được (exceljs không hỗ
 * trợ) — nhận vào rồi báo lỗi khó hiểu thì tệ hơn là nói thẳng ngay ở ô chọn file.
 */

/** Một dòng dữ liệu; ô rỗng là chuỗi rỗng chứ không phải undefined. */
export type SheetRow = string[];

export interface SheetData {
  /** Tiêu đề cột. File không có dòng tiêu đề thì là "Cột 1", "Cột 2"... */
  headers: string[];
  /** Các dòng DỮ LIỆU (đã bỏ dòng tiêu đề nếu có). */
  rows: SheetRow[];
  /**
   * Số dòng THẬT trong file của từng phần tử `rows` (đếm từ 1, tính cả dòng tiêu đề
   * và các dòng trống đã bị bỏ). Báo "lỗi ở dòng 88" mà đếm theo mảng đã lọc thì người
   * dùng mở Excel ra không thấy gì ở dòng đó.
   */
  rowNumbers: number[];
  /** Dòng đầu file có phải tiêu đề không. */
  hasHeaderRow: boolean;
}

/**
 * Tách một dòng CSV theo RFC 4180: ô bọc trong ngoặc kép giữ nguyên dấu phẩy bên
 * trong, hai ngoặc kép liền nhau là một ngoặc kép thật.
 *
 * Bản cũ cắt thẳng bằng split(',') nên "Nguyễn Văn A, Giám đốc" thành hai cột và mọi
 * cột sau đó lệch một nhịp — sai âm thầm, không có lỗi nào hiện ra.
 */
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * Đoán dấu phân cách của file CSV.
 *
 * Excel bản tiếng Việt xuất CSV bằng dấu CHẤM PHẨY (do dấu phẩy đang làm dấu thập
 * phân), nên chỉ hiểu dấu phẩy là nửa số file người dùng gửi lên đọc ra một cột.
 */
function detectDelimiter(firstLines: string[]): string {
  const count = (d: string) => firstLines.reduce((n, l) => n + splitCsvLine(l, d).length, 0);
  return count(';') > count(',') ? ';' : ',';
}

/** Đọc CSV (UTF-8, có hoặc không có BOM) thành mảng ô. */
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\ufeff/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const delimiter = detectDelimiter(lines.slice(0, 5));
  return lines.map((l) => splitCsvLine(l, delimiter));
}

async function parseXlsx(buf: ArrayBuffer): Promise<string[][]> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // row.values là mảng đánh số từ 1, phần tử 0 luôn null — bỏ đi.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    out.push(values.map(cellToString));
  });
  return out;
}

/**
 * Đưa mọi kiểu ô của exceljs về chuỗi.
 *
 * Ô ngày giữ dạng YYYY-MM-DD (không dùng toLocaleString) để phía backend đọc ngày sinh
 * không phải đoán theo định dạng vùng của máy người dùng. Ô công thức lấy kết quả, ô
 * rich-text ghép các đoạn lại, ô siêu liên kết lấy phần chữ.
 */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.trim();
    if (Array.isArray(o.richText)) return o.richText.map((p: any) => p?.text ?? '').join('').trim();
    if ('result' in o) return cellToString(o.result);
    if ('hyperlink' in o && typeof o.hyperlink === 'string') return o.hyperlink.trim();
    return '';
  }
  return String(v).trim();
}

/**
 * Dòng đầu là tiêu đề khi nó KHÔNG chứa dữ liệu thật.
 *
 * Dấu hiệu chắc nhất trong bối cảnh này là số điện thoại: dòng tiêu đề không bao giờ
 * có, dòng dữ liệu gần như luôn có. Không thấy số nào thì mới xét tới việc các ô có
 * trông giống nhãn cột hay không.
 */
function looksLikeHeaderRow(row: string[]): boolean {
  const hasPhoneLike = row.some((c) => c.replace(/[^\d]/g, '').length >= 9);
  if (hasPhoneLike) return false;
  return row.some((c) => c.length > 0 && c.length < 40 && /[A-Za-zÀ-ỹĐđ]/.test(c));
}

export class SheetReadError extends Error {}

/**
 * Đọc file người dùng chọn. Ném SheetReadError kèm câu tiếng Việt hiển thị thẳng được.
 */
export async function readSheetFile(file: File): Promise<SheetData> {
  const name = file.name.toLowerCase();
  const isCsv = name.endsWith('.csv');
  const isXlsx = name.endsWith('.xlsx');
  if (!isCsv && !isXlsx) {
    throw new SheetReadError(
      name.endsWith('.xls')
        ? 'File .xls đời cũ (97-2003) không đọc được. Mở bằng Excel rồi lưu lại thành .xlsx giúp em.'
        : 'Chỉ nhận file .xlsx hoặc .csv.',
    );
  }

  let grid: string[][];
  try {
    const buf = await file.arrayBuffer();
    grid = isCsv ? parseCsv(new TextDecoder().decode(buf)) : await parseXlsx(buf);
  } catch {
    throw new SheetReadError('Không đọc được file. Kiểm tra lại file có mở được bằng Excel không.');
  }

  // Bỏ dòng trống ở mọi vị trí (file thật hay có dòng kẻ phân cách giữa các nhóm)
  // nhưng NHỚ số dòng gốc của những dòng giữ lại.
  const kept = grid
    .map((cells, i) => ({ cells, lineNo: i + 1 }))
    .filter((r) => r.cells.some((c) => c !== ''));
  if (kept.length === 0) throw new SheetReadError('File rỗng.');

  const hasHeaderRow = looksLikeHeaderRow(kept[0].cells);
  const width = kept.reduce((n, r) => Math.max(n, r.cells.length), 0);
  const headers = hasHeaderRow
    ? Array.from({ length: width }, (_, i) => kept[0].cells[i] || `Cột ${i + 1}`)
    : Array.from({ length: width }, (_, i) => `Cột ${i + 1}`);
  const dataRows = hasHeaderRow ? kept.slice(1) : kept;
  const rows = dataRows.map((r) => Array.from({ length: width }, (_, i) => r.cells[i] ?? ''));
  const rowNumbers = dataRows.map((r) => r.lineNo);

  if (rows.length === 0) throw new SheetReadError('Không có dòng dữ liệu nào sau dòng tiêu đề.');
  return { headers, rows, rowNumbers, hasHeaderRow };
}
