import type { AdminDashboardCharts, AdminDashboardProjectSection, AdminDashboardStats, AdminDashboardWorkloadSection, AdminSystemStatus } from '../types/image';
import { requestJson } from './http';

export const adminDashboardApi = {
  adminDashboardStats() {
    return requestJson<AdminDashboardStats>('/api/admin/dashboard/stats');
  },
  adminDashboardProjectSection(query: { projectId?: string | null } = {}) {
    const params = new URLSearchParams();
    if (query.projectId) params.set('projectId', query.projectId);
    return requestJson<AdminDashboardProjectSection>(`/api/admin/dashboard/project-summary${params.toString() ? `?${params}` : ''}`);
  },
  adminDashboardCharts() {
    return requestJson<AdminDashboardCharts>('/api/admin/dashboard/charts');
  },
  adminDashboardWorkload(query: {
    scorerId?: string | null;
    teamId?: string | null;
    mode?: 'scorer' | 'team' | 'both';
  } = {}) {
    const params = new URLSearchParams();
    if (query.scorerId) params.set('scorerId', query.scorerId);
    if (query.teamId) params.set('teamId', query.teamId);
    if (query.mode) params.set('mode', query.mode);
    return requestJson<AdminDashboardWorkloadSection>(`/api/admin/dashboard/workload${params.toString() ? `?${params}` : ''}`);
  },
  adminSystemStatus() {
    return requestJson<AdminSystemStatus>('/api/admin/system/status');
  }
};
