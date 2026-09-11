import type { AdminDashboard, AdminDashboardAverageDuration, AdminDashboardCharts, AdminDashboardProjectSection, AdminDashboardStats, AdminDashboardWorkloadSection, AdminExportJob, AdminExportType, AdminTaskListItem, FeedbackPage, FeedbackStatus, FeedbackType, ImageItem, ImagePage, ImageQuery, ImageScore, ProjectItem, ProjectPage, RankingRelation, RatingTask, ScorerDashboard, ScorerProjectOption, ScorerTaskListItem, ScoringManagementSummary, ScoringRollbackJob, ScoringRollbackPreview, ScoringTaskRecordPage, SubjectItem, SubjectTaskReport, TaskListPage, TaskSubmissionMode, TaskSubmissionModeFilter } from '../types/image';
import { handleUnauthorized, requestJson, requestJsonWithRetry, requestResponse } from './http';

function downloadFilename(contentDisposition: string | null, fallback: string) {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

const ZIP_CHUNK_SIZE = 12 * 1024 * 1024;
const ZIP_CHUNK_RETRY_COUNT = 6;
const ZIP_CHUNK_RETRY_BASE_DELAY = 1000;
const UPLOAD_RECOVERY_ATTEMPT_LIMIT = 5;
const IMPORT_STATUS_POLL_INTERVAL = 10_000;
const ADMIN_EXPORT_STATUS_POLL_INTERVAL = 10_000;
const RESUMABLE_UPLOAD_STORAGE_PREFIX = 'resumable-zip-upload:';
const TUS_VERSION = '1.0.0';

export type ImportJob = {
  uploadId: string;
  originalFilename?: string | null;
  status: 'queued' | 'merging' | 'importing' | 'awaiting_json' | 'completed' | 'failed';
  stage: string;
  progress: number;
  message: string | null;
  awaitingJson?: boolean;
  result?: { subject: SubjectItem; imported: number; skipped: number; batch: string };
};

type ResumableUploadSession = {
  uploadId: string;
  uploadUrl: string;
  originalFilename: string;
  uploadLength: number;
  offset: number;
  expiresAt: string;
};

type ResumableUploadProbe = {
  status: 'uploading' | 'processing' | 'missing';
  offset: number;
  uploadLength: number;
};

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

function delay(milliseconds: number) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

type AdminExportOptions = {
  onProgress?: (job: AdminExportJob) => void;
};

type TeamTaskSummaryExportOptions = AdminExportOptions & {
  excludeInactiveScorers?: boolean;
};

type ScorerTaskSummaryExportOptions = AdminExportOptions & {
  completedFrom?: string | null;
  completedTo?: string | null;
};

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function waitForAdminExportJob(job: AdminExportJob, onProgress?: (job: AdminExportJob) => void) {
  let current = job;
  let nextPollDelay = 1000;
  while (true) {
    onProgress?.(current);
    if (current.status === 'completed') return current;
    if (current.status === 'failed') throw new Error(current.message || '导出失败，请重试');
    await delay(nextPollDelay);
    nextPollDelay = ADMIN_EXPORT_STATUS_POLL_INTERVAL;
    current = await requestJson<AdminExportJob>(`/api/admin/exports/${encodeURIComponent(current.jobId)}`);
  }
}

async function runAdminExport(
  type: AdminExportType,
  payload: Record<string, unknown>,
  options?: AdminExportOptions
) {
  const job = await requestJson<AdminExportJob>('/api/admin/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...payload })
  });
  const completed = await waitForAdminExportJob(job, options?.onProgress);
  if (!completed.downloadUrl) throw new Error('导出文件缺少下载地址');
  triggerDownload(completed.downloadUrl, completed.filename);
  return completed;
}

export function createUploadId() {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) return randomUUID;

  // HTTP 或旧浏览器可能没有 randomUUID，回退值也必须只包含服务端允许的字符。
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function resumableStorageKey(file: File) {
  return [
    RESUMABLE_UPLOAD_STORAGE_PREFIX,
    file.name,
    file.size,
    file.lastModified,
    file.type || 'application/octet-stream'
  ].join('|');
}

