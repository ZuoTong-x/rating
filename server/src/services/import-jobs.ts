import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { Request } from "express";
import type { db as database } from "../postgres.ts";
import type { importZipArchive as importArchiveFunction } from "./import-archive.ts";
import type { createImportManifestService } from "./import-manifest.ts";

type Statement = ReturnType<typeof database.prepare>;
type ManifestService = ReturnType<typeof createImportManifestService>;
type ImportJob = {
  uploadId: string; originalFilename: string; zipPath: string; dir: string;
  totalChunks: number; protocol: string; uploadLength: number | null;
  uploadOffset: number; metadata: string | null; status: string; stage: string;
  progress: number; message: string | null; result: unknown; createdAt: string;
  expiresAt: string; pendingJson?: boolean; lastPersistedProgress?: number;
};
export type UploadSession = {
  uploadId: string; originalFilename: string; uploadLength: number;
  status: string; createdAt: string; updatedAt: string; expiresAt: string;
};
export type LoadedUploadSession = UploadSession & {
  dir: string; metaPath: string; filePath: string; offset: number;
};
type ImportJobRow = Record<string, unknown>;
type ServiceDependencies = Parameters<typeof importArchiveFunction>[3] & {
  httpError: (status: number, message: string) => Error & { status?: number };
  chunkUploadDir: string; pendingJsonImportDir: string; resumableUploadDir: string;
  resumableUploadExpiryMs: number; tusVersion: string; maxZipBytes: number;
  importArchive: typeof importArchiveFunction;
  importJobs: Map<string, ImportJob>;
  deleteImportJobStmt: Statement; updateImportJobStmt: Statement;
  selectPendingImportJobsStmt: Statement;
  loadSupplementalJsonArchive: ManifestService["loadSupplementalJsonArchive"];
};

function importError(error: unknown) {
  return error as Error & { code?: string; status?: number; isSupplementableJsonError?: boolean };
}

export function createImportJobsService({
    allocateSubjectStorageRoot, archiveImportError, assertArchiveLimits,
    assertTaskManifestValid, buildArchiveImageReferenceRecords,
    buildTaskTemplateRecords, bulkInsertImageRecords,
    bulkInsertSubjectTaskTemplateItems, bulkInsertSubjectTaskTemplates,
    catalogEntryForImage, catalogPrompt, chunkUploadDir, cleanRelative,
    db, decodeZipEntryPath, decompressionLimit, deleteImportJobStmt,
    httpError, imageExts, imageImportConcurrency, importArchive, importJobs,
    insertSubjectStmt, isInfographicPath, isMacMetadataEntry,
    loadArchiveManifests, loadArchiveTaskManifest, loadImageCatalogIndex,
    loadSupplementalJsonArchive, markSubjectImportFailedStmt,
    maxImageUncompressedBytes, maxZipBytes, normalizeArchiveImportError,
    nowIso, openZip64Archive, pendingJsonImportDir,
    refreshSubjectTaskTemplateStats, resumableUploadDir,
    resumableUploadExpiryMs, scheduleImportedThumbnailJobs,
    selectPendingImportJobsStmt, selectSubjectByIdStmt, subjectDto,
    tusVersion, updateImportJobStmt, updateSubjectCountsStmt, uploadDir,
    validateTaskManifest, markSupplementableJsonError,
}: ServiceDependencies) {
function validateUploadId(uploadId: string) {
  if (!/^[a-z0-9-]{8,128}$/i.test(uploadId)) {
    throw httpError(400, "上传标识不正确");
  }
}

function chunkDir(uploadId: string) {
  validateUploadId(uploadId);
  return path.join(chunkUploadDir, uploadId);
}

function chunkFilePath(uploadId: string, index: number) {
  return path.join(
    chunkDir(uploadId),
    `${String(index).padStart(6, "0")}.part`,
  );
}

function resumableSessionDir(uploadId: string) {
  validateUploadId(uploadId);
  return path.join(resumableUploadDir, uploadId);
}

function resumableSessionMetaPath(uploadId: string) {
  return path.join(resumableSessionDir(uploadId), "upload.json");
}

function resumableSessionFilePath(uploadId: string) {
  return path.join(resumableSessionDir(uploadId), "upload.zip");
}

function resumableUploadExpiresAt() {
  return new Date(Date.now() + resumableUploadExpiryMs).toISOString();
}

function pendingJsonImportPath(uploadId: string) {
  validateUploadId(uploadId);
  return path.join(pendingJsonImportDir, uploadId, "source.zip");
}

function markImportJobMetadata(job: ImportJob, patch: Record<string, unknown>) {
  let metadata: Record<string, unknown> = {};
  if (job.metadata) {
    try {
      const parsed = JSON.parse(job.metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed;
      }
    } catch {}
  }
  job.metadata = JSON.stringify({ ...metadata, ...patch });
}

async function moveFile(sourcePath: string, targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (importError(error).code !== "EXDEV") throw error;
    await fs.copyFile(sourcePath, targetPath);
    await fs.unlink(sourcePath);
  }
}

