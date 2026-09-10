<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<!--
  ImportExcelModal.vue — Nhập khách hàng loạt từ file Excel/CSV (2026-09-10).

  Ba bước trong một hộp thoại: chọn tỉnh + file → xem trước và chỉnh cột → nhập xong
  kèm nút hoàn tác. Bước xem trước là bắt buộc (anh chốt): máy đoán cột sai mà bấm
  thẳng là sinh vài trăm khách rác, xoá tay không xuể.

  File được đọc NGAY TRÊN TRÌNH DUYỆT (sheet-reader), server chỉ nhận mảng ô.
-->
<template>
  <div v-if="modelValue" class="cie-overlay" @click.self="close">
    <div class="cie-modal">
      <div class="cie-head">
        <h3 class="cie-title">📥 Nhập khách từ Excel</h3>
        <button class="cie-x" aria-label="Đóng" @click="close">✕</button>
      </div>

      <div class="cie-body">
        <!-- ───────── BƯỚC 3: kết quả ───────── -->
        <div v-if="result" class="cie-result">
          <div class="cie-result-big">✅ Đã thêm {{ result.created }} khách hàng</div>
          <ul class="cie-result-list">
            <li>Tỉnh/thành: <b>{{ province }}</b></li>
            <li v-if="result.skippedDuplicate">Bỏ qua {{ result.skippedDuplicate }} dòng trùng SĐT</li>
            <li v-if="result.skippedInvalid">Bỏ qua {{ result.skippedInvalid }} dòng lỗi</li>
          </ul>
          <div v-if="!selectedProvinceHasBranch" class="cie-warn">
            ⚠️ Tỉnh này chưa có chi nhánh phụ trách nên chia lead tự động chưa giao cho ai được —
            khách vừa nhập hiện chỉ quản lý nhìn thấy.
          </div>
          <div class="cie-result-actions">
            <button class="cie-btn cie-btn-ghost" :disabled="undoing" @click="onUndo">
              {{ undoing ? 'Đang hoàn tác…' : '↩️ Hoàn tác lần nhập này' }}
            </button>
            <button class="cie-btn cie-btn-primary" @click="close">Xong</button>
          </div>
        </div>

        <template v-else>
          <!-- ───────── BƯỚC 1: tỉnh + file ───────── -->
          <div class="cie-field">
            <label class="cie-label">Tỉnh/thành của danh sách này <span class="cie-req">*</span></label>
            <input
              class="cie-input"
              v-model="province"
              list="cie-province-list"
              placeholder="VD: Hà Nội"
              @change="onProvinceChange"
            />
            <datalist id="cie-province-list">
              <option v-for="p in provinces" :key="p.name" :value="p.name">
                {{ p.hasBranch ? 'có chi nhánh' : 'chưa có chi nhánh' }}
              </option>
            </datalist>
            <div v-if="province && !selectedProvinceHasBranch" class="cie-warn">
              ⚠️ Tỉnh này chưa có chi nhánh phụ trách. Khách nhập vào sẽ chưa được chia cho sale nào
              cho tới khi lập chi nhánh cho tỉnh.
            </div>
            <div v-else class="cie-hint">
              Tất cả khách trong file sẽ mang tỉnh này, và nguồn khách là “Nhập Excel: {{ province || '…' }}”.
            </div>
          </div>

          <div class="cie-field">
            <label class="cie-label">File danh sách <span class="cie-req">*</span></label>
            <div
              class="cie-dropzone"
              :class="{ 'is-loaded': !!sheet }"
              @click="filePicker?.click()"
              @dragover.prevent
              @drop.prevent="onDrop"
            >
              <template v-if="sheet">
                <div class="cie-file-name">📄 {{ fileName }}</div>
                <div class="cie-file-meta">{{ sheet.rows.length }} dòng dữ liệu · {{ sheet.headers.length }} cột</div>
                <button class="cie-link" @click.stop="resetFile">Chọn file khác</button>
              </template>
              <template v-else>
                <div class="cie-drop-ico">⬆️</div>
                <div>Bấm để chọn hoặc kéo file vào đây</div>
                <div class="cie-file-meta">.xlsx hoặc .csv — tối đa 2.000 dòng</div>
              </template>
            </div>
            <input
              ref="filePicker"
              type="file"
              accept=".xlsx,.csv"
              hidden
              @change="onFilePicked"
            />
            <div v-if="fileError" class="cie-error">{{ fileError }}</div>
          </div>

          <!-- ───────── BƯỚC 2: xem trước ───────── -->
          <div v-if="sheet" class="cie-field">
            <label class="cie-label">Máy đã đoán các cột — sai thì chọn lại</label>
            <div class="cie-map-row">
              <div v-for="f in FIELDS" :key="f.key" class="cie-map-item">
                <span class="cie-map-name">{{ f.label }}</span>
                <select class="cie-select" :value="columns[f.key]" @change="onColumnChange(f.key, $event)">
                  <option :value="null">— không có —</option>
                  <option v-for="(h, i) in sheet.headers" :key="i" :value="i">{{ h }}</option>
                </select>
              </div>
            </div>
            <div v-if="columns.phone === null" class="cie-error">
              Phải chỉ ra cột số điện thoại — đây là thứ nhận diện khách.
            </div>
          </div>

          <div v-if="preview" class="cie-field">
            <label class="cie-label">5 dòng đầu sau khi đọc</label>
            <div class="cie-table-wrap">
              <table class="cie-table">
                <thead>
                  <tr><th>Dòng</th><th>Họ tên</th><th>Ngày sinh</th><th>SĐT</th></tr>
                </thead>
                <tbody>
                  <tr v-for="r in preview.sample" :key="r.rowNumber">
                    <td class="cie-dim">{{ r.rowNumber }}</td>
                    <td>{{ r.fullName || '—' }}</td>
                    <td>{{ r.birthDate || r.birthYear || '—' }}</td>
                    <td>{{ r.phone }}</td>
                  </tr>
                  <tr v-if="!preview.sample.length">
                    <td colspan="4" class="cie-dim">Không có dòng nào hợp lệ.</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="cie-stats">
              <span class="cie-stat cie-stat-ok">{{ preview.stats.willCreate }} sẽ thêm mới</span>
              <span v-if="preview.stats.duplicateInCrm" class="cie-stat">{{ preview.stats.duplicateInCrm }} đã có trong CRM</span>
              <span v-if="preview.stats.duplicateInFile" class="cie-stat">{{ preview.stats.duplicateInFile }} trùng trong file</span>
              <span v-if="preview.stats.invalid" class="cie-stat cie-stat-bad">{{ preview.stats.invalid }} dòng lỗi</span>
            </div>
            <div v-if="preview.invalidRows.length" class="cie-hint">
              Dòng lỗi: {{ invalidRowsText }}
            </div>
          </div>

          <!-- ───────── Lịch sử: hoàn tác được cả lần nhập trước ───────── -->
          <div v-if="batches.length" class="cie-history">
            <button class="cie-history-toggle" @click="showHistory = !showHistory">
              {{ showHistory ? '▾' : '▸' }} Lịch sử nhập gần đây ({{ batches.length }})
            </button>
            <table v-if="showHistory" class="cie-table cie-history-table">
              <tbody>
                <tr v-for="b in batches" :key="b.id">
                  <td>
                    <div>{{ b.province }} · {{ b.createdCount }} khách</div>
                    <div class="cie-dim">{{ b.fileName }} — {{ formatDate(b.createdAt) }}</div>
                  </td>
                  <td class="cie-history-act">
                    <span v-if="b.undoneAt" class="cie-dim">đã hoàn tác ({{ b.undoneCount }})</span>
                    <button v-else class="cie-link" :disabled="undoing" @click="onUndoBatch(b.id)">Hoàn tác</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>

      <div v-if="!result" class="cie-foot">
        <button class="cie-btn cie-btn-ghost" @click="close">Huỷ</button>
        <button class="cie-btn cie-btn-primary" :disabled="!canSubmit" @click="onSubmit">
          {{ importing ? 'Đang nhập…' : `Nhập ${preview?.stats.willCreate ?? 0} khách` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { readSheetFile, SheetReadError, type SheetData } from '@/utils/sheet-reader';
import {
  useContactImport,
  errorText,
  type ImportColumns,
  type ImportPreview,
  type ImportResult,
  type ProvinceOption,
  type ImportBatch,
} from '@/composables/use-contact-import';
import { useToast } from '@/composables/use-toast';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'imported'): void;
}>();

