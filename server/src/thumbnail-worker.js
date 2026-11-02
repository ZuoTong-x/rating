import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { db, pool, runWithDatabaseContext } from "./postgres.js";
import { createThumbnail, thumbnailStoragePath, uploadFilePath } from "./image-assets.js";

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
const workerId = `${process.env.HOSTNAME || "thumbnail-worker"}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const workerConcurrency = positiveInteger(process.env.THUMBNAIL_WORKER_CONCURRENCY, 2, 1, 16);
const maxAttempts = positiveInteger(process.env.THUMBNAIL_MAX_ATTEMPTS, 5, 1, 20);
const leaseMs = positiveInteger(process.env.THUMBNAIL_JOB_LEASE_MS, 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
const retryBaseMs = positiveInteger(process.env.THUMBNAIL_RETRY_BASE_MS, 5000, 1000, 60 * 60 * 1000);
const pollMs = positiveInteger(process.env.THUMBNAIL_POLL_MS, 2000, 250, 60 * 1000);
const queueRepairIntervalMs = positiveInteger(process.env.THUMBNAIL_QUEUE_REPAIR_INTERVAL_MS, 30 * 1000, 5000, 60 * 60 * 1000);

const selectThumbnailJobsStmt = db.prepare(`
  SELECT jobs.imageId, images.storagePath, jobs.attempts
  FROM thumbnail_jobs jobs
  JOIN images ON images.id = jobs.imageId
  WHERE (
    (jobs.status = 'pending' AND (jobs.nextRetryAt IS NULL OR jobs.nextRetryAt <= @now))
    OR (jobs.status = 'processing' AND jobs.lockedUntil IS NOT NULL AND jobs.lockedUntil <= @now)
  )
    AND jobs.attempts < @maxAttempts
  ORDER BY jobs.createdAt ASC, jobs.imageId ASC
  LIMIT @limit
  FOR UPDATE OF jobs SKIP LOCKED
`);
const claimThumbnailJobStmt = db.prepare(`
  UPDATE thumbnail_jobs
  SET status = 'processing',
      attempts = attempts + 1,
      workerId = @workerId,
      lockedUntil = @lockedUntil,
      nextRetryAt = NULL,
      updatedAt = @now
  WHERE imageId = @imageId
`);
const failExhaustedThumbnailJobsStmt = db.prepare(`
  UPDATE thumbnail_jobs
  SET status = 'failed',
      workerId = NULL,
      lockedUntil = NULL,
      nextRetryAt = NULL,
      lastError = COALESCE(lastError, '超过最大重试次数'),
      updatedAt = @now
  WHERE status = 'processing'
    AND lockedUntil IS NOT NULL
    AND lockedUntil <= @now
    AND attempts >= @maxAttempts
`);
const seedMissingThumbnailJobsStmt = db.prepare(`
  INSERT INTO thumbnail_jobs (
    imageId, status, attempts, workerId, lockedUntil, nextRetryAt, lastError,
    createdAt, updatedAt, completedAt
  )
  SELECT images.id, 'pending', 0, NULL, NULL, @now, NULL, images.createdAt, @now, NULL
  FROM images
  WHERE images.thumbnailPath IS NULL
     OR TRIM(images.thumbnailPath) = ''
     OR images.thumbnailPath = images.storagePath
  ON CONFLICT (imageId) DO NOTHING
`);
const markThumbnailReadyStmt = db.prepare(`
  UPDATE thumbnail_jobs
  SET status = 'ready',
      workerId = NULL,
      lockedUntil = NULL,
      nextRetryAt = NULL,
      lastError = NULL,
      updatedAt = @now,
      completedAt = @now
  WHERE imageId = @imageId
    AND workerId = @workerId
`);
const updateImageThumbnailStmt = db.prepare(`
  UPDATE images
  SET thumbnailPath = @thumbnailPath,
      updatedAt = @now
  WHERE id = @imageId
`);
const markThumbnailRetryStmt = db.prepare(`
  UPDATE thumbnail_jobs
  SET status = @status,
      workerId = NULL,
      lockedUntil = NULL,
      nextRetryAt = @nextRetryAt,
      lastError = @lastError,
      updatedAt = @now,
      completedAt = NULL
  WHERE imageId = @imageId
    AND workerId = @workerId
