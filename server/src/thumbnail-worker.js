import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { db, pool, runWithDatabaseContext } from "./postgres.js";
import { createThumbnail, thumbnailStoragePath, uploadFilePath } from "./image-assets.js";
import { resolveThumbnailSchedule } from "./thumbnail-scheduler.js";
import { createOperationalLogger } from "./operational-logger.js";
import { withTimeout } from "./thumbnail-runtime.js";

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
const operationalLogger = createOperationalLogger({
  source: "thumbnail-worker",
  logDir: process.env.LOG_DIR || "logs",
});
operationalLogger.installConsoleCapture();
const workerId = `${process.env.HOSTNAME || "thumbnail-worker"}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const legacyWorkerConcurrency = positiveInteger(process.env.THUMBNAIL_WORKER_CONCURRENCY, 2, 1, 16);
const workerMaxConcurrency = positiveInteger(process.env.THUMBNAIL_WORKER_MAX_CONCURRENCY, 16, 1, 16);
const maxAttempts = positiveInteger(process.env.THUMBNAIL_MAX_ATTEMPTS, 5, 1, 20);
const leaseMs = positiveInteger(process.env.THUMBNAIL_JOB_LEASE_MS, 30 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
const retryBaseMs = positiveInteger(process.env.THUMBNAIL_RETRY_BASE_MS, 5000, 1000, 60 * 60 * 1000);
const pollMs = positiveInteger(process.env.THUMBNAIL_POLL_MS, 2000, 250, 60 * 1000);
const queueRepairIntervalMs = positiveInteger(process.env.THUMBNAIL_QUEUE_REPAIR_INTERVAL_MS, 30 * 1000, 5000, 60 * 60 * 1000);
const queueRepairScanBatchSize = positiveInteger(
  process.env.THUMBNAIL_QUEUE_REPAIR_SCAN_BATCH_SIZE,
  2000,
  100,
  10000,
);
const prioritySubjectEmptyRetryMs = positiveInteger(
  process.env.THUMBNAIL_PRIORITY_EMPTY_RETRY_MS,
  60 * 1000,
  5000,
  60 * 60 * 1000,
);
const settingsRefreshIntervalMs = positiveInteger(process.env.THUMBNAIL_SETTINGS_REFRESH_INTERVAL_MS, 5000, 1000, 60 * 1000);
const processTimeoutMs = positiveInteger(
  process.env.THUMBNAIL_PROCESS_TIMEOUT_MS,
  6 * 60 * 1000,
  30 * 1000,
  Math.max(30 * 1000, leaseMs - 5000),
);

const selectQueueSettingsStmt = db.prepare(`
  SELECT globallyPaused, daytimeConcurrency, nighttimeConcurrency,
         nightStartHour, nightEndHour, timeZone
  FROM thumbnail_queue_settings
  WHERE id = 'default'
`);

const selectPriorityThumbnailSubjectsStmt = db.prepare(`
  SELECT subjectId, priority
  FROM thumbnail_subject_controls
  WHERE generationEnabled = true
    AND paused = false
    AND priority > 0
  ORDER BY priority DESC, updatedAt DESC, subjectId ASC
  LIMIT 100
`);
const selectPriorityThumbnailJobsStmt = db.prepare(`
  WITH subject_images AS MATERIALIZED (
    SELECT id, storagePath
    FROM images
    WHERE subjectId = @subjectId
      AND (
        thumbnailPath IS NULL
        OR BTRIM(thumbnailPath) = ''
        OR thumbnailPath = storagePath
      )
  )
  SELECT jobs.imageId, subject_images.storagePath, jobs.attempts
  FROM subject_images
  JOIN thumbnail_jobs jobs ON jobs.imageId = subject_images.id
  WHERE jobs.status = 'pending'
    AND (jobs.nextRetryAt IS NULL OR jobs.nextRetryAt <= @now)
    AND jobs.attempts < @maxAttempts
  ORDER BY jobs.nextRetryAt ASC, jobs.createdAt ASC, jobs.imageId ASC
  LIMIT @limit
  FOR UPDATE OF jobs SKIP LOCKED