const toast = useToast();
const { importing, fetchProvinces, preview: callPreview, runImport, undoImport, fetchBatches } = useContactImport();

const FIELDS = [
  { key: 'fullName' as const, label: 'Họ tên' },
  { key: 'birth' as const, label: 'Ngày sinh' },
  { key: 'phone' as const, label: 'SĐT' },
];

const province = ref('');
const provinces = ref<ProvinceOption[]>([]);
const filePicker = ref<HTMLInputElement | null>(null);
const fileName = ref('');
const fileError = ref<string | null>(null);
const sheet = ref<SheetData | null>(null);
const columns = ref<ImportColumns>({ fullName: null, birth: null, phone: null });
const preview = ref<ImportPreview | null>(null);
const result = ref<ImportResult | null>(null);
const undoing = ref(false);
const batches = ref<ImportBatch[]>([]);
const showHistory = ref(false);

/**
 * Tỉnh chưa có chi nhánh vẫn nhập được (có thể đang chuẩn bị mở), chỉ cảnh báo. Tỉnh
 * chưa gõ gì thì coi như "có" để không doạ người dùng ngay khi hộp thoại vừa mở.
 */
const selectedProvinceHasBranch = computed(() => {
  const p = province.value.trim();
  if (!p) return true;
  const found = provinces.value.find((x) => normalizeVi(x.name) === normalizeVi(p));
  return found ? found.hasBranch : false;
});

