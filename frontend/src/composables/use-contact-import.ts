// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Nguyễn Tiến Lộc
/**
 * use-contact-import.ts — Gọi API "Nhập khách từ Excel" (2026-09-10).
 *
 * Chỉ là lớp gọi mạng: đọc file do sheet-reader lo, còn đoán cột / dò trùng do backend
 * lo. Để một chỗ duy nhất giữ hình dạng payload, khỏi lệch giữa bước xem trước và bước
 * nhập thật — hai bước phải gửi CÙNG một bảng thì con số xem trước mới đúng với kết quả.
 */
import { ref } from 'vue';
import { api } from '@/api/index';

/** Chỉ số cột (0-based); null = không dùng cột nào cho vai này. */
export interface ImportColumns {
  fullName: number | null;
  birth: number | null;
  phone: number | null;
}

export interface ImportRowPreview {
  rowNumber: number;
  fullName: string | null;
  phone: string;
  phoneNormalized: string;
  birthDate: string | null;
  birthYear: number | null;
}

export interface ImportPreview {
  columns: ImportColumns;
  sample: ImportRowPreview[];
  stats: {
    totalRows: number;
    willCreate: number;
    duplicateInCrm: number;
    duplicateInFile: number;
    invalid: number;
  };
  invalidRows: Array<{ rowNumber: number; reason: 'missing_phone' | 'invalid_phone' }>;
  duplicateInFileRows: number[];
}

export interface ImportResult {
  batchId: string;
  created: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  invalidRows: Array<{ rowNumber: number; reason: 'missing_phone' | 'invalid_phone' }>;
}

export interface ProvinceOption {
  name: string;
  /** Có chi nhánh phụ trách tỉnh này không — không có thì lead nhập vào sẽ treo. */
  hasBranch: boolean;
}

export interface ImportBatch {
  id: string;
  fileName: string;
  province: string;
  totalRows: number;
  createdCount: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  undoneAt: string | null;
  undoneCount: number | null;
  createdAt: string;
  createdBy: { id: string; fullName: string | null } | null;
}

interface SheetPayload {
  headers: string[];
  rows: string[][];
  /** Số dòng thật trong file của từng dòng dữ liệu — để backend báo lỗi đúng dòng. */
  rowNumbers: number[];
  hasHeaderRow: boolean;
  columns?: ImportColumns | null;
}

/** Câu tiếng Việt cho mã lỗi backend trả về — hiện thẳng cho người dùng. */
const ERROR_TEXT: Record<string, string> = {
  rows_required: 'Không đọc được dữ liệu trong file.',
  no_data_rows: 'File không có dòng dữ liệu nào.',
  too_many_rows: 'File quá nhiều dòng (tối đa 2.000). Chia nhỏ file rồi nhập từng phần.',
  province_required: 'Chưa chọn tỉnh/thành.',
  phone_column_required: 'Chưa xác định được cột số điện thoại.',
  batch_not_found: 'Không tìm thấy lần nhập này.',
  already_undone: 'Lần nhập này đã được hoàn tác rồi.',
};

export function errorText(err: unknown): string {
  const code = (err as any)?.response?.data?.error;
  return ERROR_TEXT[code] ?? 'Có lỗi xảy ra, thử lại giúp em.';
}

export function useContactImport() {
  const previewing = ref(false);
  const importing = ref(false);

  async function fetchProvinces(): Promise<ProvinceOption[]> {
    const res = await api.get('/contacts/import/provinces');
    return res.data?.provinces ?? [];
  }

  async function preview(payload: SheetPayload): Promise<ImportPreview> {
    previewing.value = true;
    try {
      const res = await api.post('/contacts/import/preview', payload);
      return res.data;
    } finally {
      previewing.value = false;
    }
  }

  async function runImport(payload: SheetPayload & { province: string; fileName: string }): Promise<ImportResult> {
    importing.value = true;
    try {
      const res = await api.post('/contacts/import', payload);
      return res.data;
    } finally {
      importing.value = false;
    }
  }

  async function undoImport(batchId: string): Promise<{ deleted: number; kept: number }> {
    const res = await api.post(`/contacts/import/${batchId}/undo`);
    return res.data;
  }

  async function fetchBatches(): Promise<ImportBatch[]> {
    const res = await api.get('/contacts/import/batches');
    return res.data?.batches ?? [];
  }

  return { previewing, importing, fetchProvinces, preview, runImport, undoImport, fetchBatches };
}