`);
const selectDefaultThumbnailJobsStmt = db.prepare(`
  SELECT jobs.imageId, images.storagePath, jobs.attempts
  FROM thumbnail_jobs jobs
  JOIN images ON images.id = jobs.imageId
  LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = images.subjectId
  WHERE jobs.status = 'pending'
    AND (jobs.nextRetryAt IS NULL OR jobs.nextRetryAt <= @now)
    AND jobs.attempts < @maxAttempts
    AND COALESCE(controls.generationEnabled, true) = true
    AND COALESCE(controls.paused, false) = false
    AND COALESCE(controls.priority, 0) <= 0
  ORDER BY jobs.nextRetryAt ASC, jobs.lockedUntil ASC, jobs.createdAt ASC
  LIMIT @limit
  FOR UPDATE OF jobs SKIP LOCKED
`);
const claimThumbnailJobStmt = db.prepare(`
  UPDATE thumbnail_jobs
  SET status = 'processing',
      attempts = attempts + 1,
      workerId = @claimId,
      lockedUntil = @lockedUntil,
      nextRetryAt = NULL,
      updatedAt = @now
  WHERE imageId = @imageId
`);
const releaseExpiredThumbnailJobsStmt = db.prepare(`
  UPDATE thumbnail_jobs
  SET status = 'pending',
      workerId = NULL,
      lockedUntil = NULL,
      nextRetryAt = @now,
      lastError = COALESCE(lastError, '处理超时，已自动重新排队'),
      updatedAt = @now,
      completedAt = NULL
  WHERE status = 'processing'
    AND lockedUntil IS NOT NULL
    AND lockedUntil <= @now
    AND attempts < @maxAttempts
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
  WITH candidates AS MATERIALIZED (
    SELECT images.id, images.createdAt, images.thumbnailPath, images.storagePath,
           COALESCE(controls.generationEnabled, true) AS generationEnabled
    FROM images
    LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = images.subjectId
    WHERE @afterImageId::text IS NULL OR images.id > @afterImageId
    ORDER BY images.id ASC
    LIMIT @scanLimit
  ), inserted AS (
    INSERT INTO thumbnail_jobs (
      imageId, status, attempts, workerId, lockedUntil, nextRetryAt, lastError,
      createdAt, updatedAt, completedAt
    )
    SELECT candidates.id, 'pending', 0, NULL, NULL, @now, NULL,
           candidates.createdAt, @now, NULL
    FROM candidates
    WHERE candidates.generationEnabled = true
      AND (candidates.thumbnailPath IS NULL
        OR BTRIM(candidates.thumbnailPath) = ''
        OR candidates.thumbnailPath = candidates.storagePath)
    ON CONFLICT (imageId) DO NOTHING
    RETURNING imageId
  )
  SELECT
    (SELECT MAX(id) FROM candidates) AS lastImageId,
    (SELECT COUNT(*) FROM candidates)::integer AS scannedCount,
    (SELECT COUNT(*) FROM inserted)::integer AS insertedCount
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
    AND workerId = @claimId
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
    AND workerId = @claimId
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
  await runWithDatabaseContext(() => releaseExpiredThumbnailJobsStmt.run({ now, maxAttempts }));
  await runWithDatabaseContext(() => failExhaustedThumbnailJobsStmt.run({ now, maxAttempts }));
  const result = await runWithDatabaseContext(() => seedMissingThumbnailJobsStmt.get({
    now,
    afterImageId: queueRepairCursor,
    scanLimit: queueRepairScanBatchSize,
  }));
  const scannedCount = Number(result?.scannedCount || 0);
  queueRepairCursor = scannedCount > 0 ? result.lastImageId : null;
  return {
    scannedCount,
    insertedCount: Number(result?.insertedCount || 0),
    wrapped: scannedCount === 0,
  };
}

