<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { useRouter } from 'vue-router';
import {
  changePasswordModalVisible,
  clearCurrentUser,
  closeChangePasswordModal,
  currentUser,
} from '../composables/auth';
import { authApi } from '../services/auth';

const message = useMessage();
const router = useRouter();
const loading = ref(false);
const form = reactive({
  username: '',
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
});

const isForced = computed(() => Boolean(currentUser.value?.mustChangePassword));
const visible = computed({
  get: () => isForced.value || changePasswordModalVisible.value,
  set: value => {
    if (!isForced.value) changePasswordModalVisible.value = value;
  }
});
const passwordRules = computed(() => ({
  length: form.newPassword.length >= 8 && form.newPassword.length <= 100,
  lowercase: /[a-z]/.test(form.newPassword),
  uppercase: /[A-Z]/.test(form.newPassword),
  special: /[^A-Za-z0-9]/.test(form.newPassword)
}));
const passwordRuleItems = computed(() => [
  { key: 'length', label: '至少 8 位', valid: passwordRules.value.length },
  { key: 'uppercase', label: '大写字母', valid: passwordRules.value.uppercase },
  { key: 'lowercase', label: '小写字母', valid: passwordRules.value.lowercase },
  { key: 'special', label: '特殊字符', valid: passwordRules.value.special }
]);
const passwordValid = computed(() => Object.values(passwordRules.value).every(Boolean));

function resetForm() {
  form.username = currentUser.value?.username || '';
  form.currentPassword = '';
  form.newPassword = '';
  form.confirmPassword = '';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '修改密码失败';
}

watch(() => currentUser.value?.id, resetForm, { immediate: true });
watch(() => changePasswordModalVisible.value, value => {
  if (value) resetForm();
});

async function submit() {
  if (loading.value) return;
  if (!form.currentPassword) {
    message.warning('请输入旧密码');
    return;
  }
  if (!form.newPassword) {
    message.warning('请输入新密码');
    return;
  }
  if (!passwordValid.value) {
    message.error('新密码至少 8 位，并包含大写字母、小写字母和特殊字符');
    return;
  }
  if (!form.confirmPassword) {
    message.warning('请再次输入新密码');
    return;
  }
  if (form.newPassword !== form.confirmPassword) {
    message.error('两次输入的新密码不一致');
    return;
  }

  loading.value = true;
  try {
    await authApi.changePassword(form.currentPassword, form.newPassword);
    await authApi.logout().catch(() => {});
    clearCurrentUser();
    closeChangePasswordModal();
    resetForm();
    message.success('密码已更新');
    await router.replace('/login');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <n-modal v-model:show="visible" preset="card" class="change-password-modal"
    :title="isForced ? '首次登录需要修改密码' : '修改密码'" :closable="!isForced"
    :mask-closable="!isForced" :close-on-esc="!isForced" :bordered="false">
    <n-alert v-if="isForced" type="warning" :bordered="false" class="change-password-alert">
      为保障账号安全，请先修改密码后再继续使用。
    </n-alert>

    <n-form class="change-password-form" :model="form" @submit.prevent="submit">
      <n-form-item label="账号">
        <n-input v-model:value="form.username" readonly />
      </n-form-item>
      <n-form-item label="旧密码">
        <n-input v-model:value="form.currentPassword" type="password" show-password-on="click"
          placeholder="请输入旧密码" @keyup.enter="submit" />
      </n-form-item>
      <n-form-item label="新密码">
        <div class="change-password-field">
          <n-input v-model:value="form.newPassword" type="password" show-password-on="click"
            maxlength="100" placeholder="请输入新密码" @keyup.enter="submit" />
          <div class="change-password-rules" aria-label="密码强度规则">
            <span v-for="rule in passwordRuleItems" :key="rule.key" :class="{ 'is-valid': rule.valid }">
              <n-icon size="14" aria-hidden="true">
                <svg v-if="rule.valid" viewBox="0 0 24 24" fill="none"
                  xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
                  <path d="m8 12 2.5 2.5L16.5 8.5" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none"
                  xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
                </svg>
              </n-icon>
              {{ rule.label }}
            </span>
          </div>
          <div class="change-password-rule-bars" aria-label="密码规则符合数量">
            <i v-for="rule in passwordRuleItems" :key="`${rule.key}-bar`"
              class="change-password-rule-bar" :class="{ 'is-valid': rule.valid }" />
          </div>
        </div>
      </n-form-item>
      <n-form-item label="确认新密码">
        <n-input v-model:value="form.confirmPassword" type="password" show-password-on="click"
          maxlength="100" placeholder="请再次输入新密码" @keyup.enter="submit" />
      </n-form-item>
    </n-form>

    <template #footer>
      <n-button type="primary" block :loading="loading" @click="submit">确认修改</n-button>
    </template>
  </n-modal>
</template>