function normalizeVi(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '');
}

const canSubmit = computed(
  () => !!province.value.trim() && !!sheet.value && columns.value.phone !== null
    && !!preview.value && preview.value.stats.willCreate > 0 && !importing.value,
);

const invalidRowsText = computed(() => {
  if (!preview.value) return '';
  const rows = preview.value.invalidRows;
  const text = rows.map((r) => r.rowNumber).join(', ');
  return rows.length >= 50 ? `${text}…` : text;
});

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    resetAll();
    try {
      provinces.value = await fetchProvinces();
    } catch {
      // Không lấy được danh mục thì vẫn gõ tay được — không chặn luồng vì một ô gợi ý.
    }
    await loadBatches();
  },
);

function resetAll() {
  province.value = '';
  fileName.value = '';
  fileError.value = null;
  sheet.value = null;
  columns.value = { fullName: null, birth: null, phone: null };
  preview.value = null;
  result.value = null;
}

function resetFile() {
  fileName.value = '';
  sheet.value = null;
  preview.value = null;
  columns.value = { fullName: null, birth: null, phone: null };
  if (filePicker.value) filePicker.value.value = '';
}

function close() {
  emit('update:modelValue', false);
}

function onProvinceChange() {
  province.value = province.value.replace(/\s+/g, ' ').trim();
}

async function onDrop(ev: DragEvent) {
  const file = ev.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
}

async function onFilePicked(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (file) await loadFile(file);
}

