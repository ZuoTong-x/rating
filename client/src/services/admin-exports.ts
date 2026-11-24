import type { AdminExportJob, AdminExportType } from '../types/image';
import { requestJson } from './http';

export type AdminExportOptions = {
  onProgress?: (job: AdminExportJob) => void;
};

export type TeamTaskSummaryExportOptions = AdminExportOptions & {
  excludeInactiveScorers?: boolean;
};

export type ScorerTaskSummaryExportOptions = AdminExportOptions & {
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
    await new Promise(resolve => window.setTimeout(resolve, nextPollDelay));
    nextPollDelay = 10_000;
    current = await requestJson<AdminExportJob>(`/api/admin/exports/${encodeURIComponent(current.jobId)}`);
  }
}

export async function runAdminExport(
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
