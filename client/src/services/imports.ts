import type { SubjectItem } from '../types/image';
import { handleUnauthorized, requestJson, requestResponse } from './http';

const ZIP_CHUNK_SIZE = 12 * 1024 * 1024;
const ZIP_CHUNK_RETRY_COUNT = 6;
const ZIP_CHUNK_RETRY_BASE_DELAY = 1000;
const UPLOAD_RECOVERY_ATTEMPT_LIMIT = 5;
const IMPORT_STATUS_POLL_INTERVAL = 10_000;
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

function delay(milliseconds: number) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
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

export const importApi = {
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
};
