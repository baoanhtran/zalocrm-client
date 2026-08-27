<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<!--
  MessageTemplatesPage — Cài đặt → Mẫu tin nhắn.

  Sale soạn sẵn câu trả lời hay dùng, rồi gõ "/" trong khung chat để chèn
  (quick-template-popup.vue). Trang này là chỗ tạo/sửa/xoá + xếp thư mục.

  Định dạng đậm/màu dùng chung RichTextEditor với ô chat → mẫu hiện lên đúng y
  như lúc gửi sang Zalo, không cần gõ markup tay.

  API /api/v1/automation/templates* (resource RBAC 'block'):
    - mẫu RIÊNG của mình: ai cũng tạo/sửa/xoá được
    - đăng CÔNG KHAI cho cả tổ chức: cần quyền block.create
-->
<template>
  <div class="mt">
    <header class="mt-head">
      <div class="mt-ico">💬</div>
      <div>
        <h1 class="mt-h1">Mẫu tin nhắn</h1>
        <p class="mt-sub">
          Soạn sẵn câu hay dùng, khi chat chỉ cần gõ <code>/</code> rồi chọn — hoặc gõ đúng
          từ khoá tắt để nhảy thẳng tới mẫu. Mẫu <b>Riêng tư</b> chỉ mình thấy,
          mẫu <b>Công khai</b> cả tổ chức dùng chung.
        </p>
      </div>
      <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" class="mt-new" @click="openCreate()">
        Tạo mẫu
      </v-btn>
    </header>

    <div class="mt-body">
      <!-- ─── Cột trái: thư mục ─────────────────────────────────────────── -->
      <aside class="mt-side">
        <div class="mt-side-head">
          <span>Thư mục</span>
          <button class="mt-side-add" title="Tạo thư mục" @click="openFolderCreate()">
            <v-icon size="16">mdi-folder-plus-outline</v-icon>
          </button>
        </div>

        <button class="mt-folder" :class="{ active: selectedFolder === 'all' }" @click="selectedFolder = 'all'">
          <v-icon size="16">mdi-inbox-multiple-outline</v-icon>
          <span class="mt-folder-name">Tất cả</span>
          <span class="mt-folder-count">{{ templates.length }}</span>
        </button>

        <button class="mt-folder" :class="{ active: selectedFolder === 'root' }" @click="selectedFolder = 'root'">
          <v-icon size="16">mdi-file-outline</v-icon>
          <span class="mt-folder-name">Chưa xếp thư mục</span>
          <span class="mt-folder-count">{{ rootCount }}</span>
        </button>

        <div class="mt-side-sep">Thư mục</div>

        <div v-if="!folders.length" class="mt-side-empty">Chưa có thư mục nào</div>

        <button
          v-for="f in folders"
          :key="f.id"
          class="mt-folder"
          :class="{ active: selectedFolder === f.id }"
          @click="selectedFolder = f.id"
        >
          <v-icon size="16" :color="f.visibility === 'public' ? '#1786be' : '#9ca3af'">
            {{ f.visibility === 'public' ? 'mdi-folder-account-outline' : 'mdi-folder-lock-outline' }}
          </v-icon>
          <span class="mt-folder-name">{{ f.name }}</span>
          <span class="mt-folder-count">{{ f._count?.templates ?? 0 }}</span>
          <span class="mt-folder-acts">
            <v-icon size="14" title="Sửa thư mục" @click.stop="openFolderEdit(f)">mdi-pencil-outline</v-icon>
            <v-icon size="14" title="Xoá thư mục" @click.stop="onDeleteFolder(f)">mdi-trash-can-outline</v-icon>
          </span>
        </button>
      </aside>

      <!-- ─── Cột phải: danh sách mẫu ───────────────────────────────────── -->
      <section class="mt-main">
        <div class="mt-toolbar">
          <v-text-field
            v-model="search"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            placeholder="Tìm theo tên, nội dung hoặc từ khoá tắt…"
            prepend-inner-icon="mdi-magnify"
            class="mt-search"
          />
          <v-btn-toggle v-model="visFilter" density="compact" variant="outlined" divided mandatory class="mt-vis">
            <v-btn value="all" size="small">Tất cả</v-btn>
            <v-btn value="public" size="small">Công khai</v-btn>
            <v-btn value="private" size="small">Riêng tư</v-btn>
          </v-btn-toggle>
        </div>

        <div v-if="allTags.length" class="mt-tagbar">
          <button class="mt-tag" :class="{ active: !tagFilter }" @click="tagFilter = ''">Mọi nhãn</button>
          <button
            v-for="t in allTags"
            :key="t"
            class="mt-tag"
            :class="{ active: tagFilter === t }"
            @click="tagFilter = tagFilter === t ? '' : t"
          >
            {{ t }}
          </button>
        </div>

        <div v-if="loading" class="mt-loading">Đang tải mẫu tin nhắn…</div>

        <div v-else-if="!filtered.length" class="mt-empty">
          <v-icon size="40" color="#cbd5e1">mdi-message-flash-outline</v-icon>
          <p v-if="templates.length">Không có mẫu nào khớp bộ lọc.</p>
          <p v-else>
            Chưa có mẫu nào. Bấm <b>Tạo mẫu</b> để soạn câu đầu tiên —
            ví dụ câu chào, báo giá, hoặc câu trả lời hay bị hỏi đi hỏi lại.
          </p>
        </div>

        <ul v-else class="mt-list">
          <li v-for="tpl in filtered" :key="tpl.id" class="mt-item">
            <div class="mt-item-main">
              <div class="mt-item-top">
                <span class="mt-item-name">{{ tpl.name }}</span>
                <span v-if="tpl.shortcut" class="mt-item-sc">/{{ tpl.shortcut }}</span>
                <span class="mt-badge" :class="tpl.visibility === 'public' ? 'pub' : 'priv'">
                  <v-icon size="12">{{ tpl.visibility === 'public' ? 'mdi-account-group' : 'mdi-lock-outline' }}</v-icon>
                  {{ tpl.visibility === 'public' ? 'Công khai' : 'Riêng tư' }}
                </span>
              </div>
              <p class="mt-item-body">{{ previewOf(tpl) }}</p>
              <div v-if="(tpl.tagIds || []).length" class="mt-item-tags">
                <span v-for="t in tpl.tagIds" :key="t" class="mt-item-tag">{{ t }}</span>
              </div>
            </div>

            <div class="mt-item-side">
              <span v-if="tpl.manualSendCount" class="mt-item-uses" title="Số lần đã chèn vào chat">
                <v-icon size="13">mdi-send-outline</v-icon> {{ tpl.manualSendCount }}
              </span>
              <button class="mt-act" title="Sửa" @click="openEdit(tpl)">
                <v-icon size="17">mdi-pencil-outline</v-icon>
              </button>
              <button class="mt-act danger" title="Xoá" @click="onDelete(tpl)">
                <v-icon size="17">mdi-trash-can-outline</v-icon>
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>

    <!-- ─── Dialog soạn mẫu ─────────────────────────────────────────────── -->
    <v-dialog v-model="dialog" max-width="760" persistent>
      <div class="mt-dlg">
        <div class="mt-dlg-head">
          <h2>{{ editingId ? 'Sửa mẫu tin nhắn' : 'Tạo mẫu tin nhắn' }}</h2>
          <button class="mt-dlg-x" @click="dialog = false"><v-icon size="20">mdi-close</v-icon></button>
        </div>

        <div class="mt-dlg-body">
          <div class="mt-dlg-grid">
            <label class="mt-field">
              <span class="mt-label">Tên mẫu <b class="req">*</b></span>
              <v-text-field
                v-model="form.name" density="compact" variant="outlined" hide-details
                placeholder="VD: Chào khách mới"
              />
            </label>

            <label class="mt-field">
              <span class="mt-label">Từ khoá gõ tắt</span>
              <v-text-field
                v-model="form.shortcut" density="compact" variant="outlined" hide-details
                prefix="/" placeholder="chaokhach"
              />
              <span class="mt-hint">
                Gõ <code>/{{ shortcutPreview || 'chaokhach' }}</code> trong chat là nhảy thẳng tới mẫu này.
                Bỏ trống cũng không sao.
              </span>
            </label>

            <label class="mt-field">
              <span class="mt-label">Thư mục</span>
              <v-select
                v-model="form.folderId" :items="folderOptions" item-title="title" item-value="value"
                density="compact" variant="outlined" hide-details
              />
              <span class="mt-hint">Mẫu nằm trong thư mục sẽ theo chế độ riêng/công khai của thư mục.</span>
            </label>

            <label class="mt-field">
              <span class="mt-label">Ai được dùng</span>
              <v-select
                v-model="form.visibility" :items="visibilityOptions" item-title="title" item-value="value"
                :disabled="!!form.folderId" density="compact" variant="outlined" hide-details
              />
              <span v-if="form.folderId" class="mt-hint">Đang theo thư mục đã chọn.</span>
              <span v-else-if="!canPublish" class="mt-hint warn">
                Bạn chỉ đăng được mẫu riêng tư. Muốn đăng công khai cho cả tổ chức thì nhờ quản lý cấp quyền.
              </span>
            </label>

            <label class="mt-field">
              <span class="mt-label">Nhãn</span>
              <v-combobox
                v-model="form.tagIds" :items="allTags" multiple chips closable-chips
                density="compact" variant="outlined" hide-details placeholder="Gõ rồi Enter để thêm"
              />
              <span class="mt-hint">Dùng để lọc nhanh khi danh sách mẫu dài (VD tên dự án).</span>
            </label>
          </div>

          <div class="mt-field mt-editor-field">
            <span class="mt-label">Nội dung <b class="req">*</b></span>
            <RichTextEditor
              ref="editorRef"
              :model-value="form.text"
              :show-toolbar="true"
              :submit-on-enter="false"
              placeholder="Soạn nội dung mẫu… bôi đậm / đổi màu như khi chat"
              class="mt-editor"
              @update:model-value="onEditorInput"
            />

            <div class="mt-var-bar">
              <span class="mt-var-lbl"><v-icon size="13">mdi-cursor-text</v-icon> Chèn biến tại con trỏ:</span>
              <button
                v-for="v in TEMPLATE_VARIABLES"
                :key="v.code"
                class="mt-var"
                :title="`${v.label} — ví dụ: ${v.example}`"
                @click="insertVar(v.code)"
              >
                {{ v.label }}
              </button>
            </div>
            <span class="mt-hint">
              Biến được thay bằng dữ liệu khách ngay lúc chèn vào ô chat, nên trước khi bấm gửi
              bạn vẫn đọc lại được câu hoàn chỉnh.
            </span>
          </div>
        </div>

        <div class="mt-dlg-foot">
          <span v-if="formError" class="mt-dlg-err">{{ formError }}</span>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">Huỷ</v-btn>
          <v-btn color="primary" variant="flat" :loading="saving" @click="onSave">
            {{ editingId ? 'Lưu' : 'Tạo mẫu' }}
          </v-btn>
        </div>
      </div>
    </v-dialog>

    <!-- ─── Dialog thư mục ──────────────────────────────────────────────── -->
    <v-dialog v-model="folderDialog" max-width="420">
      <div class="mt-dlg">
        <div class="mt-dlg-head">
          <h2>{{ folderForm.id ? 'Sửa thư mục' : 'Tạo thư mục' }}</h2>
          <button class="mt-dlg-x" @click="folderDialog = false"><v-icon size="20">mdi-close</v-icon></button>
        </div>
        <div class="mt-dlg-body">
          <label class="mt-field">
            <span class="mt-label">Tên thư mục <b class="req">*</b></span>
            <v-text-field v-model="folderForm.name" density="compact" variant="outlined" hide-details
              placeholder="VD: Câu chào" />
          </label>
          <label class="mt-field">
            <span class="mt-label">Ai được dùng</span>
            <v-select v-model="folderForm.visibility" :items="visibilityOptions"
              item-title="title" item-value="value" density="compact" variant="outlined" hide-details />
            <span class="mt-hint">Mọi mẫu trong thư mục đi theo lựa chọn này.</span>
          </label>
        </div>
        <div class="mt-dlg-foot">
          <v-spacer />
          <v-btn variant="text" @click="folderDialog = false">Huỷ</v-btn>
          <v-btn color="primary" variant="flat" :loading="savingFolder" @click="onSaveFolder">Lưu</v-btn>
        </div>
      </div>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick } from 'vue';