function encodeUploadMetadataValue(value: string) {
  return btoa(unescape(encodeURIComponent(value)));
}

function decodeUploadMetadataValue(value: string) {
  return decodeURIComponent(escape(atob(value)));
}

function getStoredResumableSession(file: File) {
  const raw = window.localStorage.getItem(resumableStorageKey(file));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ResumableUploadSession;
    if (
      !parsed ||
      parsed.originalFilename !== file.name ||
      parsed.uploadLength !== file.size ||
      typeof parsed.uploadUrl !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setStoredResumableSession(file: File, session: ResumableUploadSession) {
  window.localStorage.setItem(resumableStorageKey(file), JSON.stringify(session));
}

function clearStoredResumableSession(file: File) {
  window.localStorage.removeItem(resumableStorageKey(file));
}

function parseOffsetHeader(value: string | null) {
  if (!value) return NaN;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : NaN;
}

async function createResumableSession(file: File): Promise<ResumableUploadSession> {
  const response = await requestResponse('/api/import/uploads', {
    method: 'POST',
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(file.size),
      'Upload-Metadata': `filename ${encodeUploadMetadataValue(file.name)}`
    }
  });

  const body = await response.json().catch(() => null) as
    | { uploadId?: string; uploadUrl?: string; originalFilename?: string; uploadLength?: number; offset?: number; expiresAt?: string }
    | null;
  const uploadUrl = body?.uploadUrl || response.headers.get('location') || '';
  const uploadId = body?.uploadId || uploadUrl.split('/').filter(Boolean).pop() || '';
  const originalFilename = body?.originalFilename || file.name;
  const uploadLength = body?.uploadLength || file.size;
  const offset = body?.offset ?? 0;
  const expiresAt = body?.expiresAt || response.headers.get('upload-expires') || '';
  if (!uploadUrl || !uploadId) throw new Error('无法创建可续传上传会话');

  return { uploadId, uploadUrl, originalFilename, uploadLength, offset, expiresAt };
}

async function probeResumableSession(uploadUrl: string): Promise<ResumableUploadProbe> {
  let response: Response;
  try {
    response = await requestResponse(uploadUrl, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': TUS_VERSION }
    });
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status === 404 || status === 410) {
      return { status: 'missing', offset: 0, uploadLength: 0 };
    }
    if (status === 409) {
      return { status: 'processing', offset: 0, uploadLength: 0 };
    }
    throw error;
  }

  if (response.status === 404 || response.status === 410) {
    return { status: 'missing', offset: 0, uploadLength: 0 };
  }
  if (response.status === 409) {
    const offset = parseOffsetHeader(response.headers.get('upload-offset'));
    const uploadLength = parseOffsetHeader(response.headers.get('upload-length'));
    return {
      status: 'processing',
      offset: Number.isFinite(offset) ? offset : 0,
      uploadLength: Number.isFinite(uploadLength) ? uploadLength : 0
    };
  }
  const offset = parseOffsetHeader(response.headers.get('upload-offset'));
  const uploadLength = parseOffsetHeader(response.headers.get('upload-length'));
  return {
    status: 'uploading',
    offset: Number.isFinite(offset) ? offset : 0,
    uploadLength: Number.isFinite(uploadLength) ? uploadLength : 0
  };
}

async function patchResumableSession(
  uploadUrl: string,
  offset: number,
  chunk: Blob,
  onProgress?: (loaded: number, total: number) => void
) {
  return await new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', uploadUrl);
    xhr.timeout = 5 * 60 * 1000;
    xhr.setRequestHeader('Tus-Resumable', TUS_VERSION);
    xhr.setRequestHeader('Upload-Offset', String(offset));
    xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream');
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const nextOffset = parseOffsetHeader(xhr.getResponseHeader('upload-offset'));
        resolve(Number.isFinite(nextOffset) ? nextOffset : offset + chunk.size);
        return;
      }
      if (xhr.status === 401) {
        void handleUnauthorized();
      }
      const error = new Error(`上传分片失败 (${xhr.status})`) as Error & { status?: number; serverOffset?: number };
      error.status = xhr.status;
      const serverOffset = parseOffsetHeader(xhr.getResponseHeader('upload-offset'));
      if (Number.isFinite(serverOffset)) error.serverOffset = serverOffset;
      reject(error);
    };
    xhr.onerror = () => reject(new Error('网络连接中断，上传分片失败'));
    xhr.ontimeout = () => reject(new Error('上传分片超时，请重试'));
    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      };
    }
    xhr.send(chunk);
  });
}

