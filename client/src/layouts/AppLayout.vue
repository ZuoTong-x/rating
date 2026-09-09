<script setup lang="ts">
import { computed } from 'vue';
import { darkTheme, type GlobalThemeOverrides } from 'naive-ui';
import { useAppTheme } from '../composables/theme';
import ChangePasswordModal from '../components/ChangePasswordModal.vue';

const { isDark } = useAppTheme();
const naiveTheme = computed(() => isDark.value ? darkTheme : null);
const darkDataTableThemeOverrides: NonNullable<GlobalThemeOverrides['DataTable']> = {
  borderColor: 'var(--border-soft-color)',
  tdColor: 'var(--surface-bg)',
  tdColorHover: 'var(--surface-muted-bg)',
  tdColorSorting: 'var(--surface-muted-bg)',
  tdColorStriped: 'var(--surface-muted-bg)',
  tdTextColor: 'var(--text-color)',
  thColor: 'var(--surface-muted-bg)',
  thColorHover: 'var(--surface-soft-bg)',
  thColorSorting: 'var(--surface-soft-bg)',
  thTextColor: 'var(--text-muted-color)',
  thButtonColorHover: 'var(--surface-soft-bg)',
  thIconColor: 'var(--text-soft-color)',
  borderColorModal: 'var(--border-soft-color)',
  tdColorModal: 'var(--surface-bg)',
  tdColorHoverModal: 'var(--surface-muted-bg)',
  tdColorSortingModal: 'var(--surface-muted-bg)',
  tdColorStripedModal: 'var(--surface-muted-bg)',
  thColorModal: 'var(--surface-muted-bg)',
  thColorHoverModal: 'var(--surface-soft-bg)',
  thColorSortingModal: 'var(--surface-soft-bg)',
  borderColorPopover: 'var(--border-soft-color)',
  tdColorPopover: 'var(--surface-bg)',
  tdColorHoverPopover: 'var(--surface-muted-bg)',
  tdColorSortingPopover: 'var(--surface-muted-bg)',
  tdColorStripedPopover: 'var(--surface-muted-bg)',
  thColorPopover: 'var(--surface-muted-bg)',
  thColorHoverPopover: 'var(--surface-soft-bg)',
  thColorSortingPopover: 'var(--surface-soft-bg)'
};
const naiveThemeOverrides = computed<GlobalThemeOverrides | undefined>(() => isDark.value ? {
  DataTable: darkDataTableThemeOverrides
} : undefined);
</script>

<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="naiveThemeOverrides">
    <n-message-provider>
      <n-dialog-provider>
        <n-layout class="app">
          <router-view />
        </n-layout>
        <ChangePasswordModal />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
