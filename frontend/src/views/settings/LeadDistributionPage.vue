<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<!--
  LeadDistributionPage — Cài đặt "Chia lead tự động" (2026-08-19).
  Cron 07:00 VN chia lead chưa có chủ theo hạn mức, sau N ngày chưa chốt thì thêm
  sale thứ 2 vào chăm cùng, quá hạn nữa thì gắn cờ cho admin.
  API /api/v1/lead-distribution/* (cần quyền settings).
-->
<template>
  <div class="ld">
    <header class="ld-head">
      <div class="ld-ico">🎯</div>
      <div>
        <h1 class="ld-h1">Chia lead tự động</h1>
        <p class="ld-sub">
          Mỗi sáng 07:00, hệ thống chia lead chưa có chủ cho các sale bên dưới theo hạn mức ngày.
          Khách quá hạn mà chưa chốt sẽ được <b>thêm</b> một sale nữa vào chăm cùng —
          không ai bị lấy mất khách.
        </p>
      </div>
    </header>

    <div v-if="loading" class="ld-loading">Đang tải cài đặt…</div>

    <template v-else>
      <section class="ld-card">
        <div class="ld-row">
          <div class="ld-row-text">
            <div class="ld-row-title">Bật chia lead tự động</div>
            <div class="ld-row-desc">
              Đang tắt thì cron không đụng vào dữ liệu. Nút “Xem trước” bên dưới vẫn dùng được
              để thử trước khi bật.
            </div>
          </div>
          <v-switch v-model="form.enabled" color="primary" hide-details density="comfortable" :disabled="!canEdit" />
        </div>
      </section>

      <section class="ld-card">
        <div class="ld-grid">
          <label class="ld-field">
            <span class="ld-label">Mỗi sale nhận tối đa</span>
            <v-text-field v-model.number="form.dailyQuotaPerUser" type="number" :min="0" :max="500"
              suffix="lead/ngày" density="compact" variant="outlined" hide-details :disabled="!canEdit" />
            <span class="ld-hint">Tổng mỗi ngày ≈ số này × số sale đang bật = <b>{{ estimatedDaily }}</b> lead.</span>
          </label>

          <label class="ld-field">
            <span class="ld-label">Thêm sale thứ 2 sau</span>
            <v-text-field v-model.number="form.coAssignAfterDays" type="number" :min="1" :max="365"
              suffix="ngày" density="compact" variant="outlined" hide-details :disabled="!canEdit" />
            <span class="ld-hint">Tính từ lúc lead được giao, riêng từng khách.</span>
          </label>

          <label class="ld-field">
            <span class="ld-label">Gắn cờ báo admin sau</span>
            <v-text-field v-model.number="form.escalateAfterDays" type="number" :min="1" :max="365"
              suffix="ngày" density="compact" variant="outlined" hide-details :disabled="!canEdit" />
            <span class="ld-hint">Gắn nhãn “⏳ Chăm quá hạn”, không thêm sale thứ 3.</span>
          </label>

          <label class="ld-field">
            <span class="ld-label">Bỏ qua lead không có SĐT</span>
            <v-switch v-model="form.requirePhone" color="primary" hide-details density="comfortable" :disabled="!canEdit" />
            <span class="ld-hint">Sale không liên lạc được thì chia cũng vô ích.</span>
          </label>
        </div>

        <div v-if="escalateTooEarly" class="ld-warn">
          <v-icon size="18" color="#b45309">mdi-alert-outline</v-icon>
          <div>
            Mốc gắn cờ (<b>{{ form.escalateAfterDays }}</b> ngày) sớm hơn mốc thêm sale 2
            (<b>{{ form.coAssignAfterDays }}</b> ngày) — khách sẽ bị báo quá hạn trước cả khi có người thứ hai vào chăm.
          </div>
        </div>
      </section>

      <section class="ld-card">
        <div class="ld-row-text" style="margin-bottom: 12px">
          <div class="ld-row-title">Sale trong vòng chia</div>
          <div class="ld-row-desc">
            Tick người nào thì người đó nhận lead. Bỏ tick khi sale nghỉ phép — khách đang chăm vẫn giữ nguyên.
          </div>
        </div>

        <div class="ld-table-wrap">
          <table class="ld-table">
            <thead>
              <tr>
                <th style="width: 88px">Nhận lead</th>
                <th>Sale</th>
                <th style="width: 160px">Chi nhánh</th>
                <th style="width: 150px">Hạn mức riêng</th>
                <th style="width: 120px">Đang ôm</th>
                <th style="width: 120px">Hôm nay</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in members" :key="m.userId">
                <td>
                  <v-switch v-model="m.inPool" color="primary" hide-details density="compact" :disabled="!canEdit" />
                </td>
                <td>
                  <div class="ld-name">{{ m.fullName || m.email }}</div>
                  <div class="ld-email">{{ m.email }}</div>
                </td>
                <td>
                  <span v-if="m.province" class="ld-branch">{{ m.province }}</span>
                  <span v-else class="ld-branch ld-branch-missing" title="Vào Cài đặt › Phòng ban để khai tỉnh cho phòng ban của nhân viên này">
                    chưa có
                  </span>
                </td>
                <td>
                  <v-text-field v-model.number="m.dailyQuota" type="number" :min="0" :max="500"
                    :placeholder="String(form.dailyQuotaPerUser)" density="compact" variant="outlined"
                    hide-details :disabled="!canEdit || !m.inPool" />
                </td>
                <td class="ld-num">{{ m.activeLoad }}</td>
                <td class="ld-num">{{ m.assignedToday }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <v-alert v-if="poolWithoutBranch.length" type="warning" variant="tonal" density="compact"
          class="ld-alert" style="margin-top: 10px">
          {{ poolWithoutBranch.length }} nhân viên đang bật nhận lead nhưng chưa có chi nhánh:
          <strong>{{ poolWithoutBranch.join(', ') }}</strong>.
          Họ sẽ không được chia khách nào cho tới khi phòng ban của họ được khai tỉnh ở
          Cài đặt › Phân quyền › Phòng ban.
        </v-alert>
        <p class="ld-hint" style="margin-top: 10px">
          Bỏ trống hạn mức riêng = dùng mức chung ở trên. “Đang ôm” là số khách chưa chốt.
          Khách chỉ được chia cho nhân viên cùng tỉnh — khách tỉnh chưa có chi nhánh sẽ được
          gắn nhãn “📍 Chưa có chi nhánh” và chờ, không chia bừa sang tỉnh khác.
        </p>
      </section>

      <div class="ld-actions">
        <span v-if="!canEdit" class="ld-noperm">Chỉ chủ tổ chức / quản trị mới chỉnh được.</span>
        <v-btn variant="outlined" :loading="previewing" :disabled="!canEdit" @click="preview">Xem trước hôm nay</v-btn>
        <v-btn color="primary" :loading="saving" :disabled="!canEdit || !dirty" @click="save">Lưu cài đặt</v-btn>
      </div>

      <!-- Kết quả xem trước -->
      <section v-if="previewResult" class="ld-card ld-preview">
        <div class="ld-row-title">
          Nếu chạy ngay bây giờ
          <span v-if="previewResult.skipped" class="ld-skip">— bỏ qua: {{ previewResult.skipped }}</span>
        </div>
        <ul class="ld-preview-list">
          <li>Chia <b>{{ previewResult.plan.round1.length }}</b> lead mới cho sale</li>
          <li>Thêm sale thứ 2 cho <b>{{ previewResult.plan.round2.length }}</b> khách</li>
          <li>Gắn cờ quá hạn <b>{{ previewResult.plan.escalate.length }}</b> khách</li>
        </ul>
        <p class="ld-hint">Chưa ghi gì vào dữ liệu. Bấm nút dưới đây mới thực hiện thật.</p>
        <v-btn size="small" color="primary" variant="tonal" :loading="running" :disabled="!canEdit || nothingToDo"
          @click="runForReal">Chạy thật ngay</v-btn>
      </section>

      <!-- Nạp tồn -->
      <section class="ld-card">
        <div class="ld-row-text" style="margin-bottom: 10px">
          <div class="ld-row-title">Nạp khách cũ vào vòng chia</div>
          <div class="ld-row-desc">
            Khách đã có chủ từ trước nằm <b>ngoài</b> cơ chế này. Bấm nạp thì đồng hồ
            “{{ form.coAssignAfterDays }} ngày” của họ bắt đầu tính <b>từ bây giờ</b>, không tính ngược về quá khứ —
            nếu tính ngược thì mai toàn bộ sẽ bị gắn thêm sale cùng lúc.
          </div>
        </div>
        <div class="ld-backfill">
          <v-btn variant="outlined" size="small" :loading="backfilling" :disabled="!canEdit" @click="checkBackfill">
            Đếm thử
          </v-btn>
          <v-btn v-if="backfillCount !== null && backfillCount > 0" color="warning" size="small"
            :loading="backfilling" :disabled="!canEdit" @click="doBackfill">
            Nạp {{ backfillCount }} khách
          </v-btn>
          <span v-if="backfillCount === 0" class="ld-hint">Không có khách nào cần nạp.</span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '@/api';
import { useToast } from '@/composables/use-toast';
import { useAuthStore } from '@/stores/auth';

const toast = useToast();
const auth = useAuthStore();

interface MemberRow {
  userId: string; fullName: string | null; email: string; role: string;
  /** Tỉnh của chi nhánh (Department.province). null = chưa xếp chi nhánh → không nhận lead. */
  province: string | null; departmentName: string | null;
  inPool: boolean; dailyQuota: number | null; effectiveQuota: number;
  activeLoad: number; assignedToday: number;
}
interface ConfigForm {
  enabled: boolean; dailyQuotaPerUser: number; coAssignAfterDays: number;
  escalateAfterDays: number; requirePhone: boolean;
}
interface PreviewResult {
  skipped?: string;
  plan: { round1: unknown[]; round2: unknown[]; escalate: unknown[] };
}

