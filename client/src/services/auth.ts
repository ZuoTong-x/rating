import type {
  AccountTeam,
  AuthUser,
  AuthUserPage,
  AvailabilityStatus,
  ScorerUserBatchCreateResult
} from '../types/auth';
import { requestEmpty, requestJson } from './http';

export const authApi = {
  login(username: string, password: string, captcha?: { id: string; answer: string } | null) {
    return requestJson<{ user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        captchaId: captcha?.id,
        captchaAnswer: captcha?.answer
      })
    });
  },
  captcha() {
    return requestJson<{ captchaId: string; image: string; expiresAt: string }>('/api/auth/captcha', {
      method: 'POST'
    });
  },
  changePassword(currentPassword: string, newPassword: string) {
    return requestJson<{ user: AuthUser }>('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
  },
  session() {
    return requestJson<{ user: AuthUser }>('/api/auth/session');
  },
  async logout() {
    await requestEmpty('/api/auth/logout', { method: 'POST' });
  },
  scorerUsers(query: {
    page?: number;
    pageSize?: number;
    username?: string | null;
    teamId?: string | null;
    lastLoginStart?: string | null;
    lastLoginEnd?: string | null;
  } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.username) params.set('username', query.username);
    if (query.teamId) params.set('teamId', query.teamId);
    if (query.lastLoginStart) params.set('lastLoginStart', query.lastLoginStart);
    if (query.lastLoginEnd) params.set('lastLoginEnd', query.lastLoginEnd);
    return requestJson<AuthUserPage>(`/api/users/scorers${params.toString() ? `?${params}` : ''}`);
  },
  scorerTeams(query: { status?: AvailabilityStatus | 'all' } = {}) {
    const params = new URLSearchParams();
    if (query.status && query.status !== 'all') params.set('status', query.status);
    return requestJson<AccountTeam[]>(`/api/teams${params.toString() ? `?${params}` : ''}`);
  },
  scorerUsersByTeams(teamIds: string[], teamMatchMode: 'all' | 'any' = 'all') {
    const params = new URLSearchParams();
    params.set('teamIds', teamIds.join(','));
    params.set('teamMatchMode', teamMatchMode);
    return requestJson<{ users: Array<{ id: string; username: string }> }>(`/api/teams/scorers?${params}`);
  },
  createScorerUser(username: string, password?: string, teamNames: string[] = []) {
    return requestJson<{ user: AuthUser }>('/api/users/scorers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, teamNames })
    });
  },
  createScorerUsers(payload: { usernames: string[]; password?: string; teamNames?: string[] }) {
    return requestJson<ScorerUserBatchCreateResult>('/api/users/scorers/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  updateScorerUser(id: string, payload: { password?: string; teamNames?: string[]; status?: AvailabilityStatus }) {
    return requestJson<{ user: AuthUser }>(`/api/users/scorers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  deleteScorerUser(id: string) {
    return requestJson<{ deleted: boolean }>(`/api/users/scorers/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  },
  teams(query: { status?: AvailabilityStatus | 'all' } = {}) {
    const params = new URLSearchParams();
    if (query.status && query.status !== 'all') params.set('status', query.status);
    return requestJson<AccountTeam[]>(`/api/teams${params.toString() ? `?${params}` : ''}`);
  },
  createTeam(name: string) {
    return requestJson<{ team: AccountTeam }>('/api/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
  },
  updateTeam(id: string, payload: { name?: string; status?: AvailabilityStatus }) {
    return requestJson<{ team: AccountTeam }>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  deleteTeam(id: string) {
    return requestJson<{ deleted: boolean }>(`/api/teams/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
};
