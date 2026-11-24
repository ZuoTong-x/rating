import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { Express, Request, RequestHandler } from "express";
import type { db as database } from "../postgres.ts";
import { asyncRoute } from "./async-route.ts";
import type { UploadSession, LoadedUploadSession } from "../services/import-jobs.ts";

type Statement = ReturnType<typeof database.prepare>;
type UploadMiddleware = { single(fieldName: string): RequestHandler };
type ImportJob = {
  uploadId: string;
  dir: string;
  zipPath: string;
  originalFilename: string;
  totalChunks: number;
  protocol: string;
  uploadLength: number | null;
  uploadOffset: number;
  metadata: string | null;
  status: string;
  stage: string;
  progress: number;
  message: string | null;
  result: unknown;
  createdAt: string;
  expiresAt: string;
};
type ImportRoutesDependencies = {
  tusVersion: string;
  maxZipBytes: number;
  requireTusResumableHeader(req: Request): void;
  httpError(status: number, message: string): Error;
  parseTusMetadataHeader(value: unknown): Record<string, unknown>;
  normalizeTusFilename(value: unknown): string;
  createResumableUploadSession(filename: string, length: number): Promise<UploadSession>;
  resumableUploadResponseHeaders(session: UploadSession, offset: number): Record<string, string>;
  resumableUploadDto(session: UploadSession, offset: number): unknown;
  loadResumableUploadSession(id: string): Promise<LoadedUploadSession | null>;
  resumableUploadMaxChunkBytes: number;
  withResumableUploadLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  nowIso(): string;
  resumableUploadExpiresAt(): string;
  saveResumableUploadSession(session: UploadSession): Promise<void>;
  importJobExpiry(): string;
  insertImportJobStmt: Statement;
  importJobs: Map<string, ImportJob>;
  runResumableImportJob(job: ImportJob): Promise<unknown>;
  validateUploadId(id: string): void;
  importJobFromRow(row: Record<string, unknown> | undefined): ImportJob | null;
  selectImportJobStmt: Statement;
  importJobDto(job: ImportJob): unknown;
  selectPendingImportJobsStmt: Statement;
  jsonSupplementUpload: UploadMiddleware;
  persistImportJob(job: ImportJob): Promise<void>;
  runSupplementalJsonImportJob(job: ImportJob, jsonPath: string): Promise<unknown>;
  cleanupResumableUploadSession(id: string): Promise<void>;
  cleanupPendingJsonImport(id: string): Promise<void>;
  deleteImportJobStmt: Statement;
  chunkUpload: UploadMiddleware;
  maxChunkCount: number;
  chunkDir(id: string): string;
  zipUploadDir: string;
  runChunkedImportJob(job: ImportJob): Promise<unknown>;
};

export function registerDirectImportRoute(app: Express, { upload, importZipArchive }: {
  upload: UploadMiddleware;
  importZipArchive(filePath: string, filename: string): Promise<unknown>;
}) {
  app.post("/api/import", upload.single("file"), asyncRoute(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ message: "请选择 ZIP 文件" });
      return;
    }
    if (path.extname(req.file.originalname).toLowerCase() !== ".zip") {
      await fs.unlink(req.file.path).catch(() => {});
      res.status(400).json({ message: "仅支持 ZIP 文件" });
      return;
    }
    res.status(201).json(await importZipArchive(req.file.path, req.file.originalname));
  }));
}

