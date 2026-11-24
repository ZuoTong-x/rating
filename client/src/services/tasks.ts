import type { AdminTaskListItem, ProjectItem, RankingRelation, RatingTask, ScorerDashboard, ScorerProjectOption, ScorerTaskListItem, SubjectItem, SubjectTaskReport, TaskListPage, TaskSubmissionMode } from '../types/image';
import { requestJson, requestJsonWithRetry, requestResponse } from './http';
import { runAdminExport, type AdminExportOptions } from './admin-exports';

function downloadFilename(contentDisposition: string | null, fallback: string) {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}


export type TaskAllocationImportResult = {
  filename: string;
  hasHeader: boolean;
  scorerColumn: number;
  countColumn: number;
  rows: Array<{ rowNumber: number; scorer: string; taskCount: number }>;
  errors: string[];
};

type TaskCompletionPayload = {
  scorer: string;
  projectId?: string | null;
  claimToken?: string | null;
  ranking: string[];
  rankingRelations?: RankingRelation[];
  excludedImageIds?: string[];
  correctImageIds?: string[];
  submissionMode?: TaskSubmissionMode;
  rankingActionCount?: number;
  dragActionCount?: number;
  orderChanged?: boolean;
  largeImageOpened?: boolean;
  largeImageOpenCount?: number;
  firstActionMs?: number | null;
  pageBlurCount?: number;
  durationMs: number;
};

