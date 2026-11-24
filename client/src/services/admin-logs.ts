import type { AdminOperationalLogPage } from '../types/image';
import { requestJson } from './http';

export const adminLogsApi = {
  adminOperationalLogs(query: {
    page?: number;
    pageSize?: number;
    level?: string | null;
    source?: string | null;
    code?: string | null;
    search?: string | null;
    startTime?: string | null;
    endTime?: string | null;
  } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.level) params.set('level', query.level);
    if (query.source) params.set('source', query.source);
    if (query.code) params.set('code', query.code);
    if (query.search) params.set('search', query.search);
    if (query.startTime) params.set('startTime', query.startTime);
    if (query.endTime) params.set('endTime', query.endTime);
    return requestJson<AdminOperationalLogPage>(`/api/admin/logs${params.toString() ? `?${params}` : ''}`);
  }
};
