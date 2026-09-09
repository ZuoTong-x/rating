<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import TaskStackFloat from '../components/TaskStackFloat.vue';
import { clearCurrentUser, currentUser, openChangePasswordModal } from '../composables/auth';
import { useAppTheme } from '../composables/theme';
import { adminNavItems, filterNavItems, resolveAdminActiveKey, resolveScorerActiveKey, scorerNavItems } from '../config/adminNav';
import { authApi } from '../services/auth';

const COLLAPSED_STORAGE_KEY = 'image-rating.adminSidebarCollapsed';

function readCollapsedState() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
}

const route = useRoute();
const router = useRouter();
const keyword = ref('');
const collapsed = ref(readCollapsedState());
const { isDark, toggleTheme } = useAppTheme();

const isAdminLayoutMode = computed(() => currentUser.value?.role === 'admin' || route.path.startsWith('/admin'));
const layoutNavItems = computed(() => isAdminLayoutMode.value ? adminNavItems : scorerNavItems);
const activeKey = computed(() => isAdminLayoutMode.value ? resolveAdminActiveKey(route.path) : resolveScorerActiveKey(route.path));
const activeNavLabel = computed(() => layoutNavItems.value.find(item => item.key === activeKey.value)?.label || '仪表盘');
const sidebarSubtitle = computed(() => isAdminLayoutMode.value ? '管理后台' : '打分端');
const searchPlaceholder = computed(() => isAdminLayoutMode.value ? '搜索导航' : '搜索菜单');
const visibleNavItems = computed(() => (collapsed.value ? layoutNavItems.value : filterNavItems(layoutNavItems.value, keyword.value)));
const menuOptions = computed(() => visibleNavItems.value.map(item => ({
  key: item.key,
  label: item.label,
  icon: item.icon
})));

watch(collapsed, value => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? '1' : '0');
});

function toggleCollapsed() {
  collapsed.value = !collapsed.value;
}

function handleMenuSelect(key: string) {
  void router.push(key);
}

const userInitial = computed(() => currentUser.value?.username.trim().charAt(0).toLocaleUpperCase() || 'U');
const userRoleLabel = computed(() => currentUser.value?.role === 'admin' ? '管理员' : '打分人');

function openChangePassword() {
  openChangePasswordModal();
}

async function logout() {
  await authApi.logout().catch(() => { });
  clearCurrentUser();
  await router.replace('/login');
}
</script>

<template>
  <n-layout has-sider class="admin-shell admin-root-shell">
    <n-layout-sider bordered class="admin-shell-sider" :width="236" :collapsed-width="64" v-model:collapsed="collapsed"
      collapse-mode="width" :native-scrollbar="false">
      <div class="admin-shell-brand" :class="{ 'is-collapsed': collapsed }">
        <div class="admin-shell-brand-mark">美</div>
        <div v-if="!collapsed" class="admin-shell-brand-text">
          <strong>美学打分平台</strong>
          <span>{{ sidebarSubtitle }}</span>
        </div>
      </div>

      <n-menu class="admin-shell-menu" :value="activeKey" :options="menuOptions" :collapsed="collapsed"
        :collapsed-width="64" @update:value="handleMenuSelect" />
    </n-layout-sider>

    <n-layout-content class="admin-shell-main">
      <n-layout-header bordered class="admin-top-header">
        <div class="admin-top-header-left">
          <n-button quaternary circle class="admin-collapse-button" @click="toggleCollapsed">
            <template #icon>
              <n-icon size="18">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </n-icon>
            </template>
          </n-button>
          <strong class="admin-top-header-title">{{ activeNavLabel }}</strong>
        </div>
        <div class="header-actions">
          <n-button quaternary circle class="theme-toggle-button" :aria-label="isDark ? '切换浅色模式' : '切换暗黑模式'"
            @click="toggleTheme">
            <n-icon size="18">
              <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path
                  d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12.8A8.6 8.6 0 1 1 11.2 3 6.8 6.8 0 0 0 21 12.8z" />
              </svg>
            </n-icon>
          </n-button>
          <n-popover v-if="currentUser" trigger="hover" placement="bottom-end" :show-arrow="false">
            <template #trigger>
              <n-button quaternary circle class="user-menu-button" aria-label="用户菜单">
                <n-avatar round :size="32" class="user-menu-avatar">{{ userInitial }}</n-avatar>
              </n-button>
            </template>
            <div class="user-profile-popover">
              <div class="user-profile-summary">
                <n-avatar round :size="48" class="user-profile-avatar">{{ userInitial }}</n-avatar>
                <strong>{{ currentUser.username }}</strong>
                <n-text depth="3">{{ userRoleLabel }}</n-text>
              </div>
              <n-button text class="user-profile-logout" @click="openChangePassword">修改密码</n-button>
              <n-button text class="user-profile-logout" @click="logout">退出登录</n-button>
              <n-divider />
              <div class="user-profile-version">Version: <span>v1.0.0</span></div>
            </div>
          </n-popover>
        </div>
      </n-layout-header>
      <n-layout-content class="admin-shell-content">
        <RouterView />
      </n-layout-content>
    </n-layout-content>

    <TaskStackFloat v-if="isAdminLayoutMode" />
  </n-layout>
</template>