export function registerImportUploadRoutes(app: Express, {
  tusVersion, maxZipBytes, requireTusResumableHeader, httpError,
  parseTusMetadataHeader, normalizeTusFilename, createResumableUploadSession,
  resumableUploadResponseHeaders, resumableUploadDto, loadResumableUploadSession,
  resumableUploadMaxChunkBytes, withResumableUploadLock, nowIso,
  resumableUploadExpiresAt, saveResumableUploadSession, importJobExpiry,
  insertImportJobStmt, importJobs, runResumableImportJob, validateUploadId,
  importJobFromRow, selectImportJobStmt, importJobDto, selectPendingImportJobsStmt,
  jsonSupplementUpload, persistImportJob, runSupplementalJsonImportJob,
  cleanupResumableUploadSession, cleanupPendingJsonImport, deleteImportJobStmt,
  chunkUpload, maxChunkCount, chunkDir, zipUploadDir, runChunkedImportJob,
}: ImportRoutesDependencies) {
  app.options("/api/import/uploads", (_req, res) => {
    res
      .set({
        "Tus-Resumable": tusVersion,
        "Tus-Version": tusVersion,
        "Tus-Extension": "creation,termination",
        "Tus-Max-Size": String(maxZipBytes),
      })
      .status(204)
      .end();
  });

  app.options("/api/import/uploads/:uploadId", (_req, res) => {
    res
      .set({
        "Tus-Resumable": tusVersion,
        "Tus-Version": tusVersion,
        "Tus-Extension": "creation,termination",
        "Tus-Max-Size": String(maxZipBytes),
      })
      .status(204)
      .end();
  });

  app.post("/api/import/uploads", async (req, res, next) => {
    try {
      requireTusResumableHeader(req);
      const uploadLength = Number(req.headers["upload-length"]);
      if (!Number.isInteger(uploadLength) || uploadLength <= 0) {
        throw httpError(400, "上传文件大小不正确");
      }
      if (uploadLength > maxZipBytes) {
        throw httpError(413, "ZIP 文件超过服务器允许的大小限制");
      }

      const metadata = parseTusMetadataHeader(req.headers["upload-metadata"]);
      const originalFilename = normalizeTusFilename(metadata.filename);
      if (
        !originalFilename ||
        path.extname(originalFilename).toLowerCase() !== ".zip"
      ) {
        throw httpError(400, "仅支持 ZIP 文件");
      }

      const session = await createResumableUploadSession(
        originalFilename,
        uploadLength,
      );
      res
        .set(resumableUploadResponseHeaders(session, 0))
        .status(201)
        .json(resumableUploadDto(session, 0));
    } catch (error) {
      next(error);
    }
  });

  app.head("/api/import/uploads/:uploadId", async (req, res, next) => {
    try {
      requireTusResumableHeader(req);
      const uploadId = req.params.uploadId;
      const session = await loadResumableUploadSession(uploadId);
      if (!session) throw httpError(404, "上传任务不存在或已过期");
      if (session.status !== "uploading") {
        throw httpError(409, "上传任务已开始处理");
      }
      res
        .set(resumableUploadResponseHeaders(session, session.offset))
        .status(204)
        .end();
    } catch (error) {
      next(error);
    }
  });

  app.patch(
    "/api/import/uploads/:uploadId",
    express.raw({
      type: "application/offset+octet-stream",
      limit: resumableUploadMaxChunkBytes,
    }),
    async (req, res, next) => {
      const uploadId = req.params.uploadId;
      try {
        await withResumableUploadLock(uploadId, async () => {
          requireTusResumableHeader(req);

          const session = await loadResumableUploadSession(uploadId);
          if (!session) throw httpError(404, "上传任务不存在或已过期");
          if (session.status !== "uploading") {
            throw httpError(409, "上传任务状态不允许继续写入");
          }

          const requestedOffset = Number(req.headers["upload-offset"]);
          if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
            throw httpError(400, "上传偏移量不正确");
          }
          if (requestedOffset !== session.offset) {
            return res
              .set(resumableUploadResponseHeaders(session, session.offset))
              .status(409)
              .json({ message: "上传偏移量不匹配，请按服务器返回位置续传" });
          }

          const chunkBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
          if (!chunkBuffer.length) throw httpError(400, "上传数据为空");
          const nextOffset = session.offset + chunkBuffer.length;
          if (nextOffset > session.uploadLength) {
            throw httpError(413, "上传数据超过声明的文件大小");
          }

          const previousOffset = session.offset;
          try {
            await fs.appendFile(session.filePath, chunkBuffer);
          } catch (error) {
            await fs.truncate(session.filePath, previousOffset).catch(() => {});
            throw error;
          }

          const updatedSession = {
            ...session,
            offset: nextOffset,
            updatedAt: nowIso(),
            expiresAt: resumableUploadExpiresAt(),
          };

          try {
            if (nextOffset === session.uploadLength) {
            updatedSession.status = "queued";
            await saveResumableUploadSession(updatedSession);
            const job = {
              uploadId,
              dir: session.dir,
              zipPath: session.filePath,
              originalFilename: session.originalFilename,
              totalChunks: 1,
              protocol: "tus",
              uploadLength: session.uploadLength,
              uploadOffset: nextOffset,
              metadata: JSON.stringify({
                filename: session.originalFilename,
                uploadLength: session.uploadLength,
              }),
              status: "queued",
              stage: "等待处理",
              progress: 0,
              message: null,
              result: null,
              createdAt: nowIso(),
              expiresAt: importJobExpiry(),
            };
              await insertImportJobStmt.run({
              uploadId: job.uploadId,
              originalFilename: job.originalFilename,
              totalChunks: job.totalChunks,
              protocol: job.protocol,
              uploadLength: job.uploadLength,
              uploadOffset: job.uploadOffset,
              metadata: job.metadata,
              status: job.status,
              stage: job.stage,
              progress: job.progress,
              message: null,
              resultJson: null,
              createdAt: job.createdAt,
              updatedAt: job.createdAt,
              expiresAt: job.expiresAt,
            });
            importJobs.set(uploadId, job);
            setImmediate(async () => void (await runResumableImportJob(job)));
            } else {
              await saveResumableUploadSession(updatedSession);
            }
          } catch (error) {
            await fs.truncate(session.filePath, previousOffset).catch(() => {});
            await saveResumableUploadSession(session).catch(() => {});
            throw error;
          }

          res
            .set(resumableUploadResponseHeaders(updatedSession, nextOffset))
            .status(204)
            .end();
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/import/uploads/:uploadId/status", async (req, res, next) => {
    try {
      const uploadId = req.params.uploadId;
      validateUploadId(uploadId);
      const job =
        importJobs.get(uploadId) || importJobFromRow(await selectImportJobStmt.get(uploadId));
      if (job) return res.json(importJobDto(job));

      const session = await loadResumableUploadSession(uploadId);
      if (!session) throw httpError(404, "上传任务不存在或已过期");
      res.json({
        uploadId,
        status: "uploading",
        stage: "上传中",
        progress: Math.min(
          99,
          Math.round((session.offset / session.uploadLength) * 100),
        ),
        message: null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/import/pending-json", async (_req, res, next) => {
    try {
      const rows = await selectPendingImportJobsStmt.all(new Date().toISOString());
      res.json(rows.map((row) => importJobDto(importJobFromRow(row)!)));
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/import/uploads/:uploadId/supplement-json",
    jsonSupplementUpload.single("file"),
    async (req, res, next) => {
      try {
        const uploadId = req.params.uploadId;
        validateUploadId(uploadId);
        if (!req.file) {
          throw httpError(400, "请选择包含 manifest.json 或 tasks.json 的 ZIP 文件");
        }
        const supplementalFile = req.file;

        const job = await withResumableUploadLock(uploadId, async () => {
          const currentJob =
            importJobs.get(uploadId) ||
            importJobFromRow(await selectImportJobStmt.get(uploadId));
          if (!currentJob) throw httpError(404, "导入任务不存在或已过期");
          if (currentJob.status !== "awaiting_json") {
            throw httpError(409, "当前导入任务不在等待补充 JSON 状态");
          }

          try {
            await fs.access(currentJob.zipPath);
          } catch {
            throw httpError(410, "原始 ZIP 已不存在，请重新上传图包");
          }

          currentJob.status = "importing";
          currentJob.stage = "正在使用补充 JSON 重新处理";
          currentJob.progress = 0;
          currentJob.message = null;
          currentJob.result = null;
          importJobs.set(uploadId, currentJob);
          await persistImportJob(currentJob);
          return currentJob;
        });
        setImmediate(async () => {
          await runSupplementalJsonImportJob(job, supplementalFile.path);
        });
        res.status(202).json(importJobDto(job));
      } catch (error) {
        if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
        next(error);
      }
    },
  );

  app.delete("/api/import/uploads/:uploadId", async (req, res, next) => {
    try {
      requireTusResumableHeader(req);
      const uploadId = req.params.uploadId;
      const job =
        importJobs.get(uploadId) || importJobFromRow(await selectImportJobStmt.get(uploadId));
      if (job && !["failed", "completed", "awaiting_json"].includes(job.status)) {
        throw httpError(409, "导入任务已开始，无法取消");
      }

      await cleanupResumableUploadSession(uploadId);
      await cleanupPendingJsonImport(uploadId);
      await deleteImportJobStmt.run(uploadId);
      importJobs.delete(uploadId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/import/chunks/:uploadId/parts/:index",
    chunkUpload.single("chunk"),
    async (req, res, next) => {
      try {
        if (!req.file) return res.status(400).json({ message: "缺少上传分片" });
        const index = Number(req.params.index);
        if (!Number.isInteger(index) || index < 0 || index >= maxChunkCount)
          throw httpError(400, "分片序号不正确");
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/import/chunks/:uploadId/complete", async (req, res, next) => {
    try {
      const uploadId = req.params.uploadId;
      const dir = chunkDir(uploadId);
      const existingJob = importJobs.get(uploadId);
      if (existingJob) {
        return res.status(202).json(importJobDto(existingJob));
      }
      const persistedJob = importJobFromRow(await selectImportJobStmt.get(uploadId));
      if (persistedJob) {
        return res.status(202).json(importJobDto(persistedJob));
      }

      const originalFilename = String(req.body?.filename || "").trim();
      const totalChunks = Number(req.body?.totalChunks);
      if (
        !originalFilename ||
        path.extname(originalFilename).toLowerCase() !== ".zip"
      ) {
        throw httpError(400, "仅支持 ZIP 文件");
      }
      if (
        !Number.isInteger(totalChunks) ||
        totalChunks <= 0 ||
        totalChunks > maxChunkCount
      ) {
        throw httpError(400, "分片总数不正确");
      }

      const job = {
        uploadId,
        dir,
        zipPath: path.join(zipUploadDir, `${uploadId}.zip`),
        originalFilename,
        totalChunks,
        protocol: "chunked",
        uploadLength: null,
        uploadOffset: 0,
        metadata: null,
        status: "queued",
        stage: "等待处理",
        progress: 0,
        message: null,
        result: null,
        createdAt: nowIso(),
        expiresAt: importJobExpiry(),
      };
      await insertImportJobStmt.run({
        uploadId: job.uploadId,
        originalFilename: job.originalFilename,
        totalChunks: job.totalChunks,
        protocol: "chunked",
        uploadLength: null,
        uploadOffset: 0,
        metadata: null,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        message: null,
        resultJson: null,
        createdAt: job.createdAt,
        updatedAt: job.createdAt,
        expiresAt: job.expiresAt,
      });
      importJobs.set(uploadId, job);
      setImmediate(async () => void (await runChunkedImportJob(job)));
      res.status(202).json(importJobDto(job));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/import/chunks/:uploadId/status", async (req, res, next) => {
    try {
      validateUploadId(req.params.uploadId);
      const job =
        importJobs.get(req.params.uploadId) ||
        importJobFromRow(await selectImportJobStmt.get(req.params.uploadId));
      if (!job) throw httpError(404, "上传任务不存在或已过期");
      res.json(importJobDto(job));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/import/chunks/:uploadId", async (req, res, next) => {
    try {
      await fs.rm(chunkDir(req.params.uploadId), {
        recursive: true,
        force: true,
      });
      await cleanupPendingJsonImport(req.params.uploadId);
      await deleteImportJobStmt.run(req.params.uploadId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}