const loading = ref(true);
const saving = ref(false);
const previewing = ref(false);
const running = ref(false);
const backfilling = ref(false);
const backfillCount = ref<number | null>(null);
const previewResult = ref<PreviewResult | null>(null);

const DEFAULTS: ConfigForm = {
  enabled: false, dailyQuotaPerUser: 12, coAssignAfterDays: 14, escalateAfterDays: 28, requirePhone: true,
};
const form = reactive<ConfigForm>({ ...DEFAULTS });
const saved = reactive<ConfigForm>({ ...DEFAULTS });
const members = ref<MemberRow[]>([]);
let savedMembers = '';

const canEdit = computed(() => ['owner', 'admin'].includes(auth.user?.role ?? ''));

const estimatedDaily = computed(
  () => members.value.filter((m) => m.inPool).length * (Number(form.dailyQuotaPerUser) || 0),
);
// Bật nhận lead mà không có chi nhánh là cấu hình chết lặng: người đó không bao giờ
// được chia gì và không có lỗi nào nổi lên. Nói thẳng ra ở đây.
const poolWithoutBranch = computed(() =>
  members.value.filter((m) => m.inPool && !m.province).map((m) => m.fullName || m.email),
);
// Mốc gắn cờ sớm hơn mốc thêm sale 2 là cấu hình mâu thuẫn — backend vẫn chạy được
// (hai việc độc lập) nhưng kết quả vô nghĩa với người dùng, nên cảnh báo tại chỗ.
const escalateTooEarly = computed(
  () => Number(form.escalateAfterDays) < Number(form.coAssignAfterDays),
);
const nothingToDo = computed(() => {
  const p = previewResult.value?.plan;
  return !p || p.round1.length + p.round2.length + p.escalate.length === 0;
});