/** Trần kích thước file — vài trăm dòng chỉ vài chục KB; file to hơn thế gần như chắc
 * chắn là nhầm file, mà đọc nó ngay trên trình duyệt thì treo cả tab. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

async function loadFile(file: File) {
  fileError.value = null;
  if (file.size > MAX_FILE_BYTES) {
    fileError.value = 'File lớn hơn 10MB — kiểm tra lại có đúng file danh sách không.';
    return;
  }
  try {
    const data = await readSheetFile(file);
    sheet.value = data;
    fileName.value = file.name;
    // Lần đầu để backend đoán cột (columns = null), các lần sau gửi lựa chọn của người dùng.
    columns.value = { fullName: null, birth: null, phone: null };
    await refreshPreview(true);
  } catch (err) {
    sheet.value = null;
    fileError.value = err instanceof SheetReadError ? err.message : 'Không đọc được file.';
  }
}

function onColumnChange(key: keyof ImportColumns, ev: Event) {
  const raw = (ev.target as HTMLSelectElement).value;
  columns.value = { ...columns.value, [key]: raw === '' || raw === 'null' ? null : Number(raw) };
  void refreshPreview(false);
}

/**
 * Gọi lại bước xem trước. `useGuess` = để backend tự đoán cột (lần đầu mở file); các
 * lần sau gửi đúng lựa chọn đang hiện trên màn hình, kể cả ô người dùng cố ý bỏ trống.
 */
async function refreshPreview(useGuess: boolean) {
  if (!sheet.value) return;
  try {
    const res = await callPreview({
      headers: sheet.value.headers,
      rows: sheet.value.rows,
      rowNumbers: sheet.value.rowNumbers,
      hasHeaderRow: sheet.value.hasHeaderRow,
      columns: useGuess ? null : columns.value,
    });
    preview.value = res;
    if (useGuess) columns.value = res.columns;
  } catch (err) {
    preview.value = null;
    fileError.value = errorText(err);
  }
}

async function onSubmit() {
  if (!canSubmit.value || !sheet.value) return;
  try {
    result.value = await runImport({
      province: province.value.trim(),
      fileName: fileName.value,
      headers: sheet.value.headers,
      rows: sheet.value.rows,
      rowNumbers: sheet.value.rowNumbers,
      hasHeaderRow: sheet.value.hasHeaderRow,
      columns: columns.value,
    });
    emit('imported');
  } catch (err) {
    toast.error(errorText(err));
  }
}

