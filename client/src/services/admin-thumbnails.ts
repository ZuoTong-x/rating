import type { ThumbnailQueueOverview, ThumbnailQueueSettings } from '../types/image';
import { requestJson } from './http';

export const adminThumbnailApi = {
  thumbnailQueueOverview(query: { page?: number; pageSize?: number; search?: string } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.search) params.set('search', query.search);
    return requestJson<ThumbnailQueueOverview>(`/api/admin/thumbnails${params.toString() ? `?${params}` : ''}`);
  },
  updateThumbnailQueueSettings(payload: Partial<Pick<ThumbnailQueueSettings,
    'globallyPaused' | 'daytimeConcurrency' | 'nighttimeConcurrency' | 'nightStartHour' | 'nightEndHour' | 'timeZone'>>) {
    return requestJson<{ settings: ThumbnailQueueSettings }>('/api/admin/thumbnails/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  completedThumbnailCandidates() {
    return requestJson<{ packages: Array<{ subjectId: string; name: string; pendingCount: number; importedAt: string | null }> }>(
      '/api/admin/thumbnails/completed-candidates'
    );
  },
  disableCompletedThumbnailPackages(subjectIds: string[]) {
    return requestJson<{ disabled: number; subjectIds: string[] }>('/api/admin/thumbnails/disable-completed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectIds })
    });
  },
  updateThumbnailPackageControl(subjectId: string, payload: {
    generationEnabled?: boolean;
    paused?: boolean;
    priority?: number;
  }) {
    return requestJson<{ control: { subjectId: string; generationEnabled: boolean; paused: boolean; priority: number } }>(
      `/api/admin/thumbnails/packages/${encodeURIComponent(subjectId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
  },
  retryThumbnailPackageFailed(subjectId: string) {
    return requestJson<{ subjectId: string; retried: number }>(
      `/api/admin/thumbnails/packages/${encodeURIComponent(subjectId)}/retry-failed`,
      { method: 'POST' }
    );
  },
  retryAllThumbnailFailed() {
    return requestJson<{ retried: number }>('/api/admin/thumbnails/retry-failed', { method: 'POST' });
  }
};