async function preservePendingJsonImportSource(job: ImportJob) {
  const targetPath = pendingJsonImportPath(job.uploadId);
  if (path.resolve(job.zipPath) !== path.resolve(targetPath)) {
    await moveFile(job.zipPath, targetPath);
  }
  job.zipPath = targetPath;
  job.pendingJson = true;
  markImportJobMetadata(job, { pendingJson: true });
}

async function cleanupPendingJsonImport(uploadId: string) {
  validateUploadId(uploadId);
  await fs.rm(path.join(pendingJsonImportDir, uploadId), {
    recursive: true,
    force: true,
  });
}

function tusMetadataHeaderValue(value: unknown) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function parseTusMetadataHeader(header: unknown) {
  const metadata: Record<string, string> = {};
  const raw = String(header || "").trim();
  if (!raw) return metadata;

  for (const pair of raw.split(",")) {
    const entry = pair.trim();
    if (!entry) continue;
    const separator = entry.indexOf(" ");
    const key = (separator >= 0 ? entry.slice(0, separator) : entry).trim();
    if (!key) continue;
    const encodedValue = separator >= 0 ? entry.slice(separator + 1).trim() : "";
    if (!encodedValue) {
      metadata[key.toLowerCase()] = "";
      continue;
    }
    try {
      metadata[key.toLowerCase()] = Buffer.from(encodedValue, "base64").toString(
        "utf8",
      );
    } catch {
      throw httpError(400, "上传元数据格式不正确");
    }
  }

  return metadata;
}

function requireTusResumableHeader(req: Request) {
  const version = String(req.headers["tus-resumable"] || "");
  if (!version) throw httpError(412, "缺少 Tus-Resumable 请求头");
  if (version !== tusVersion) throw httpError(412, "Tus 版本不受支持");
}

function resumableUploadResponseHeaders(session: UploadSession, offset: number) {
  return {
    "Cache-Control": "no-store",
    "Location": `/api/import/uploads/${session.uploadId}`,
    "Tus-Resumable": tusVersion,
    "Tus-Version": tusVersion,
    "Tus-Extension": "creation,termination",
    "Tus-Max-Size": String(maxZipBytes),
    "Upload-Expires": session.expiresAt,
    "Upload-Length": String(session.uploadLength),
    "Upload-Metadata": `filename ${tusMetadataHeaderValue(session.originalFilename)}`,
    "Upload-Offset": String(offset),
  };
}

function resumableUploadDto(session: UploadSession, offset: number) {
  return {
    uploadId: session.uploadId,
    uploadUrl: `/api/import/uploads/${session.uploadId}`,
    originalFilename: session.originalFilename,
    uploadLength: session.uploadLength,
    offset,
    status: session.status,
    expiresAt: session.expiresAt,
  };
}

function writeJsonFileAtomic(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  return fs
    .writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    .then(() => fs.rename(tempPath, filePath))
    .catch(async (error) => {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    });
}

