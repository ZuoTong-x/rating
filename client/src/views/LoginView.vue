<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMessage } from 'naive-ui';
import { setCurrentUser } from '../composables/auth';
import { useAppTheme } from '../composables/theme';
import { authApi } from '../services/auth';
import { HttpError } from '../services/http';
import WaveBg from '../components/WaveBg.vue';
import type { AuthUser } from '../types/auth';


const router = useRouter();
const route = useRoute();
const message = useMessage();
const { isDark, toggleTheme } = useAppTheme();
const loading = ref(false);
const captchaLoading = ref(false);
const captchaVisible = ref(false);
const captchaId = ref('');
const captchaImage = ref('');
const captchaAnswer = ref('');
const form = reactive({
  username: '',
  password: ''
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '登录失败';
}

function redirectForUser(user: AuthUser) {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '';
  const isInternalRedirect = redirect.startsWith('/') && !redirect.startsWith('//') && redirect !== '/login';
  if (user.role === 'admin') {
    return isInternalRedirect && redirect.startsWith('/admin') ? redirect : '/admin';
  }
  return isInternalRedirect && !redirect.startsWith('/admin') ? redirect : '/';
}

async function refreshCaptcha() {
  captchaVisible.value = true;
  captchaImage.value = '';
  captchaLoading.value = true;
  try {
    const result = await authApi.captcha();
    captchaId.value = result.captchaId;
    captchaImage.value = result.image;
    captchaAnswer.value = '';
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    captchaLoading.value = false;
  }
}

async function submitLogin() {
  if (loading.value) return;
  if (!form.username.trim()) {
    message.warning('请输入账号');
    return;
  }
  if (!form.password) {
    message.warning('请输入密码');
    return;
  }
  if (captchaVisible.value && !captchaAnswer.value.trim()) {
    message.warning('请输入图形验证码');
    return;
  }
  loading.value = true;
  try {
    const result = await authApi.login(
      form.username,
      form.password,
      captchaVisible.value ? { id: captchaId.value, answer: captchaAnswer.value } : null
    );
    setCurrentUser(result.user);
    message.success('登录成功');
    await router.replace(redirectForUser(result.user));
  } catch (error) {
    if (error instanceof HttpError && ['CAPTCHA_REQUIRED', 'CAPTCHA_INVALID'].includes(error.code)) {
      await refreshCaptcha();
    }
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

</script>

<template>
  <WaveBg />
  <n-button quaternary circle class="login-theme-button theme-toggle-button"
    :aria-label="isDark ? '切换浅色模式' : '切换暗黑模式'" @click="toggleTheme">
    <n-icon size="18">
      <svg v-if="isDark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12.8A8.6 8.6 0 1 1 11.2 3 6.8 6.8 0 0 0 21 12.8z" />
      </svg>
    </n-icon>
  </n-button>
  <div class="login-page">
    <div class="login-panel">
      <div class="login-heading">
        <strong style="font-size: 1.25em;">美学打分平台</strong>
        <n-text depth="3">账号登录</n-text>
      </div>

      <n-form class="login-form" :model="form" @submit.prevent>
        <n-form-item label="账号">
          <n-input v-model:value="form.username" autofocus maxlength="100" placeholder="请输入账号"
            @keyup.enter="submitLogin" />
        </n-form-item>
        <n-form-item label="密码">
          <n-input v-model:value="form.password" type="password" show-password-on="click" placeholder="请输入密码"
            @keyup.enter="submitLogin" />
        </n-form-item>
        <n-form-item v-if="captchaVisible" label="图形验证码">
          <n-space align="center" :wrap="false">
            <n-input v-model:value="captchaAnswer" maxlength="5" placeholder="请输入验证码"
              @keyup.enter="submitLogin" />
            <button type="button" class="login-captcha-button" :disabled="captchaLoading" @click="refreshCaptcha">
              <img v-if="captchaImage" :src="captchaImage" alt="图形验证码" />
              <span v-else>加载中</span>
            </button>
          </n-space>
        </n-form-item>
        <n-button type="primary" block :loading="loading" @click="submitLogin">登录</n-button>
      </n-form>
    </div>
  </div>
</template>