`);

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sleep(durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function errorMessage(error) {
  return String(error?.stack || error?.message || error || "缩略图生成失败").slice(0, 2000);
}

async function repairQueue() {
  const now = new Date().toISOString();
  await runWithDatabaseContext(() => seedMissingThumbnailJobsStmt.run({ now }));
  await runWithDatabaseContext(() => failExhaustedThumbnailJobsStmt.run({ now, maxAttempts }));
}

async function claimJobs() {
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
  return runWithDatabaseContext(async () => {
    await db.exec("BEGIN");
    try {
      const rows = await selectThumbnailJobsStmt.all({
        now: nowIso,
        maxAttempts,
        limit: workerConcurrency,
      });
      for (const row of rows) {
        await claimThumbnailJobStmt.run({
          imageId: row.imageId,
          workerId,
          lockedUntil,
          now: nowIso,
        });
      }
      await db.exec("COMMIT");
      return rows.map(row => ({ ...row, attempts: Number(row.attempts || 0) + 1 }));
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

async function thumbnailFileIsReady(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isFile() || stat.size <= 0) return false;
    await sharp(targetPath).metadata();
    return true;
  } catch {
    return false;
  }
}

async function markReady(job, thumbnailPath) {
  const now = new Date().toISOString();
  return runWithDatabaseContext(async () => {
    await db.exec("BEGIN");
    try {
      const result = await markThumbnailReadyStmt.run({
        imageId: job.imageId,
        workerId,
        now,
      });
      if (result.changes !== 1) {
        await db.exec("ROLLBACK");
        return false;
      }
      await updateImageThumbnailStmt.run({ imageId: job.imageId, thumbnailPath, now });
      await db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

async function markRetry(job, error) {
  const attempts = Number(job.attempts || 1);
  const exhausted = attempts >= maxAttempts;
  const delayMs = Math.min(60 * 60 * 1000, retryBaseMs * (2 ** Math.max(0, attempts - 1)));
  const now = new Date();
  const nowIso = now.toISOString();
  await runWithDatabaseContext(() => markThumbnailRetryStmt.run({
    imageId: job.imageId,
    workerId,
    status: exhausted ? "failed" : "pending",
    nextRetryAt: exhausted ? null : new Date(now.getTime() + delayMs).toISOString(),
    lastError: errorMessage(error),
    now: nowIso,
  }));
  console.error(`Thumbnail ${exhausted ? "failed" : "retry scheduled"} [${job.imageId}]`, errorMessage(error));
}

async function processJob(job) {
  try {
    const thumbnailPath = thumbnailStoragePath(job.storagePath);
    const originalPath = uploadFilePath(uploadDir, job.storagePath);
    const targetPath = uploadFilePath(uploadDir, thumbnailPath);
    await fs.access(originalPath);
    if (!await thumbnailFileIsReady(targetPath)) {
      await createThumbnail(originalPath, targetPath);
    }
    if (!await thumbnailFileIsReady(targetPath)) {
      throw new Error("缩略图生成后校验失败");
    }
    await markReady(job, thumbnailPath);
  } catch (error) {
    await markRetry(job, error);
  }
}

let stopRequested = false;
let lastQueueRepairAt = 0;
process.once("SIGTERM", () => { stopRequested = true; });
process.once("SIGINT", () => { stopRequested = true; });

try {
  console.log(`Thumbnail worker ${workerId} started (concurrency=${workerConcurrency})`);
  while (!stopRequested) {
    try {
      if (!lastQueueRepairAt || Date.now() - lastQueueRepairAt >= queueRepairIntervalMs) {
        await repairQueue();
        lastQueueRepairAt = Date.now();
      }
      const jobs = await claimJobs();
      if (!jobs.length) {
        await sleep(pollMs);
        continue;
      }
      await Promise.allSettled(jobs.map(processJob));
    } catch (error) {
      console.error("Thumbnail worker loop failed; retrying", errorMessage(error));
      await sleep(Math.max(pollMs, 5000));
    }
  }
} catch (error) {
  console.error("Thumbnail worker stopped unexpectedly", errorMessage(error));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
