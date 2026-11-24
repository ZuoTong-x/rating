import type { ImageItem, ImagePage, ImageQuery, ImageScore, ProjectItem, ProjectPage, SubjectItem } from '../types/image';
import { requestJson, requestJsonWithRetry } from './http';
import { importApi, type ImportJob } from './imports';
import { feedbackApi } from './feedback';
export { createUploadId } from './imports';
export type { ImportJob } from './imports';
import { runAdminExport, type AdminExportOptions, type TeamTaskSummaryExportOptions, type ScorerTaskSummaryExportOptions } from './admin-exports';

export const imageApi = {
  subjects: () => requestJson<SubjectItem[]>('/api/subjects'),
  pendingImportJobs: () => requestJson<ImportJob[]>('/api/import/pending-json'),
  projects: () => requestJson<ProjectItem[]>('/api/projects'),
  projectPage(query: { page?: number; pageSize?: number } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    return requestJson<ProjectPage>(`/api/projects${params.toString() ? `?${params}` : ''}`);
  },
  createProject(payload: { name: string; packageIds: string[] }) {
    return requestJson<{ project: ProjectItem }>('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  updateProject(id: string, payload: { name: string; packageIds: string[] }) {
    return requestJson<{ project: ProjectItem }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  updateProjectTaskLock(id: string, locked: boolean) {
    return requestJson<{ project: ProjectItem }>(`/api/projects/${encodeURIComponent(id)}/task-lock`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked })
    });
  },
  deleteProject(id: string) {
    return requestJson<{ deleted: boolean; deletedTaskCount: number }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async exportCompletedTasks(
    filters?: string | string[] | { projectIds?: string[] | null } | null,
    options?: AdminExportOptions
  ) {
    let projectIds: string[] = [];
    if (Array.isArray(filters) && filters.length) {
      projectIds = filters;
    } else if (typeof filters === 'string' && filters) {
      projectIds = [filters];
    } else if (filters && typeof filters === 'object' && !Array.isArray(filters)) {
      projectIds = filters.projectIds || [];
    }
    return runAdminExport('project-completed-tasks', { projectIds }, options);
  },
  async exportTeamTaskSummary(teamIds: string[], options?: TeamTaskSummaryExportOptions) {
    const payload: Record<string, unknown> = { teamIds };
    if (options?.excludeInactiveScorers) payload.excludeInactiveScorers = true;
    return runAdminExport('team-task-summary', payload, options);
  },
  async exportScorerTaskSummary(scorerIds: string[], options?: ScorerTaskSummaryExportOptions) {
    const payload: Record<string, unknown> = { scorerIds };
    if (options?.completedFrom) payload.completedFrom = options.completedFrom;
    if (options?.completedTo) payload.completedTo = options.completedTo;
    return runAdminExport('scorer-completed-tasks', payload, options);
  },
  ...feedbackApi,
  categories(subjectId?: string | null) {
    const params = new URLSearchParams();
    if (subjectId) params.set('subjectId', subjectId);
    return requestJson<string[]>(`/api/categories${params.toString() ? `?${params}` : ''}`);
  },
  scorers(subjectId?: string | null) {
    const params = new URLSearchParams();
    if (subjectId) params.set('subjectId', subjectId);
    return requestJson<string[]>(`/api/scorers${params.toString() ? `?${params}` : ''}`);
  },
  list(query: ImageQuery & { page: number; pageSize: number }) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value == null || value === '') return;
      if (Array.isArray(value)) params.set(key, value.join(','));
      else if (typeof value === 'object') params.set(key, JSON.stringify(value));
      else params.set(key, String(value));
    });
    return requestJsonWithRetry<ImagePage>(`/api/images?${params}`);
  },
  ...importApi,
  saveScore(id: string, score: ImageScore) {
    return requestJson<ImageItem>(`/api/images/${id}/score`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(score) });
  },
  deleteSubject(id: string) {
    return requestJson<{ subject: SubjectItem; deletedImages: number; queued: boolean }>(`/api/subjects/${id}`, { method: 'DELETE' });
  }
};