import RichTextEditor from '@/components/chat/rich-text-editor.vue';
import { TEMPLATE_VARIABLES } from '@/constants/template-variables';
import { useMessageTemplates, type MessageTemplate, type MessageTemplateFolder } from '@/composables/use-message-templates';
import { useToast } from '@/composables/use-toast';
import { useConfirm } from '@/composables/use-confirm';
import { useAuthStore } from '@/stores/auth';

const toast = useToast();
const { confirm } = useConfirm();
const auth = useAuthStore();

const {
  templates, folders, loading, saving,
  fetchTemplates, fetchFolders,
  createTemplate, updateTemplate, deleteTemplate,
  createFolder, updateFolder, deleteFolder,
} = useMessageTemplates();

/** Chỉ người có block.create mới đăng được mẫu dùng chung cả tổ chức. */
const canPublish = computed(() => auth.canAccess('block', 'create'));

// ── Bộ lọc ────────────────────────────────────────────────────────────────
const selectedFolder = ref<string>('all');
const search = ref('');
const visFilter = ref<'all' | 'public' | 'private'>('all');
const tagFilter = ref('');

const rootCount = computed(() => templates.value.filter((t) => !t.folderId).length);

/** Nhãn lấy động từ chính dữ liệu — không hardcode danh sách dự án của khách nào cả. */
const allTags = computed(() => {
  const s = new Set<string>();
  for (const t of templates.value) for (const tag of t.tagIds ?? []) s.add(tag);
  return Array.from(s).sort((a, b) => a.localeCompare(b, 'vi'));
});

