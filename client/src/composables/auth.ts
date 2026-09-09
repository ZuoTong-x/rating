import { computed, ref } from 'vue';
import { setScorerName } from './scorer';
import type { AuthUser } from '../types/auth';

const STORAGE_KEY = 'image-rating.authUser';

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false;
  const user = value as Partial<AuthUser>;
  return typeof user.id === 'string'
    && typeof user.username === 'string'
    && (user.role === 'admin' || user.role === 'scorer');
}

function readStoredUser() {
  if (typeof window === 'undefined') return null;
  const text = window.localStorage.getItem(STORAGE_KEY);
  if (!text) return null;
  try {
    const user = JSON.parse(text);
    return isAuthUser(user) ? user : null;
  } catch {
    return null;
  }
}

function persistUser(user: AuthUser | null) {
  if (typeof window === 'undefined') return;
  if (user) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

function syncScorerName(user: AuthUser | null) {
  setScorerName(user?.role === 'scorer' ? user.username : '');
}

const storedUser = readStoredUser();
export const currentUser = ref<AuthUser | null>(storedUser);
export const isLoggedIn = computed(() => Boolean(currentUser.value));
export const isAdminUser = computed(() => currentUser.value?.role === 'admin');
export const changePasswordModalVisible = ref(false);

syncScorerName(storedUser);

export function setCurrentUser(user: AuthUser) {
  currentUser.value = user;
  persistUser(user);
  syncScorerName(user);
}

export function clearCurrentUser() {
  currentUser.value = null;
  changePasswordModalVisible.value = false;
  persistUser(null);
  syncScorerName(null);
}

export function openChangePasswordModal() {
  changePasswordModalVisible.value = true;
}

export function closeChangePasswordModal() {
  changePasswordModalVisible.value = false;
}

export function defaultRouteForUser(user: AuthUser | null) {
  return user?.role === 'admin' ? '/admin' : '/';
}
