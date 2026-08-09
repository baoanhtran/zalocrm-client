<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Nguyễn Tiến Lộc -->
<template>
  <v-app>
    <OfflineIndicator />

    <!-- Slim mobile app bar -->
    <v-app-bar density="compact" flat>
      <div class="d-flex align-center ml-3" style="gap: 8px;">
        <div class="d-flex align-center justify-center" style="width: 28px; height: 28px; background: linear-gradient(135deg, #00F2FF, #0077B6); border-radius: 8px;">
          <v-icon size="16" color="white">mdi-robot</v-icon>
        </div>
        <!-- 2026-08-09: cyan #00F2FF vốn cho app-bar nền tối; sang hsLight nền trắng chỉ
             còn contrast 1.39 (chuẩn AA cần 4.5) → đọc không ra. Dùng #0077B6 = đầu đậm
             của gradient logo ngay bên cạnh, giữ đúng màu thương hiệu, contrast 4.87. -->
        <span class="font-weight-bold text-body-1"><span style="color: #0077B6;">CRM</span></span>
      </div>

      <v-spacer />

      <NotificationBell />
      <!-- 2026-08-09: bỏ nút đổi theme — app light-only từ 2026-06-13 (xem DefaultLayout),
           desktop đã gỡ nút này. Giữ lại thì bấm một cái là mobile lại về dark. -->
      <v-btn icon size="small" variant="text" @click="logout">
        <v-icon size="20">mdi-logout</v-icon>
      </v-btn>
    </v-app-bar>

    <!-- Main content with padding for bottom nav -->
    <v-main>
      <div style="padding-bottom: 72px;">
        <slot />
      </div>
    </v-main>

    <BottomNav />
  </v-app>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useTheme } from 'vuetify';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import NotificationBell from '@/components/NotificationBell.vue';
import BottomNav from '@/components/BottomNav.vue';
import OfflineIndicator from '@/components/OfflineIndicator.vue';

const theme = useTheme();
const authStore = useAuthStore();
const router = useRouter();

onMounted(() => {
  // 2026-08-09: đồng bộ với DefaultLayout — app LUÔN theme sáng 'hsLight'.
  // Trước đây: `isDark = localStorage.getItem('theme') !== 'light'`. Nhưng chốt
  // light-only 2026-06-13 lưu 'hsLight', mà 'hsLight' !== 'light' → điện thoại LUÔN
  // rơi vào theme dark, dù index.html khai báo color-scheme:light only. Hệ quả thấy
  // rõ ở /leads/stuck: .back-btn và .refresh-btn đặt nền #fff nhưng không đặt color
  // nên ăn chữ trắng của theme dark → nút trắng trơn, mất chữ (contrast 1.0).
  theme.global.name.value = 'hsLight';
  localStorage.setItem('theme', 'hsLight');
});

function logout() {
  authStore.logout();
  router.push('/login');
}
</script>
