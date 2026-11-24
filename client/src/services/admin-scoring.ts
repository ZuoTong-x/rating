import type { ScoringManagementSummary, ScoringRollbackJob, ScoringRollbackPreview, TaskSubmissionModeFilter } from '../types/image';
import { requestJson } from './http';
import { runAdminExport, type AdminExportOptions } from './admin-exports';

type ScoringRiskFilter = 'high' | 'fast' | 'no_large_image' | 'no_order_change' | 'page_blur';

type ScoringRollbackPreviewPayload = {
  taskIds: string[];
} | {
  source: 'scorer_full';
  scorers: string[];
  projectId?: string | null;
  submissionMode?: TaskSubmissionModeFilter | null;
};

type ScoringRollbackPayload = {
  taskIds: string[];
} | {
  source: 'scorer_full';
  scorers: string[];
  projectId?: string | null;
  submissionMode?: TaskSubmissionModeFilter | null;
  returnMode?: 'original' | 'reassign';
  allocations?: Array<{ scorer: string; taskCount: number }>;
};

export const adminScoringApi = {
  adminScoringSummary(query: {
    page?: number;
    pageSize?: number;
    scorer?: string | null;
    projectId?: string | null;
    submissionMode?: TaskSubmissionModeFilter | null;
    riskFilter?: ScoringRiskFilter | null;
  } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.scorer) params.set('scorer', query.scorer);
    if (query.projectId) params.set('projectId', query.projectId);
    if (query.submissionMode) params.set('submissionMode', query.submissionMode);
    if (query.riskFilter) params.set('riskFilter', query.riskFilter);
    return requestJson<ScoringManagementSummary>(`/api/admin/scoring/summary${params.toString() ? `?${params}` : ''}`);
  },
  adminScoringOptions() {
    return requestJson<{ projects: Array<{ _id: string; name: string }>; scorers: string[] }>('/api/admin/scoring/options');
  },
  async exportScoringOperations(filters: {
    scorer?: string | null;
    projectId?: string | null;
    submissionMode?: TaskSubmissionModeFilter | null;
    riskFilter?: ScoringRiskFilter | null;
    minDurationSeconds?: number | null;
    maxDurationSeconds?: number | null;
  } = {}, options?: AdminExportOptions) {
    const payload: Record<string, unknown> = {};
    if (filters.scorer) payload.scorer = filters.scorer;
    if (filters.projectId) payload.projectId = filters.projectId;
    if (filters.submissionMode) payload.submissionMode = filters.submissionMode;
    if (filters.riskFilter) payload.riskFilter = filters.riskFilter;
    if (filters.minDurationSeconds != null) payload.minDurationSeconds = filters.minDurationSeconds;
    if (filters.maxDurationSeconds != null) payload.maxDurationSeconds = filters.maxDurationSeconds;
    return runAdminExport('scoring-operation-log', payload, options);
  },
  async exportScoringRiskReport(filters: {
    scorers: string[];
    projectId?: string | null;
    submissionMode?: TaskSubmissionModeFilter | null;
  }, options?: AdminExportOptions) {
    const payload: Record<string, unknown> = { scorers: filters.scorers };
    if (filters.projectId) payload.projectId = filters.projectId;
    if (filters.submissionMode) payload.submissionMode = filters.submissionMode;
    return runAdminExport('scoring-risk-report', payload, options);
  },
  previewScoringRollback(payload: ScoringRollbackPreviewPayload) {
    return requestJson<ScoringRollbackPreview>('/api/admin/scoring/rollback/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  rollbackScoringTasks(payload: ScoringRollbackPayload) {
    return requestJson<ScoringRollbackJob>('/api/admin/scoring/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  scoringRollbackStatus(jobId: string) {
    return requestJson<ScoringRollbackJob>(`/api/admin/scoring/rollback/${encodeURIComponent(jobId)}`);
  }
};