async function loadBatches() {
  try {
    batches.value = await fetchBatches();
  } catch {
    batches.value = [];
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/**
 * Hoàn tác một lô cũ trong lịch sử. Tách khỏi onUndo (lô vừa nhập xong) vì ở đây phải
 * nạp lại danh sách chứ không đóng hộp thoại — người dùng thường mở lịch sử ra để dọn
 * vài lô liền nhau.
 */
async function onUndoBatch(batchId: string) {
  undoing.value = true;
  try {
    const res = await undoImport(batchId);
    toast.success(
      res.kept > 0
        ? `Đã xoá ${res.deleted} khách. Giữ lại ${res.kept} khách đã phát sinh dữ liệu.`
        : `Đã xoá ${res.deleted} khách của lần nhập đó.`,
    );
    await loadBatches();
    emit('imported');
  } catch (err) {
    toast.error(errorText(err));
  } finally {
    undoing.value = false;
  }
}

async function onUndo() {
  if (!result.value) return;
  undoing.value = true;
  try {
    const res = await undoImport(result.value.batchId);
    toast.success(
      res.kept > 0
        ? `Đã xoá ${res.deleted} khách. Giữ lại ${res.kept} khách đã phát sinh dữ liệu.`
        : `Đã xoá ${res.deleted} khách vừa nhập.`,
    );
    emit('imported');
    close();
  } catch (err) {
    toast.error(errorText(err));
  } finally {
    undoing.value = false;
  }
}
</script>

<style scoped>
.cie-overlay {
  position: fixed; inset: 0; z-index: 1200;
  background: rgba(15, 23, 42, 0.45);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.cie-modal {
  background: #fff; border-radius: 14px; width: 100%; max-width: 680px;
  max-height: 90vh; display: flex; flex-direction: column;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.25);
}
.cie-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid #e8ecf1;
}
.cie-title { margin: 0; font-size: 16px; font-weight: 700; color: #1f2937; }
.cie-x { border: 0; background: transparent; font-size: 16px; cursor: pointer; color: #6b7280; }
.cie-body { padding: 16px 20px; overflow-y: auto; }
.cie-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 20px; border-top: 1px solid #e8ecf1;
}

.cie-field { margin-bottom: 16px; }
.cie-label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
.cie-req { color: #dc2626; }
.cie-hint { font-size: 12px; color: #6b7280; margin-top: 6px; }
.cie-error { font-size: 12px; color: #dc2626; margin-top: 6px; }
.cie-warn {
  font-size: 12px; color: #92400e; background: #fffbeb;
  border: 1px solid #fde68a; border-radius: 8px; padding: 8px 10px; margin-top: 6px;
}

.cie-input, .cie-select {
  width: 100%; border: 1px solid #d7dee7; border-radius: 8px;
  padding: 8px 10px; font-size: 14px; color: #111827; background: #fff;
}
.cie-input:focus, .cie-select:focus { outline: none; border-color: #2563eb; }

.cie-dropzone {
  border: 2px dashed #cbd5e1; border-radius: 10px; padding: 20px;
  text-align: center; cursor: pointer; color: #475569; background: #f8fafc;
}
.cie-dropzone.is-loaded { border-style: solid; border-color: #86efac; background: #f0fdf4; }
.cie-drop-ico { font-size: 22px; margin-bottom: 4px; }
.cie-file-name { font-weight: 600; color: #166534; }
.cie-file-meta { font-size: 12px; color: #6b7280; margin-top: 2px; }
.cie-link { background: none; border: 0; color: #2563eb; cursor: pointer; font-size: 12px; margin-top: 6px; }

.cie-map-row { display: flex; gap: 10px; flex-wrap: wrap; }
.cie-map-item { flex: 1 1 170px; }
.cie-map-name { display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px; }

.cie-table-wrap { overflow-x: auto; border: 1px solid #e8ecf1; border-radius: 8px; }
.cie-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cie-table th, .cie-table td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #f1f5f9; white-space: nowrap; }
.cie-table th { background: #f8fafc; font-weight: 600; color: #475569; font-size: 12px; }
.cie-dim { color: #9ca3af; }

.cie-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.cie-stat {
  font-size: 12px; padding: 3px 9px; border-radius: 999px;
  background: #f1f5f9; color: #475569;
}
.cie-stat-ok { background: #dcfce7; color: #166534; }
.cie-stat-bad { background: #fee2e2; color: #991b1b; }

.cie-btn {
  border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600;
  cursor: pointer; border: 1px solid transparent;
}
.cie-btn-primary { background: #2563eb; color: #fff; }
.cie-btn-primary:disabled { background: #cbd5e1; cursor: not-allowed; }
.cie-btn-ghost { background: #fff; color: #475569; border-color: #d7dee7; }

.cie-result { text-align: center; padding: 12px 0; }
.cie-result-big { font-size: 18px; font-weight: 700; color: #166534; margin-bottom: 10px; }
.cie-result-list { list-style: none; padding: 0; margin: 0 0 12px; font-size: 13px; color: #475569; }
.cie-result-list li { margin-bottom: 3px; }
.cie-result-actions { display: flex; justify-content: center; gap: 8px; margin-top: 14px; }

.cie-history { border-top: 1px solid #eef2f7; padding-top: 10px; }
.cie-history-toggle {
  background: none; border: 0; cursor: pointer; padding: 0;
  font-size: 12px; font-weight: 600; color: #475569;
}
.cie-history-table { margin-top: 8px; font-size: 12px; }
.cie-history-act { text-align: right; white-space: nowrap; }
</style>