function membersFingerprint(): string {
  return JSON.stringify(
    members.value.map((m) => [m.userId, m.inPool, m.dailyQuota === null ? null : Number(m.dailyQuota)]),
  );
}
const dirty = computed(
  () => form.enabled !== saved.enabled
    || Number(form.dailyQuotaPerUser) !== saved.dailyQuotaPerUser
    || Number(form.coAssignAfterDays) !== saved.coAssignAfterDays
    || Number(form.escalateAfterDays) !== saved.escalateAfterDays
    || form.requirePhone !== saved.requirePhone
    || membersFingerprint() !== savedMembers,
);

async function load() {
  loading.value = true;
  try {
    const { data } = await api.get('/lead-distribution/config');
    Object.assign(form, data.config);
    Object.assign(saved, data.config);
    members.value = (data.members ?? []).map((m: MemberRow) => ({ ...m }));
    savedMembers = membersFingerprint();
  } catch {
    toast.error('Không tải được cài đặt chia lead');
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    await api.put('/lead-distribution/config', {
      enabled: form.enabled,
      dailyQuotaPerUser: Number(form.dailyQuotaPerUser),
      coAssignAfterDays: Number(form.coAssignAfterDays),
      escalateAfterDays: Number(form.escalateAfterDays),
      requirePhone: form.requirePhone,
    });
    await api.put('/lead-distribution/members', {
      members: members.value.map((m) => ({
        userId: m.userId,
        inPool: m.inPool,
        dailyQuota: m.dailyQuota === null || m.dailyQuota === undefined || (m.dailyQuota as unknown) === ''
          ? null
          : Number(m.dailyQuota),
      })),
    });
    toast.success('Đã lưu cài đặt chia lead');
    await load();
  } catch {
    toast.error('Lưu không thành công');
  } finally {
    saving.value = false;
  }
}