function plainOf(tpl: MessageTemplate): string {
  return tpl.contentRich?.text ?? tpl.content ?? '';
}

function previewOf(tpl: MessageTemplate): string {
  const s = plainOf(tpl).replace(/\s+/g, ' ').trim();
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return templates.value.filter((t) => {
    if (selectedFolder.value === 'root' && t.folderId) return false;
    if (selectedFolder.value !== 'all' && selectedFolder.value !== 'root' && t.folderId !== selectedFolder.value) return false;
    if (visFilter.value !== 'all' && (t.visibility ?? 'private') !== visFilter.value) return false;
    if (tagFilter.value && !(t.tagIds ?? []).includes(tagFilter.value)) return false;
    if (q) {
      const hay = `${t.name} ${t.shortcut ?? ''} ${plainOf(t)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});

// ── Dialog mẫu ────────────────────────────────────────────────────────────
interface EditorApi {
  insertText: (text: string) => void;
  getRichPayload: () => { text: string; styles: Array<{ st: string; start: number; len: number }> };
  applyRichPayload: (p: { text: string; styles?: Array<{ st: string; start: number; len: number }> }, opts?: { focus?: boolean }) => void;
}
const editorRef = ref<EditorApi | null>(null);

const dialog = ref(false);
const editingId = ref<string | null>(null);
const formError = ref('');

const form = reactive({
  name: '',
  shortcut: '',
  folderId: '' as string,
  visibility: 'private' as 'public' | 'private',
  tagIds: [] as string[],
  text: '',
  styles: [] as Array<{ st: string; start: number; len: number }>,
});

/** Preview từ khoá tắt — chuẩn hoá y hệt backend để người dùng thấy trước cái sẽ lưu. */
const shortcutPreview = computed(() =>
  form.shortcut
    .trim().replace(/^\/+/, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '').toLowerCase().replace(/[^a-z0-9_-]/g, ''),
);

const folderOptions = computed(() => [
  { title: 'Không xếp thư mục', value: '' },
  ...folders.value.map((f) => ({
    title: `${f.name} (${f.visibility === 'public' ? 'công khai' : 'riêng tư'})`,
    value: f.id,
  })),
]);

const visibilityOptions = computed(() => [
  { title: 'Riêng tư — chỉ mình tôi', value: 'private' },
  { title: 'Công khai — cả tổ chức', value: 'public', props: { disabled: !canPublish.value } },
]);

function resetForm() {
  form.name = '';
  form.shortcut = '';
  form.folderId = '';
  form.visibility = 'private';
  form.tagIds = [];
  form.text = '';
  form.styles = [];
  formError.value = '';
}

async function openCreate() {
  resetForm();
  editingId.value = null;
  // Đang đứng trong một thư mục cụ thể → mẫu mới rơi luôn vào thư mục đó.
  if (selectedFolder.value !== 'all' && selectedFolder.value !== 'root') form.folderId = selectedFolder.value;
  dialog.value = true;
  await nextTick();
  editorRef.value?.applyRichPayload({ text: '', styles: [] });
}

async function openEdit(tpl: MessageTemplate) {
  resetForm();
  editingId.value = tpl.id;
  form.name = tpl.name;
  form.shortcut = tpl.shortcut ?? '';
  form.folderId = tpl.folderId ?? '';
  form.visibility = (tpl.visibility ?? 'private') as 'public' | 'private';
  form.tagIds = [...(tpl.tagIds ?? [])];
  form.text = plainOf(tpl);
  form.styles = tpl.contentRich?.styles ?? [];
  dialog.value = true;
  // Chờ dialog + editor mount xong mới nạp nội dung, nếu không setContent rơi vào hư không.
  await nextTick();
  editorRef.value?.applyRichPayload({ text: form.text, styles: form.styles });
}

/** Editor phát text thô; đọc lại rich payload để giữ đậm/màu đúng offset. */
function onEditorInput() {
  const payload = editorRef.value?.getRichPayload();
  if (!payload) return;
  form.text = payload.text;
  form.styles = payload.styles ?? [];
}

function insertVar(code: string) {
  editorRef.value?.insertText(code);
  onEditorInput();
}

async function onSave() {
  formError.value = '';
  if (!form.name.trim()) { formError.value = 'Chưa nhập tên mẫu.'; return; }
  onEditorInput();
  if (!form.text.trim()) { formError.value = 'Nội dung mẫu đang trống.'; return; }

  const payload = {
    name: form.name.trim(),
    shortcut: form.shortcut.trim() || null,
    folderId: form.folderId || null,
    visibility: form.visibility,
    tagIds: form.tagIds,
    contentRich: { text: form.text, styles: form.styles },
  };

  try {
    if (editingId.value) {
      await updateTemplate(editingId.value, payload);
      toast.success('Đã lưu mẫu tin nhắn');
    } else {
      await createTemplate(payload);
      toast.success('Đã tạo mẫu tin nhắn');
    }
    dialog.value = false;
    await reload();
  } catch (e: any) {
    formError.value = e?.response?.data?.error || 'Không lưu được mẫu, thử lại giúp em.';
  }
}

async function onDelete(tpl: MessageTemplate) {
  const ok = await confirm({
    title: `Xoá mẫu "${tpl.name}"?`,
    message: 'Mẫu sẽ biến mất khỏi popup gõ "/" trong chat. Tin nhắn đã gửi không bị ảnh hưởng.',
    tone: 'danger',
    confirmText: 'Xoá mẫu',
  });
  if (!ok) return;
  try {
    await deleteTemplate(tpl.id);
    toast.success('Đã xoá mẫu');
    await reload();
  } catch (e: any) {
    toast.error(e?.response?.data?.error || 'Không xoá được mẫu');
  }
}

// ── Dialog thư mục ────────────────────────────────────────────────────────
const folderDialog = ref(false);
const savingFolder = ref(false);
const folderForm = reactive({ id: '' as string, name: '', visibility: 'public' as 'public' | 'private' });

function openFolderCreate() {
  folderForm.id = '';
  folderForm.name = '';
  folderForm.visibility = canPublish.value ? 'public' : 'private';
  folderDialog.value = true;
}

function openFolderEdit(f: MessageTemplateFolder) {
  folderForm.id = f.id;
  folderForm.name = f.name;
  folderForm.visibility = f.visibility;
  folderDialog.value = true;
}

async function onSaveFolder() {
  if (!folderForm.name.trim()) { toast.error('Chưa nhập tên thư mục'); return; }
  savingFolder.value = true;
  try {
    if (folderForm.id) {
      await updateFolder(folderForm.id, { name: folderForm.name.trim(), visibility: folderForm.visibility });
    } else {
      await createFolder({ name: folderForm.name.trim(), visibility: folderForm.visibility });
    }
    folderDialog.value = false;
    toast.success('Đã lưu thư mục');
    await reload();
  } catch (e: any) {
    toast.error(e?.response?.data?.error || 'Không lưu được thư mục');
  } finally {
    savingFolder.value = false;
  }
}

async function onDeleteFolder(f: MessageTemplateFolder) {
  const count = f._count?.templates ?? 0;
  const ok = await confirm({
    title: `Xoá thư mục "${f.name}"?`,
    message: count
      ? `Thư mục còn ${count} mẫu. Xoá thư mục thì các mẫu này chuyển sang "Chưa xếp thư mục" và thành riêng tư — không mẫu nào bị mất.`
      : 'Thư mục đang trống.',
    tone: 'danger',
    confirmText: 'Xoá thư mục',
  });
  if (!ok) return;
  try {
    await deleteFolder(f.id, count > 0);
    if (selectedFolder.value === f.id) selectedFolder.value = 'all';
    toast.success('Đã xoá thư mục');
    await reload();
  } catch (e: any) {
    toast.error(e?.response?.data?.error || 'Không xoá được thư mục');
  }
}

// ── Nạp dữ liệu ───────────────────────────────────────────────────────────
async function reload() {
  await Promise.all([fetchTemplates(), fetchFolders()]);
}

onMounted(async () => {
  try {
    await reload();
  } catch (e: any) {
    toast.error(e?.response?.data?.error || 'Không tải được danh sách mẫu tin nhắn');
  }
});
</script>

<style scoped>
.mt { padding: 4px 2px 40px; }

/* ── Header ── */
.mt-head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 18px; }
.mt-ico { font-size: 26px; line-height: 1; margin-top: 2px; }
.mt-h1 { font-size: 20px; font-weight: 700; color: #0f172a; margin: 0 0 4px; }
.mt-sub { font-size: 13px; color: #64748b; margin: 0; max-width: 720px; line-height: 1.55; }
.mt-sub code { background: #f1f5f9; border-radius: 4px; padding: 0 4px; font-size: 12px; }
.mt-new { margin-left: auto; flex-shrink: 0; }

/* ── Bố cục 2 cột ── */
.mt-body { display: grid; grid-template-columns: 240px 1fr; gap: 18px; align-items: start; }
@media (max-width: 900px) { .mt-body { grid-template-columns: 1fr; } }

/* ── Cột thư mục ── */
.mt-side { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; }
.mt-side-head { display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase;
  letter-spacing: .4px; padding: 2px 4px 8px; }
.mt-side-add { color: #1786be; display: flex; padding: 2px; border-radius: 4px; }
.mt-side-add:hover { background: #e0f2fe; }
.mt-side-sep { font-size: 11px; color: #94a3b8; padding: 10px 4px 4px; }
.mt-side-empty { font-size: 12px; color: #94a3b8; padding: 4px 6px 8px; }

.mt-folder { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 8px;
  border-radius: 7px; font-size: 13px; color: #334155; text-align: left; }
.mt-folder:hover { background: #f1f5f9; }
.mt-folder.active { background: #e0f2fe; color: #0c4a6e; font-weight: 600; }
.mt-folder-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mt-folder-count { font-size: 11px; color: #94a3b8; }
.mt-folder-acts { display: none; gap: 4px; color: #64748b; }
.mt-folder:hover .mt-folder-acts { display: flex; }
.mt-folder-acts .v-icon:hover { color: #dc2626; }

/* ── Danh sách ── */
.mt-main { min-width: 0; }
.mt-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.mt-search { max-width: 420px; }
.mt-vis :deep(.v-btn) { text-transform: none; letter-spacing: 0; }

.mt-tagbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.mt-tag { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid #e2e8f0;
  color: #475569; background: #fff; }
.mt-tag:hover { border-color: #93c5fd; }
.mt-tag.active { background: #1786be; border-color: #1786be; color: #fff; }

.mt-loading { padding: 30px; text-align: center; color: #64748b; font-size: 13px; }
.mt-empty { padding: 46px 20px; text-align: center; color: #64748b; font-size: 13px;
  background: #fff; border: 1px dashed #cbd5e1; border-radius: 10px; }
.mt-empty p { margin: 10px auto 0; max-width: 420px; line-height: 1.6; }

.mt-list { display: flex; flex-direction: column; gap: 8px; }
.mt-item { display: flex; gap: 12px; align-items: flex-start; background: #fff;
  border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; }
.mt-item:hover { border-color: #bae6fd; }
.mt-item-main { flex: 1; min-width: 0; }
.mt-item-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
.mt-item-name { font-size: 14px; font-weight: 600; color: #0f172a; }
.mt-item-sc { font-size: 11.5px; font-family: ui-monospace, monospace; color: #1786be;
  background: #e0f2fe; border-radius: 4px; padding: 1px 6px; }
.mt-badge { display: inline-flex; align-items: center; gap: 3px; font-size: 11px;
  border-radius: 999px; padding: 1px 8px; }
.mt-badge.pub { background: #ecfdf5; color: #047857; }
.mt-badge.priv { background: #f1f5f9; color: #64748b; }
.mt-item-body { font-size: 12.5px; color: #64748b; margin: 0; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; }
.mt-item-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.mt-item-tag { font-size: 11px; color: #475569; background: #f8fafc;
  border: 1px solid #e2e8f0; border-radius: 4px; padding: 0 6px; }

.mt-item-side { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.mt-item-uses { display: inline-flex; align-items: center; gap: 3px; font-size: 11px;
  color: #94a3b8; margin-right: 4px; }
.mt-act { padding: 5px; border-radius: 6px; color: #64748b; display: flex; }
.mt-act:hover { background: #f1f5f9; color: #0f172a; }
.mt-act.danger:hover { background: #fee2e2; color: #dc2626; }

/* ── Dialog ── */
.mt-dlg { background: #fff; border-radius: 12px; overflow: hidden; }
.mt-dlg-head { display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px; border-bottom: 1px solid #e2e8f0; }
.mt-dlg-head h2 { font-size: 16px; font-weight: 700; color: #0f172a; margin: 0; }
.mt-dlg-x { color: #64748b; display: flex; padding: 3px; border-radius: 6px; }
.mt-dlg-x:hover { background: #f1f5f9; }
.mt-dlg-body { padding: 18px; max-height: 66vh; overflow-y: auto; }
/* align-items: start BẮT BUỘC — mặc định grid là stretch, ô nào cùng hàng với ô có
   dòng gợi ý dài sẽ bị kéo cao bằng nó, và .mt-field là flex column nên ô nhập bên
   trong phình ra lấp chỗ trống (ô "Tên mẫu" cao gấp đôi ô "Từ khoá gõ tắt"). */
.mt-dlg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px;
  align-items: start; margin-bottom: 16px; }
@media (max-width: 620px) { .mt-dlg-grid { grid-template-columns: 1fr; } }
.mt-dlg-foot { display: flex; align-items: center; gap: 10px; padding: 12px 18px;
  border-top: 1px solid #e2e8f0; background: #f8fafc; }
.mt-dlg-err { font-size: 12.5px; color: #dc2626; }

.mt-field { display: flex; flex-direction: column; gap: 5px; align-self: start; min-width: 0; }
.mt-field > :deep(.v-input) { flex: none; }
.mt-label { font-size: 12.5px; font-weight: 600; color: #334155; }
.mt-label .req { color: #dc2626; }
.mt-hint { font-size: 11.5px; color: #94a3b8; line-height: 1.5; }
.mt-hint.warn { color: #b45309; }
.mt-hint code { background: #f1f5f9; border-radius: 3px; padding: 0 3px; }

.mt-editor-field { margin-top: 2px; }
.mt-editor { border: 1px solid #cbd5e1; border-radius: 8px; min-height: 170px; }
.mt-var-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 8px; }
.mt-var-lbl { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: #64748b; }
.mt-var { font-size: 11.5px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid #e2e8f0; color: #1786be; background: #f8fafc; }
.mt-var:hover { background: #e0f2fe; border-color: #7dd3fc; }
</style>