async function loadResumableUploadSession(uploadId: string): Promise<LoadedUploadSession | null> {
  validateUploadId(uploadId);
  const dir = resumableSessionDir(uploadId);
  const metaPath = resumableSessionMetaPath(uploadId);
  const filePath = resumableSessionFilePath(uploadId);

  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.uploadId !== uploadId) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const expiresAt = Date.parse(parsed.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const uploadLength = Number(parsed.uploadLength);
    if (!Number.isFinite(uploadLength) || uploadLength <= 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    if (stat.size > uploadLength) {
      throw httpError(409, "上传会话已损坏，请重新上传");
    }

    return {
      uploadId,
      originalFilename: String(parsed.originalFilename || ""),
      uploadLength,
      status: String(parsed.status || "uploading"),
      createdAt: String(parsed.createdAt || ""),
      updatedAt: String(parsed.updatedAt || ""),
      expiresAt: String(parsed.expiresAt || resumableUploadExpiresAt()),
      dir,
      metaPath,
      filePath,
      offset: stat.size,
    };
  } catch (error) {
    if (importError(error).status) throw error;
    if (importError(error).code === "ENOENT") {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

async function saveResumableUploadSession(session: UploadSession) {
  await fs.mkdir(resumableSessionDir(session.uploadId), { recursive: true });
  await writeJsonFileAtomic(resumableSessionMetaPath(session.uploadId), {
    uploadId: session.uploadId,
    originalFilename: session.originalFilename,
    uploadLength: session.uploadLength,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
  });
}

async function createResumableUploadSession(originalFilename: string, uploadLength: number) {
  const uploadId = crypto.randomUUID();
  const createdAt = nowIso();
  const session = {
    uploadId,
    originalFilename,
    uploadLength,
    status: "uploading",
    createdAt,
    updatedAt: createdAt,
    expiresAt: resumableUploadExpiresAt(),
  };

  await fs.mkdir(resumableSessionDir(uploadId), { recursive: true });
  await fs.writeFile(resumableSessionFilePath(uploadId), "");
  await saveResumableUploadSession(session);
  return session;
}

async function cleanupResumableUploadSession(uploadId: string) {
  await fs.rm(resumableSessionDir(uploadId), {
    recursive: true,
    force: true,
  });
}

async function sweepResumableUploadSessions() {
  const entries = await fs.readdir(resumableUploadDir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const uploadId = entry.name;
        if (!/^[a-z0-9-]{8,128}$/i.test(uploadId)) {
          await fs.rm(path.join(resumableUploadDir, uploadId), {
            recursive: true,
            force: true,
          }).catch(() => {});
          return;
        }
        const session = await loadResumableUploadSession(uploadId);
        if (!session) return;
        const expiresAt = Date.parse(session.expiresAt || "");
        if (!Number.isFinite(expiresAt) || expiresAt <= now || session.status !== "uploading") {
          await cleanupResumableUploadSession(uploadId).catch(() => {});
        }
      }),
  );
}

async function sweepPendingJsonImports() {
  const rows = await selectPendingImportJobsStmt.all(new Date().toISOString());
  const activeIds = new Set(rows.map((row) => row.uploadId));
  const entries = await fs
    .readdir(pendingJsonImportDir, { withFileTypes: true })
    .catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !activeIds.has(entry.name))
      .map((entry) =>
        fs.rm(path.join(pendingJsonImportDir, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );
}

function normalizeTusFilename(filename: unknown) {
  return path.basename(String(filename || "").replace(/\\/g, "/")).trim();
}

const resumableUploadLocks = new Map<string, Promise<void>>();

async function withResumableUploadLock<T>(uploadId: string, task: () => Promise<T>): Promise<T> {
  while (resumableUploadLocks.has(uploadId)) {
    await resumableUploadLocks.get(uploadId);
  }

  let release = () => {};
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  resumableUploadLocks.set(uploadId, lock);
  try {
    return await task();
  } finally {
    resumableUploadLocks.delete(uploadId);
    release();
  }
}

async function importZipArchive(zipPath: string, originalFilename: string, options: Parameters<typeof importArchiveFunction>[2] = {}) {
  return importArchive(zipPath, originalFilename, options, {
    nowIso, openZip64Archive, assertArchiveLimits, archiveImportError,
    cleanRelative, decodeZipEntryPath, isMacMetadataEntry, imageExts,
    loadArchiveManifests, loadArchiveTaskManifest, markSupplementableJsonError,
    buildArchiveImageReferenceRecords, validateTaskManifest, assertTaskManifestValid,
    loadImageCatalogIndex, allocateSubjectStorageRoot, uploadDir,
    catalogEntryForImage, isInfographicPath, decompressionLimit,
    maxImageUncompressedBytes, catalogPrompt, imageImportConcurrency,
    buildTaskTemplateRecords, insertSubjectStmt, bulkInsertImageRecords,
    bulkInsertSubjectTaskTemplates, refreshSubjectTaskTemplateStats,
    bulkInsertSubjectTaskTemplateItems, updateSubjectCountsStmt,
    scheduleImportedThumbnailJobs, selectSubjectByIdStmt, subjectDto,
    markSubjectImportFailedStmt, db, normalizeArchiveImportError,
  });
}

async function runResumableImportJob(job: ImportJob) {
  try {
    job.status = "importing";
    job.stage = "正在解析并导入图片";
    job.progress = 0;
    await persistImportJob(job);

    job.result = await importZipArchive(job.zipPath, job.originalFilename, {
      removeSource: false,
      onProgress: async ({ stage, progress, current, total }) => {
        if (stage) job.stage = stage;
        job.progress = Number.isFinite(progress)
          ? Math.min(99, Math.max(0, Math.round(progress)))
          : Math.min(99, Math.round((current / total) * 100));
        if (job.progress !== job.lastPersistedProgress) {
          job.lastPersistedProgress = job.progress;
          await persistImportJob(job);
        }
      },
    });

    job.status = "completed";
    job.stage = "导入完成";
    job.progress = 100;
    await persistImportJob(job);
  } catch (error) {
    const normalized = normalizeArchiveImportError(error);
    if (importError(error).isSupplementableJsonError) {
      try {
        await preservePendingJsonImportSource(job);
        job.status = "awaiting_json";
        job.stage = "等待补充 JSON";
        job.progress = 100;
        job.message = normalized.message || "JSON 校验失败，请补充修正后的 JSON";
        job.result = null;
        await persistImportJob(job);
      } catch (preserveError) {
        job.status = "failed";
        job.stage = "导入失败";
        job.message = "JSON 校验失败，且无法保留原始 ZIP，请重新上传";
        await persistImportJob(job);
        console.error(`Failed to preserve resumable ZIP import (${job.uploadId})`, preserveError);
      }
    } else {
      job.status = "failed";
      job.stage = "导入失败";
      job.message = normalized.message || "导入失败，请重试";
      await persistImportJob(job);
    }
    console.error(`Resumable ZIP import failed (${job.uploadId})`, error);
  } finally {
    await cleanupResumableUploadSession(job.uploadId).catch(() => {});
    if (job.status !== "awaiting_json") {
      await fs.unlink(job.zipPath).catch(() => {});
    }

    // 保留结果一段时间，允许前端在短暂断线后继续查询本次任务。
    setTimeout(
      async () => {
        importJobs.delete(job.uploadId);
        await deleteImportJobStmt.run(job.uploadId);
        await cleanupPendingJsonImport(job.uploadId).catch(() => {});
      },
      24 * 60 * 60 * 1000,
    ).unref();
  }
}

function importJobExpiry() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function importJobDto(job: ImportJob) {
  const payload: Record<string, unknown> = {
    uploadId: job.uploadId,
    originalFilename: job.originalFilename || null,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
    awaitingJson: job.status === "awaiting_json",
  };
  if (job.result) payload.result = job.result;
  return payload;
}

function importJobFromRow(row: ImportJobRow | undefined): ImportJob | null {
  if (!row) return null;
  let result = null;
  if (row.resultJson) {
    try {
      result = JSON.parse(String(row.resultJson));
    } catch {
      result = null;
    }
  }
  return {
    uploadId: String(row.uploadId),
    originalFilename: String(row.originalFilename || ""),
    zipPath: row.status === "awaiting_json"
      ? pendingJsonImportPath(String(row.uploadId))
      : "",
    dir: "",
    totalChunks: Number(row.totalChunks || 0),
    protocol: String(row.protocol || "chunked"),
    uploadLength: row.uploadLength == null ? null : Number(row.uploadLength),
    uploadOffset: Number(row.uploadOffset || 0),
    metadata: row.metadata == null ? null : String(row.metadata),
    status: String(row.status),
    stage: String(row.stage),
    progress: Number(row.progress || 0),
    message: row.message == null ? null : String(row.message),
    result,
    createdAt: String(row.createdAt),
    expiresAt: String(row.expiresAt),
  };
}

async function persistImportJob(job: ImportJob) {
  job.expiresAt = job.expiresAt || importJobExpiry();
  const updatedAt = nowIso();
  await updateImportJobStmt.run({
    uploadId: job.uploadId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
    resultJson: job.result ? JSON.stringify(job.result) : null,
    protocol: job.protocol || "chunked",
    uploadLength: job.uploadLength ?? null,
    uploadOffset: job.uploadOffset ?? 0,
    metadata: job.metadata ?? null,
    updatedAt,
    expiresAt: job.expiresAt,
  });
}

async function mergeChunkedZip(job: ImportJob) {
  let totalBytes = 0;
  const partPaths = [];

  for (let index = 0; index < job.totalChunks; index++) {
    const partPath = chunkFilePath(job.uploadId, index);
    let stat;
    try {
      stat = await fs.stat(partPath);
    } catch {
      throw httpError(400, `缺少第 ${index + 1} 个分片`);
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw httpError(400, `第 ${index + 1} 个分片无效`);
    }
    totalBytes += stat.size;
    if (totalBytes > maxZipBytes) {
      throw httpError(413, "ZIP 文件超过服务器允许的大小限制");
    }
    partPaths.push(partPath);
  }

  const output = await fs.open(job.zipPath, "w");
  let mergedBytes = 0;
  try {
    for (const partPath of partPaths) {
      for await (const chunk of createReadStream(partPath)) {
        await output.write(chunk);
        mergedBytes += chunk.length;
        job.progress = Math.min(
          15,
          Math.round((mergedBytes / totalBytes) * 15),
        );
      }
    }
  } finally {
    await output.close();
  }
}

async function runChunkedImportJob(job: ImportJob) {
  try {
    job.status = "merging";
    job.stage = "正在合并上传分片";
    job.progress = 0;
    await persistImportJob(job);
    await mergeChunkedZip(job);

    job.status = "importing";
    job.stage = "正在解析并导入图片";
    job.progress = 15;
    await persistImportJob(job);
    job.result = await importZipArchive(job.zipPath, job.originalFilename, {
      removeSource: false,
      onProgress: async ({ stage, progress, current, total }) => {
        if (stage) job.stage = stage;
        const importProgress = Number.isFinite(progress)
          ? progress
          : Math.round((current / total) * 100);
        job.progress = Math.min(99, 15 + Math.round((importProgress / 100) * 84));
        if (job.progress !== job.lastPersistedProgress) {
          job.lastPersistedProgress = job.progress;
          await persistImportJob(job);
        }
      },
    });
    job.status = "completed";
    job.stage = "导入完成";
    job.progress = 100;
    await persistImportJob(job);
  } catch (error) {
    const normalized = normalizeArchiveImportError(error);
    if (importError(error).isSupplementableJsonError) {
      try {
        await preservePendingJsonImportSource(job);
        job.status = "awaiting_json";
        job.stage = "等待补充 JSON";
        job.progress = 100;
        job.message = normalized.message || "JSON 校验失败，请补充修正后的 JSON";
        job.result = null;
        await persistImportJob(job);
      } catch (preserveError) {
        job.status = "failed";
        job.stage = "导入失败";
        job.message = "JSON 校验失败，且无法保留原始 ZIP，请重新上传";
        await persistImportJob(job);
        console.error(`Failed to preserve chunked ZIP import (${job.uploadId})`, preserveError);
      }
    } else {
      job.status = "failed";
      job.stage = "导入失败";
      job.message = normalized.message || "导入失败，请重试";
      await persistImportJob(job);
    }
    console.error(`Chunked ZIP import failed (${job.uploadId})`, error);
  } finally {
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    if (job.status !== "awaiting_json") {
      await fs.unlink(job.zipPath).catch(() => {});
    }

    // 保留结果一段时间，允许前端在短暂断线后继续查询本次任务。
    setTimeout(
      async () => {
        importJobs.delete(job.uploadId);
        await deleteImportJobStmt.run(job.uploadId);
        await cleanupPendingJsonImport(job.uploadId).catch(() => {});
      },
      24 * 60 * 60 * 1000,
    ).unref();
  }
}

// 时间统一存储为 UTC；业务展示和按小时统计固定使用 Asia/Shanghai（UTC+8）。
async function runSupplementalJsonImportJob(job: ImportJob, supplementalZipPath: string) {
  try {
    job.status = "importing";
    job.stage = "正在使用补充 JSON 重新处理";
    job.progress = 0;
    job.message = null;
    job.result = null;
    await persistImportJob(job);

    const supplementalJson = await loadSupplementalJsonArchive(supplementalZipPath);
    job.result = await importZipArchive(job.zipPath, job.originalFilename, {
      removeSource: false,
      supplementalJson,
      onProgress: async ({ stage, progress, current, total }) => {
        if (stage) job.stage = stage;
        job.progress = Number.isFinite(progress)
          ? Math.min(99, Math.max(0, Math.round(progress)))
          : Math.min(99, Math.round((current / total) * 100));
        if (job.progress !== job.lastPersistedProgress) {
          job.lastPersistedProgress = job.progress;
          await persistImportJob(job);
        }
      },
    });

    job.status = "completed";
    job.stage = "导入完成";
    job.progress = 100;
    await persistImportJob(job);
    await cleanupPendingJsonImport(job.uploadId);
  } catch (error) {
    const normalized = normalizeArchiveImportError(error);
    if (importError(error).isSupplementableJsonError) {
      job.status = "awaiting_json";
      job.stage = "等待补充 JSON";
      job.progress = 100;
      job.message = normalized.message || "JSON 校验失败，请继续补充修正后的 JSON";
      job.result = null;
    } else {
      job.status = "failed";
      job.stage = "导入失败";
      job.message = normalized.message || "补充 JSON 处理失败，请重新上传";
    }
    await persistImportJob(job);
    console.error(`Supplemental JSON import failed (${job.uploadId})`, error);
  } finally {
    await fs.unlink(supplementalZipPath).catch(() => {});
    if (job.status !== "awaiting_json") {
      await cleanupPendingJsonImport(job.uploadId).catch(() => {});
    }
    setTimeout(
      async () => {
        importJobs.delete(job.uploadId);
        await deleteImportJobStmt.run(job.uploadId);
        await cleanupPendingJsonImport(job.uploadId).catch(() => {});
      },
      24 * 60 * 60 * 1000,
    ).unref();
  }
}

  return { validateUploadId, chunkDir, resumableUploadExpiresAt, cleanupPendingJsonImport, parseTusMetadataHeader, requireTusResumableHeader, resumableUploadResponseHeaders, resumableUploadDto, loadResumableUploadSession, saveResumableUploadSession, createResumableUploadSession, cleanupResumableUploadSession, sweepResumableUploadSessions, sweepPendingJsonImports, normalizeTusFilename, withResumableUploadLock, importZipArchive, runResumableImportJob, importJobExpiry, importJobDto, importJobFromRow, persistImportJob, runChunkedImportJob, runSupplementalJsonImportJob };
}