async function preview() {
  previewing.value = true;
  try {
    const { data } = await api.post('/lead-distribution/run-now?dryRun=true');
    previewResult.value = data;
  } catch {
    toast.error('Không chạy thử được');
  } finally {
    previewing.value = false;
  }
}

async function runForReal() {
  running.value = true;
  try {
    const { data } = await api.post('/lead-distribution/run-now?dryRun=false');
    const r = data.result ?? { round1: 0, round2: 0, escalated: 0, errors: [] };
    toast.success(`Đã chia ${r.round1} lead, thêm sale 2 cho ${r.round2} khách, gắn cờ ${r.escalated}`);
    if (r.errors?.length) toast.error(`${r.errors.length} dòng lỗi — xem log máy chủ`);
    previewResult.value = null;
    await load();
  } catch {
    toast.error('Chạy không thành công');
  } finally {
    running.value = false;
  }
}

async function checkBackfill() {
  backfilling.value = true;
  try {
    const { data } = await api.post('/lead-distribution/backfill?dryRun=true');
    backfillCount.value = data.count;
    if (data.count === 0) toast.push('Không có khách cũ nào cần nạp');
  } catch {
    toast.error('Không đếm được');
  } finally {
    backfilling.value = false;
  }
}

async function doBackfill() {
  backfilling.value = true;
  try {
    const { data } = await api.post('/lead-distribution/backfill?dryRun=false');
    toast.success(`Đã nạp ${data.count} khách vào vòng chia`);
    backfillCount.value = null;
    await load();
  } catch {
    toast.error('Nạp không thành công');
  } finally {
    backfilling.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.ld { padding: 24px 28px; max-width: 980px; }
.ld-head { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 20px; }
.ld-ico { font-size: 30px; line-height: 1; }
.ld-h1 { font-size: 20px; font-weight: 700; margin: 0 0 4px; color: #111827; }
.ld-sub { font-size: 13px; color: #6B7280; margin: 0; line-height: 1.55; max-width: 720px; }
.ld-loading { color: #6B7280; font-size: 14px; padding: 20px 0; }
.ld-card { background: #fff; border: 1px solid #E5E7EB; border-radius: 10px; padding: 18px; margin-bottom: 14px; }
.ld-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.ld-row-title { font-size: 14px; font-weight: 600; color: #111827; }
.ld-row-desc { font-size: 12.5px; color: #6B7280; margin-top: 3px; line-height: 1.5; }
.ld-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 18px; }
.ld-field { display: flex; flex-direction: column; gap: 6px; }
.ld-label { font-size: 13px; font-weight: 600; color: #374151; }
.ld-hint { font-size: 12px; color: #9CA3AF; line-height: 1.45; margin: 0; }
.ld-warn { display: flex; gap: 10px; align-items: flex-start; margin-top: 16px; padding: 10px 12px;
  background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; font-size: 12.5px; color: #92400E; }
.ld-table-wrap { overflow-x: auto; }
.ld-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ld-table th { text-align: left; font-weight: 600; color: #6B7280; font-size: 12px;
  padding: 8px 10px; border-bottom: 1px solid #E5E7EB; white-space: nowrap; }
.ld-table td { padding: 8px 10px; border-bottom: 1px solid #F3F4F6; vertical-align: middle; }
.ld-name { font-weight: 600; color: #111827; }
.ld-email { font-size: 11.5px; color: #9CA3AF; }
.ld-branch {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 12px; background: #EEF2FF; color: #3730A3; white-space: nowrap;
}
.ld-branch-missing { background: #FEF3C7; color: #92400E; font-style: italic; }
.ld-num { font-variant-numeric: tabular-nums; color: #374151; }
.ld-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; margin: 18px 0 6px; }
.ld-noperm { font-size: 12.5px; color: #9CA3AF; margin-right: auto; }
.ld-preview { background: #F9FAFB; }
.ld-preview-list { margin: 10px 0; padding-left: 20px; font-size: 13px; color: #374151; line-height: 1.8; }
.ld-skip { font-weight: 400; color: #9CA3AF; font-size: 12.5px; }
.ld-backfill { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
