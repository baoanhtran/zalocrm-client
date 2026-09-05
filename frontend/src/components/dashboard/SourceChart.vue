<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <v-card>
    <v-card-title class="text-body-1">Nguồn khách hàng</v-card-title>
    <v-card-text>
      <Pie v-if="chartData" :data="chartData" :options="chartOptions" style="height: 250px;" />
      <div v-else class="text-center pa-8 text-grey">Không có dữ liệu</div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Pie } from 'vue-chartjs';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';
import {
  SOURCE_GROUP_SCAN, SOURCE_SURVEY, SOURCE_SURVEY_PREFIX, sourceLabel,
} from '@/composables/use-contacts';

ChartJS.register(ArcElement, Tooltip, Legend);

const props = defineProps<{
  data: { source: string; _count: { _all: number } | number }[];
}>();

// Màu theo nguồn hiện hành. Nguồn cũ (FB/TT/GT/CN) đã gỡ khỏi danh mục 2026-09-05 —
// khách cũ mang giá trị đó vẫn vẽ được, chỉ rơi về màu xám mặc định.
const sourceColors: Record<string, string> = {
  [SOURCE_GROUP_SCAN]: '#7C5CFF',
  [SOURCE_SURVEY]: '#12B76A',
};

// Mỗi tỉnh là một source riêng ("khao-sat:Hà Nội") nên nếu không gom lại thì biểu đồ
// vỡ thành hàng chục lát tí hon. Tô chung một màu với nguồn khảo sát gộp.
function colorFor(source: string): string {
  if (source?.startsWith(SOURCE_SURVEY_PREFIX)) return sourceColors[SOURCE_SURVEY];
  return sourceColors[source] || '#BDBDBD';
}

function getCount(item: { _count: { _all: number } | number }): number {
  return typeof item._count === 'number' ? item._count : item._count._all;
}

const chartData = computed(() => {
  if (!props.data?.length) return null;
  return {
    labels: props.data.map(d => sourceLabel(d.source)),
    datasets: [{
      data: props.data.map(d => getCount(d)),
      backgroundColor: props.data.map(d => colorFor(d.source)),
    }],
  };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { position: 'right' as const, labels: { boxWidth: 12 } } },
};
</script>