async function uploadResumableChunkWithRetry(
  uploadUrl: string,
  offset: number,
  chunk: Blob,
  onProgress?: (loaded: number, total: number) => void
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < ZIP_CHUNK_RETRY_COUNT; attempt++) {
    try {
      return await patchResumableSession(uploadUrl, offset, chunk, onProgress);
    } catch (error) {
      lastError = error;
      const status = (error as Error & { status?: number }).status;
      const retryableStatus = !status || [408, 425, 429, 500, 502, 503, 504].includes(status);
      if (attempt + 1 < ZIP_CHUNK_RETRY_COUNT && retryableStatus) {
        const backoff = ZIP_CHUNK_RETRY_BASE_DELAY * (2 ** attempt);
        await delay(Math.min(backoff, 30_000));
        continue;
      }
      break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('上传分片失败');
}

async function waitForImportJob(
  uploadId: string,
  initialJob: ImportJob,
  onProcessing?: (job: ImportJob) => void
) {
  let job = initialJob;
  while (job.status === 'queued' || job.status === 'merging' || job.status === 'importing') {
    onProcessing?.(job);
    await delay(IMPORT_STATUS_POLL_INTERVAL);
    job = await requestJson<ImportJob>(
      `/api/import/uploads/${encodeURIComponent(uploadId)}/status`
    );
  }
  onProcessing?.(job);
  if (job.status === 'awaiting_json') {
    const error = new Error(job.message || 'JSON 校验失败，请补充修正后的 JSON') as Error & {
      awaitingJson?: boolean;
      uploadId?: string;
    };
    error.awaitingJson = true;
    error.uploadId = uploadId;
    throw error;
  }
  if (job.status === 'failed') {
    const error = new Error(job.message || '项目导入失败') as Error & { terminal?: boolean };
    error.terminal = true;
    throw error;
  }
  if (!job.result) throw new Error('导入任务未返回结果');
  return job.result;
}

export const imageApi = {
  subjects: () => requestJson<SubjectItem[]>('/api/subjects'),
  pendingImportJobs: () => requestJson<ImportJob[]>('/api/import/pending-json'),
  projects: () => requestJson<ProjectItem[]>('/api/projects'),
  assignedTaskOptions: () => requestJsonWithRetry<{ projects: ScorerProjectOption[] }>('/api/tasks/assigned/options'),
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
  deleteProject(id: string) {
    return requestJson<{ deleted: boolean; deletedTaskCount: number }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  adminDashboard(query: { projectId?: string | null; scorerId?: string | null; teamId?: string | null; page?: number; pageSize?: number } = {}) {
    const params = new URLSearchParams();
    if (query.projectId) params.set('projectId', query.projectId);
    if (query.scorerId) params.set('scorerId', query.scorerId);
    if (query.teamId) params.set('teamId', query.teamId);
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    return requestJson<AdminDashboard>(`/api/admin/dashboard${params.toString() ? `?${params}` : ''}`);
  },
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
  adminDashboardAverageDuration() {
    return requestJson<AdminDashboardAverageDuration>('/api/admin/dashboard/average-duration');
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
  adminScoringTasks(query: {
    page?: number;
    pageSize?: number;
    cursor?: string | null;
    includeTotal?: boolean;
    scorer?: string | null;
    projectId?: string | null;
    submissionMode?: TaskSubmissionModeFilter | null;
    riskFilter?: ScoringRiskFilter | null;
    minDurationSeconds?: number | null;
    maxDurationSeconds?: number | null;
  } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.includeTotal) params.set('includeTotal', '1');
    if (query.scorer) params.set('scorer', query.scorer);
    if (query.projectId) params.set('projectId', query.projectId);
    if (query.submissionMode) params.set('submissionMode', query.submissionMode);
    if (query.riskFilter) params.set('riskFilter', query.riskFilter);
    if (query.minDurationSeconds != null) params.set('minDurationSeconds', String(query.minDurationSeconds));
    if (query.maxDurationSeconds != null) params.set('maxDurationSeconds', String(query.maxDurationSeconds));
    return requestJson<ScoringTaskRecordPage>(`/api/admin/scoring/tasks${params.toString() ? `?${params}` : ''}`);
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
    return requestJsonWithRetry<TaskListPage<ScorerTaskListItem>>(`/api/tasks/assigned?${params}`);
  },
  assignedTaskDetail(taskId: string) {
    return requestJson<{ task: RatingTask }>(`/api/tasks/${encodeURIComponent(taskId)}`);
  },
  scorerDashboard(query: { scorer: string; projectId?: string | null }) {
    const params = new URLSearchParams();
    params.set('scorer', query.scorer);
    if (query.projectId) params.set('projectId', query.projectId);
    return requestJsonWithRetry<ScorerDashboard>(`/api/scorer/dashboard?${params}`);
  },
  feedbacks(query: { page?: number; pageSize?: number; status?: FeedbackStatus | null } = {}) {
    const params = new URLSearchParams();
    if (query.page) params.set('page', String(query.page));
    if (query.pageSize) params.set('pageSize', String(query.pageSize));
    if (query.status) params.set('status', query.status);
    return requestJsonWithRetry<FeedbackPage>(`/api/feedbacks${params.toString() ? `?${params}` : ''}`);
  },
  submitFeedback(payload: { title: string; type: FeedbackType; description: string; images: File[] }) {
    const body = new FormData();
    body.append('title', payload.title);
    body.append('type', payload.type);
    body.append('description', payload.description);
    payload.images.forEach(image => body.append('images', image, image.name));
    return requestJson<{ feedback: import('../types/image').FeedbackItem }>('/api/feedbacks', {
      method: 'POST',
      body
    });
  },
  replyFeedback(id: string, payload: { status: FeedbackStatus; reply: string }) {
    return requestJson<{ feedback: import('../types/image').FeedbackItem }>(`/api/feedbacks/${encodeURIComponent(id)}/reply`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  },
  replyFeedbackMessage(id: string, content: string) {
    return requestJson<{ feedback: import('../types/image').FeedbackItem }>(`/api/feedbacks/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  },
  setFeedbackStatus(id: string, status: FeedbackStatus) {
    return requestJson<{ feedback: import('../types/image').FeedbackItem }>(`/api/feedbacks/${encodeURIComponent(id)}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
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
  },
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
  importZip(file: File, options?: {
    uploadId?: string;
    onProgress?: (progress: number) => void;
    onProcessing?: (job: ImportJob) => void;
  }) {
    const onProgress = options?.onProgress;
    const totalBytes = Math.max(file.size, 1);

    return (async () => {
      const existingSession = getStoredResumableSession(file);
      let session = existingSession;
      let uploadCompleted = false;
      let recoveryAttempts = 0;
      try {
        onProgress?.(0);
        if (!session) {
          session = await createResumableSession(file);
          setStoredResumableSession(file, session);
        } else {
          const probe = await probeResumableSession(session.uploadUrl);
          if (probe.status === 'missing') {
            const existingJob = await requestJson<ImportJob>(
              `/api/import/uploads/${encodeURIComponent(session.uploadId)}/status`
            ).catch(() => null);
            if (existingJob) {
              uploadCompleted = true;
              const result = await waitForImportJob(session.uploadId, existingJob, options?.onProcessing);
              clearStoredResumableSession(file);
              return result;
            }
            clearStoredResumableSession(file);
            session = await createResumableSession(file);
            setStoredResumableSession(file, session);
          } else if (probe.status === 'processing') {
            const job = await requestJson<ImportJob>(
              `/api/import/uploads/${encodeURIComponent(session.uploadId)}/status`
            );
            uploadCompleted = true;
            const result = await waitForImportJob(session.uploadId, job, options?.onProcessing);
            clearStoredResumableSession(file);
            return result;
          } else {
            session.offset = probe.offset;
            session.uploadLength = probe.uploadLength || file.size;
            setStoredResumableSession(file, session);
          }
        }

        let currentOffset = session.offset;
        const reportedBytes = () => Math.min(99, (currentOffset / totalBytes) * 100);
        onProgress?.(reportedBytes());

        while (currentOffset < file.size) {
          const start = currentOffset;
          const end = Math.min(file.size, start + ZIP_CHUNK_SIZE);
          const chunk = file.slice(start, end);
          try {
            const nextOffset = await uploadResumableChunkWithRetry(
              session.uploadUrl,
              currentOffset,
              chunk,
              (loaded, total) => {
                const committed = Math.min(
                  currentOffset + Math.min(loaded, total || chunk.size),
                  file.size,
                );
                onProgress?.(Math.min(99, (committed / totalBytes) * 100));
              },
            );
            currentOffset = Math.max(nextOffset, end);
            session = { ...session, offset: currentOffset };
            setStoredResumableSession(file, session);
            onProgress?.(reportedBytes());
            recoveryAttempts = 0;
          } catch (error) {
            recoveryAttempts += 1;
            if (recoveryAttempts > UPLOAD_RECOVERY_ATTEMPT_LIMIT) throw error;
            const status = (error as Error & { status?: number }).status;
            const serverOffset = (error as Error & { serverOffset?: number }).serverOffset;
            if (status === 409 && Number.isFinite(serverOffset)) {
              currentOffset = Math.min(serverOffset as number, file.size);
              session = { ...session, offset: currentOffset };
              setStoredResumableSession(file, session);
              onProgress?.(reportedBytes());
              continue;
            }

            const probe = await probeResumableSession(session.uploadUrl).catch(() => null);
            if (probe?.status === 'processing') {
              const job = await requestJson<ImportJob>(
                `/api/import/uploads/${encodeURIComponent(session.uploadId)}/status`
              );
              uploadCompleted = true;
              const result = await waitForImportJob(session.uploadId, job, options?.onProcessing);
              clearStoredResumableSession(file);
              return result;
            }
            if (probe?.status === 'uploading') {
              currentOffset = Math.min(probe.offset, file.size);
              session = { ...session, offset: currentOffset };
              setStoredResumableSession(file, session);
              onProgress?.(reportedBytes());
              continue;
            }
            if (probe?.status === 'missing') {
              clearStoredResumableSession(file);
              session = await createResumableSession(file);
              currentOffset = 0;
              setStoredResumableSession(file, session);
              onProgress?.(0);
              continue;
            }

            const existingJob = await requestJson<ImportJob>(
              `/api/import/uploads/${encodeURIComponent(session.uploadId)}/status`
            ).catch(() => null);
            if (existingJob) {
              uploadCompleted = true;
              const result = await waitForImportJob(session.uploadId, existingJob, options?.onProcessing);
              clearStoredResumableSession(file);
              return result;
            }
            throw error;
          }
        }

        onProgress?.(100);
        uploadCompleted = true;
        const completeJob = await requestJson<ImportJob>(
          `/api/import/uploads/${encodeURIComponent(session.uploadId)}/status`
        );
        const result = await waitForImportJob(session.uploadId, completeJob, options?.onProcessing);
        clearStoredResumableSession(file);
        return result;
      } catch (error) {
        const typedError = error as Error & { terminal?: boolean; awaitingJson?: boolean };
        if (uploadCompleted && (typedError.terminal || typedError.awaitingJson)) {
          clearStoredResumableSession(file);
        }
        throw error;
      }
    })();
  },
  supplementImportJson(uploadId: string, file: File, options?: {
    onProcessing?: (job: ImportJob) => void;
  }) {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return (async () => {
      const job = await requestJson<ImportJob>(
        `/api/import/uploads/${encodeURIComponent(uploadId)}/supplement-json`,
        { method: 'POST', body: formData }
      );
      return waitForImportJob(uploadId, job, options?.onProcessing);
    })();
  },
  saveScore(id: string, score: ImageScore) {
    return requestJson<ImageItem>(`/api/images/${id}/score`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(score) });
  },
  deleteSubject(id: string) {
    return requestJson<{ subject: SubjectItem; deletedImages: number; queued: boolean }>(`/api/subjects/${id}`, { method: 'DELETE' });
  }
};