export const taskApi = {
  assignedTaskOptions: () => requestJsonWithRetry<{ projects: ScorerProjectOption[] }>('/api/tasks/assigned/options'),
  taskReport(subjectId: string) {
    return requestJson<SubjectTaskReport>(`/api/subjects/${encodeURIComponent(subjectId)}/tasks/report`);
  },
  projectTaskReport(projectId: string) {
    return requestJson<SubjectTaskReport>(`/api/projects/${encodeURIComponent(projectId)}/tasks/report`);
  },
  async exportTaskReport(subjectId: string) {
    const response = await requestResponse(`/api/subjects/${encodeURIComponent(subjectId)}/tasks/report/export`);

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = downloadFilename(response.headers.get('content-disposition'), 'task-report.xlsx');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  },
  async exportProjectTaskReport(projectId: string, options?: AdminExportOptions) {
    return runAdminExport('project-task-report', { projectId }, options);
  },
  tasks(subjectId: string, query: {
    page?: number;
    pageSize?: number;
    cursor?: string | null;
    status?: RatingTask['status'] | null;
    scorer?: string | null;
    criterion?: RatingTask['criterion'] | null;
  } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.status) params.set('status', query.status);
    if (query.scorer) params.set('scorer', query.scorer);
    if (query.criterion) params.set('criterion', query.criterion);
    return requestJson<{ subject: SubjectItem } & TaskListPage<AdminTaskListItem>>(
      `/api/subjects/${encodeURIComponent(subjectId)}/tasks${params.toString() ? `?${params}` : ''}`
    );
  },
  projectTasks(projectId: string, query: {
    page?: number;
    pageSize?: number;
    cursor?: string | null;
    includeTotal?: boolean;
    status?: RatingTask['status'] | null;
    scorer?: string | null;
    criterion?: RatingTask['criterion'] | null;
  } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.includeTotal) params.set('includeTotal', '1');
    if (query.status) params.set('status', query.status);
    if (query.scorer) params.set('scorer', query.scorer);
    if (query.criterion) params.set('criterion', query.criterion);
    return requestJson<{ subject: SubjectItem; project: ProjectItem } & TaskListPage<AdminTaskListItem>>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks${params.toString() ? `?${params}` : ''}`
    );
  },
  adminTaskDetail(subjectId: string, taskId: string) {
    return requestJson<{ task: RatingTask }>(
      `/api/subjects/${encodeURIComponent(subjectId)}/tasks/${encodeURIComponent(taskId)}`
    );
  },
  adminProjectTaskDetail(projectId: string, taskId: string) {
    return requestJson<{ task: RatingTask }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`
    );
  },
  taskOptions(subjectId: string) {
    return requestJson<{ scorers: string[] }>(
      `/api/subjects/${encodeURIComponent(subjectId)}/tasks/options`
    );
  },
  projectTaskOptions(projectId: string) {
    return requestJson<{ scorers: string[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/options`
    );
  },
  assignedTasks(query: {
    scorer: string;
    projectId?: string | null;
    page?: number;
    pageSize?: number;
    cursor?: string | null;
    includeTotal?: boolean;
    status?: 'assigned' | 'completed' | null;
    criterion?: RatingTask['criterion'] | null;
    summaryOnly?: boolean;
    excludeTaskId?: string | null;
    availableOnly?: boolean;
  }) {
    const params = new URLSearchParams();
    params.set('scorer', query.scorer);
    if (query.projectId) params.set('projectId', query.projectId);
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.includeTotal) params.set('includeTotal', '1');
    if (query.status) params.set('status', query.status);
    if (query.criterion) params.set('criterion', query.criterion);
    if (query.summaryOnly) params.set('summaryOnly', '1');
    if (query.excludeTaskId) params.set('excludeTaskId', query.excludeTaskId);
    if (query.availableOnly) params.set('availableOnly', '1');
    return requestJsonWithRetry<TaskListPage<ScorerTaskListItem>>(`/api/tasks/assigned?${params}`);
  },
  assignedTaskDetail(taskId: string, claimToken?: string | null) {
    const params = new URLSearchParams();
    if (claimToken) params.set('claimToken', claimToken);
    const query = params.toString();
    return requestJson<{ task: RatingTask }>(
      `/api/tasks/${encodeURIComponent(taskId)}${query ? `?${query}` : ''}`,
    );
  },
  releaseTaskClaim(taskId: string, claimToken: string) {
    return requestJson<{ released: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimToken })
    });
  },
  scorerDashboard(query: { scorer: string; projectId?: string | null }) {
    const params = new URLSearchParams();
    params.set('scorer', query.scorer);
    if (query.projectId) params.set('projectId', query.projectId);
    return requestJsonWithRetry<ScorerDashboard>(`/api/scorer/dashboard?${params}`);
  },
  completeTask(taskId: string, payload: TaskCompletionPayload) {
    return requestJson<{ task: RatingTask }>(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  updateCompletedTask(taskId: string, payload: TaskCompletionPayload) {
    return requestJson<{ task: RatingTask }>(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  generateProjectTasks(projectId: string, assignment: {
    teamIds: string[];
    teamMatchMode: 'all' | 'any';
    allocations: Array<{ scorer: string; taskCount: number }>;
    backtestRatio?: number;
  }) {
    return requestJson<{
      jobId: string;
      subjectId: string;
      projectId: string;
      status: 'queued' | 'running' | 'completed' | 'failed';
      stage: string;
      progress: number;
      message: string | null;
      result?: { project: ProjectItem; taskCount: number; createdCount: number; assignedCount: number; baseAssignedCount?: number; backtestCount?: number; backtestRatio?: number; unassignedCount: number; taskVersion: string };
    }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamIds: assignment.teamIds,
        teamMatchMode: assignment.teamMatchMode,
        allocations: assignment.allocations,
        backtestRatio: assignment.backtestRatio ?? 0
      })
    });
  },
  generateExactProjectTasks(projectId: string, assignment: {
    file: File;
    teamIds: string[];
    teamMatchMode: 'all' | 'any';
    fallbackScorer: string;
  }) {
    const body = new FormData();
    body.append('file', assignment.file, assignment.file.name);
    body.append('teamIds', JSON.stringify(assignment.teamIds));
    body.append('teamMatchMode', assignment.teamMatchMode);
    body.append('fallbackScorer', assignment.fallbackScorer);
    return requestJson<{
      jobId: string;
      subjectId: string;
      projectId: string;
      status: 'queued' | 'running' | 'completed' | 'failed';
      stage: string;
      progress: number;
      message: string | null;
      result?: { project: ProjectItem; taskCount: number; createdCount: number; assignedCount: number; baseAssignedCount?: number; backtestCount?: number; backtestRatio?: number; fallbackScorer?: string; fallbackTaskCount?: number; unassignedCount: number; taskVersion: string };
    }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/generate/exact`, {
      method: 'POST',
      body
    });
  },
  projectTaskGenerationStatus(projectId: string, jobId: string) {
    return requestJsonWithRetry<{
      jobId: string;
      subjectId: string;
      projectId: string;
      status: 'queued' | 'running' | 'completed' | 'failed';
      stage: string;
      progress: number;
      message: string | null;
      result?: { project: ProjectItem; taskCount: number; createdCount: number; assignedCount: number; baseAssignedCount?: number; backtestCount?: number; backtestRatio?: number; unassignedCount: number; taskVersion: string };
    }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/generate/${encodeURIComponent(jobId)}`);
  },
  taskReassignmentOptions(subjectId: string) {
    return requestJson<{
      users: Array<{ id: string; username: string }>;
      availableTaskCount: number;
      sourceScorers: Array<{ username: string; taskCount: number }>;
    }>(`/api/subjects/${encodeURIComponent(subjectId)}/tasks/reassignment-options`);
  },
  projectTaskReassignmentOptions(projectId: string) {
    return requestJson<{
      users: Array<{ id: string; username: string }>;
      availableTaskCount: number;
      sourceScorers: Array<{ username: string; taskCount: number }>;
    }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/reassignment-options`);
  },
  importProjectTaskAllocations(projectId: string, file: File) {
    const body = new FormData();
    body.append('file', file, file.name);
    return requestJson<TaskAllocationImportResult>(
      `/api/projects/${encodeURIComponent(projectId)}/tasks/allocations/import`,
      { method: 'POST', body }
    );
  },
  reassignTasks(subjectId: string, payload: {
    scorers: string[];
    taskCount: number | null;
    source: 'assigned_uncompleted' | 'selected_scorers';
    sourceScorers?: string[];
    allocations?: Array<{ scorer: string; taskCount: number }>;
  }) {
    return requestJson<{
      reassignedCount: number;
      remainingTaskCount: number;
      distribution: Record<string, number>;
    }>(`/api/subjects/${encodeURIComponent(subjectId)}/tasks/reassign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  reassignProjectTasks(projectId: string, payload: {
    scorers: string[];
    taskCount: number | null;
    source: 'assigned_uncompleted' | 'selected_scorers';
    sourceScorers?: string[];
    allocations?: Array<{ scorer: string; taskCount: number }>;
  }) {
    return requestJson<{
      reassignedCount: number;
      remainingTaskCount: number;
      distribution: Record<string, number>;
    }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/reassign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
};