async function claimJobs(limit) {
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
  return runWithDatabaseContext(async () => {
    await db.exec("BEGIN");
    try {
      const rows = [];
      const prioritySubjects = await selectPriorityThumbnailSubjectsStmt.all();
      for (const subject of prioritySubjects) {
        if (rows.length >= limit) break;
        const retryAt = prioritySubjectEmptyUntil.get(subject.subjectId) || 0;
        if (retryAt > Date.now()) continue;
        const subjectRows = await selectPriorityThumbnailJobsStmt.all({
          subjectId: subject.subjectId,
          now: nowIso,
          maxAttempts,
          limit: limit - rows.length,
        });
        if (subjectRows.length) {
          prioritySubjectEmptyUntil.delete(subject.subjectId);
          rows.push(...subjectRows);
        } else {
          prioritySubjectEmptyUntil.set(
            subject.subjectId,
            Date.now() + prioritySubjectEmptyRetryMs,
          );
        }
      }
      if (rows.length < limit) {
        rows.push(...await selectDefaultThumbnailJobsStmt.all({
          now: nowIso,
          maxAttempts,
          limit: limit - rows.length,
        }));
      }
      for (const row of rows) {
        row.claimId = `${workerId}-${crypto.randomUUID()}`;
        const claim = await claimThumbnailJobStmt.run({
          imageId: row.imageId,
          claimId: row.claimId,
          lockedUntil,
          now: nowIso,
        });
        if (claim.changes !== 1) {
          throw new Error(`缩略图任务领取更新了 ${claim.changes} 行：${row.imageId}`);
        }
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
    await sharp(targetPath)
      .timeout({ seconds: Math.max(10, Math.ceil(processTimeoutMs / 1000)) })
      .metadata();
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
        claimId: job.claimId,
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
    claimId: job.claimId,
    status: exhausted ? "failed" : "pending",
    nextRetryAt: exhausted ? null : new Date(now.getTime() + delayMs).toISOString(),
    lastError: errorMessage(error),
    now: nowIso,
  }));
  operationalLogger.error({
    kind: "thumbnail-job",
    message: exhausted ? "缩略图任务已达到最大重试次数" : "缩略图任务失败，已安排重试",
    code: error?.code || null,
    metadata: {
      imageId: job.imageId,
      attempts,
      exhausted,
      nextRetryAt: exhausted ? null : new Date(now.getTime() + delayMs).toISOString(),
    },
  }, error);
}

async function generateThumbnail(job) {
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
  if (!await markReady(job, thumbnailPath)) {
    console.warn(`缩略图任务完成时领取已失效：${job.imageId}`);
  }
}

async function processJob(job) {
  try {
    await withTimeout(
      generateThumbnail(job),
      processTimeoutMs,
      `缩略图处理超过 ${Math.round(processTimeoutMs / 1000)} 秒`,
    );
  } catch (error) {
    await markRetry(job, error);
  }
}

let stopRequested = false;
let lastQueueRepairAt = 0;
let queueRepairCursor = null;
let lastSettingsRefreshAt = 0;
let lastHeartbeatAt = 0;
let lastClaimedAt = null;
let lastClaimCount = 0;
let lastRepairError = null;
let lastRepairErrorLoggedAt = 0;
let repeatedRepairErrors = 0;
const prioritySubjectEmptyUntil = new Map();
const activeJobs = new Map();
let cachedSchedule = {
  globallyPaused: false,
  concurrency: legacyWorkerConcurrency,
  period: "day",
  localHour: null,
  timeZone: "Asia/Shanghai",
};
process.once("SIGTERM", () => { stopRequested = true; });
process.once("SIGINT", () => { stopRequested = true; });

async function currentSchedule() {
  if (lastSettingsRefreshAt && Date.now() - lastSettingsRefreshAt < settingsRefreshIntervalMs) {
    return cachedSchedule;
  }
  const settings = await runWithDatabaseContext(() => selectQueueSettingsStmt.get());
  cachedSchedule = settings
    ? resolveThumbnailSchedule(settings)
    : { ...cachedSchedule, concurrency: legacyWorkerConcurrency };
  cachedSchedule.concurrency = Math.min(workerMaxConcurrency, cachedSchedule.concurrency);
  lastSettingsRefreshAt = Date.now();
  return cachedSchedule;
}

try {
  console.log(`Thumbnail worker ${workerId} started (maxConcurrency=${workerMaxConcurrency})`);
  while (!stopRequested) {
    try {
      if (!lastQueueRepairAt || Date.now() - lastQueueRepairAt >= queueRepairIntervalMs) {
        lastQueueRepairAt = Date.now();
        try {
          const repair = await repairQueue();
          lastRepairError = null;
          repeatedRepairErrors = 0;
          if (repair.insertedCount > 0 || repair.wrapped) {
            operationalLogger.write({
              level: "info",
              kind: "thumbnail-queue-repair",
              message: repair.wrapped ? "缩略图队列增量巡检已完成一轮" : "已补充缺失的缩略图任务",
              metadata: repair,
            });
          }
        } catch (error) {
          const nextError = { code: error?.code || null, message: error?.message || String(error) };
          const changed = nextError.code !== lastRepairError?.code || nextError.message !== lastRepairError?.message;
          lastRepairError = nextError;
          repeatedRepairErrors += 1;
          if (changed || Date.now() - lastRepairErrorLoggedAt >= 5 * 60_000) {
            lastRepairErrorLoggedAt = Date.now();
            operationalLogger.error({
              kind: "thumbnail-queue-repair",
              message: "缩略图队列增量修复失败，正常任务继续处理",
              code: error?.code || null,
              metadata: { activeJobCount: activeJobs.size, queueRepairCursor, repeatedRepairErrors },
            }, error);
            repeatedRepairErrors = 0;
          }
        }
      }
      const schedule = await currentSchedule();
      if (!lastHeartbeatAt || Date.now() - lastHeartbeatAt >= 60_000) {
        lastHeartbeatAt = Date.now();
        operationalLogger.write({
          level: "info",
          kind: "thumbnail-worker-heartbeat",
          message: "缩略图 Worker 心跳",
          metadata: {
            activeJobCount: activeJobs.size,
            concurrency: schedule.concurrency,
            globallyPaused: schedule.globallyPaused,
            lastClaimedAt,
            lastClaimCount,
            lastRepairError,
            queueRepairCursor,
          },
        });
      }
      if (schedule.globallyPaused) {
        await sleep(pollMs);
        continue;
      }
      const availableSlots = Math.max(0, schedule.concurrency - activeJobs.size);
      if (availableSlots > 0) {
        const jobs = await claimJobs(availableSlots);
        lastClaimCount = jobs.length;
        if (jobs.length) lastClaimedAt = new Date().toISOString();
        for (const job of jobs) {
          const running = processJob(job)
            .catch((error) => {
              operationalLogger.error({
                kind: "thumbnail-job-cleanup",
                message: "缩略图任务清理失败",
                code: error?.code || null,
                metadata: { imageId: job.imageId },
              }, error);
            })
            .finally(() => activeJobs.delete(job.claimId));
          activeJobs.set(job.claimId, running);
        }
      }
      await sleep(pollMs);
    } catch (error) {
      operationalLogger.error({
        kind: "thumbnail-worker-loop",
        message: "缩略图 Worker 主循环失败，稍后自动重试",
        code: error?.code || null,
        metadata: { activeJobCount: activeJobs.size },
      }, error);
      await sleep(Math.max(pollMs, 5000));
    }
  }
} catch (error) {
  operationalLogger.error({
    level: "critical",
    kind: "thumbnail-worker-process",
    message: "缩略图 Worker 意外停止",
    code: error?.code || null,
  }, error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...activeJobs.values()]);
  await pool.end().catch(() => {});
}
