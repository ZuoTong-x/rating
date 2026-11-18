import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { db, pool, runWithDatabaseContext } from "./postgres.js";
import { createThumbnail, thumbnailStoragePath, uploadFilePath } from "./image-assets.js";
import { resolveThumbnailSchedule } from "./thumbnail-scheduler.js";
import { createOperationalLogger } from "./operational-logger.js";
import { withTimeout, isDatabaseIntegrityError } from "./thumbnail-runtime.js";

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

const selectClaimSubjectsStmt = db.prepare(`
  SELECT subjects.id AS subjectId
  FROM subjects
  LEFT JOIN thumbnail_subject_stats stats ON stats.subjectId = subjects.id
  LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = subjects.id
  WHERE subjects.deletionRequestedAt IS NULL AND subjects.imageCount > 0
    AND (COALESCE(stats.initialized, false) = false OR stats.pending > 0)
    AND COALESCE(controls.generationEnabled, true) = true
    AND COALESCE(controls.paused, false) = false
  ORDER BY COALESCE(controls.priority, 0) DESC, subjects.createdAt DESC, subjects.id ASC
`);
const claimThumbnailJobsForSubjectStmt = db.prepare(`
  WITH candidates AS MATERIALIZED (
    SELECT jobs.imageId, images.storagePath, images.createdAt AS imageCreatedAt
    FROM images
    JOIN thumbnail_jobs jobs ON jobs.imageId = images.id
    JOIN subjects ON subjects.id = images.subjectId
    LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = images.subjectId
    WHERE images.subjectId = @subjectId
      AND jobs.status = 'pending'
      AND (jobs.nextRetryAt IS NULL OR jobs.nextRetryAt <= @now)
      AND jobs.attempts < @maxAttempts
      AND subjects.deletionRequestedAt IS NULL
      AND COALESCE(controls.generationEnabled, true) = true
      AND COALESCE(controls.paused, false) = false
      AND (images.thumbnailPath IS NULL
        OR BTRIM(images.thumbnailPath) = ''
        OR images.thumbnailPath = images.storagePath)
    ORDER BY images.createdAt ASC
    LIMIT @limit
    FOR UPDATE OF jobs SKIP LOCKED
  ), claimed AS (
    UPDATE thumbnail_jobs jobs
    SET status = 'processing',
        attempts = jobs.attempts + 1,
        workerId = @claimPrefix || '-' || jobs.imageId,
        lockedUntil = @lockedUntil,
        nextRetryAt = NULL,
        updatedAt = @now
    FROM candidates
    WHERE jobs.imageId = candidates.imageId
    RETURNING jobs.imageId, jobs.attempts, jobs.workerId
  )
  SELECT claimed.imageId, claimed.attempts, claimed.workerId AS claimId,
         candidates.storagePath
  FROM claimed
  JOIN candidates ON candidates.imageId = claimed.imageId
  ORDER BY candidates.imageCreatedAt ASC
`);
const pauseQueueForIntegrityErrorStmt = db.prepare(`
  UPDATE thumbnail_queue_settings
  SET globallyPaused = true, updatedAt = @now, updatedBy = 'system:database-integrity'
  WHERE id = 'default' AND globallyPaused = false
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
      attempts = CASE WHEN @refundAttempt THEN GREATEST(attempts - 1, 0) ELSE attempts END,
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

async function pauseQueueForIntegrityError(error) {
  integrityPaused = true;
  if (integrityPausePromise) return integrityPausePromise;
  if (!integrityAlerted) {
    integrityAlerted = true;
    operationalLogger.error({
      level: "critical",
      kind: "thumbnail-database-integrity",
      message: "数据库完整性错误，缩略图队列已自动暂停，修复数据库后请手动启动",
      code: error?.code || null,
    }, error);
  }
  integrityPausePromise = runWithDatabaseContext(() => pauseQueueForIntegrityErrorStmt.run({
    now: new Date().toISOString(),
  })).then(() => {
    cachedSchedule = { ...cachedSchedule, globallyPaused: true };
    lastSettingsRefreshAt = 0;
    integrityPaused = false;
  }).catch((pauseError) => {
    operationalLogger.error({
      level: "critical",
      kind: "thumbnail-database-integrity-pause",
      message: "自动暂停写库失败，当前 Worker 已停止领取任务",
      code: pauseError?.code || null,
    }, pauseError);
  }).finally(() => { integrityPausePromise = null; });
  return integrityPausePromise;
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
  const startedAt = performance.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
  try {
    const subjects = await runWithDatabaseContext(() => selectClaimSubjectsStmt.all());
    const rows = [];
    for (const subject of subjects) {
      if (rows.length >= limit) break;
      if ((emptySubjectUntil.get(subject.subjectId) || 0) > Date.now()) continue;
      const claimed = await runWithDatabaseContext(() => claimThumbnailJobsForSubjectStmt.all({
        subjectId: subject.subjectId,
        now: nowIso,
        lockedUntil,
        maxAttempts,
        limit: limit - rows.length,
        claimPrefix: `${workerId}-${crypto.randomUUID()}`,
      }));
      if (claimed.length) {
        emptySubjectUntil.delete(subject.subjectId);
        rows.push(...claimed);
      } else {
        emptySubjectUntil.set(subject.subjectId, Date.now() + 10000);
      }
    }
    return rows;
  } finally {
    lastClaimDurationMs = Math.round(performance.now() - startedAt);
  }
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

async function markRetry(job, error, integrityError = false) {
  const attempts = Number(job.attempts || 1);
  const exhausted = !integrityError && attempts >= maxAttempts;
  const delayMs = Math.min(60 * 60 * 1000, retryBaseMs * (2 ** Math.max(0, attempts - 1)));
  const now = new Date();
  const nowIso = now.toISOString();
  await runWithDatabaseContext(() => markThumbnailRetryStmt.run({
    imageId: job.imageId,
    claimId: job.claimId,
    status: exhausted ? "failed" : "pending",
    refundAttempt: integrityError,
    nextRetryAt: exhausted ? null : integrityError ? nowIso : new Date(now.getTime() + delayMs).toISOString(),
    lastError: errorMessage(error),
    now: nowIso,
  }));
  if (integrityError) return;
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
  const startedAt = performance.now();
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
  lastGenerationDurationMs = Math.round(performance.now() - startedAt);
  const writeStartedAt = performance.now();
  try {
    if (!await markReady(job, thumbnailPath)) {
      console.warn(`缩略图任务完成时领取已失效：${job.imageId}`);
    }
  } finally {
    lastWriteDurationMs = Math.round(performance.now() - writeStartedAt);
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
    const integrityError = isDatabaseIntegrityError(error);
    if (integrityError) await pauseQueueForIntegrityError(error);
    try {
      await markRetry(job, error, integrityError);
    } catch (retryError) {
      if (isDatabaseIntegrityError(retryError)) await pauseQueueForIntegrityError(retryError);
      throw retryError;
    }
  }
}

let stopRequested = false;
let lastQueueRepairAt = 0;
let queueRepairCursor = null;
let lastSettingsRefreshAt = 0;
let lastHeartbeatAt = 0;
let lastClaimedAt = null;
let lastClaimCount = 0;
let lastClaimDurationMs = null;
let lastGenerationDurationMs = null;
let lastWriteDurationMs = null;
let lastRepairError = null;
let lastRepairErrorLoggedAt = 0;
let repeatedRepairErrors = 0;
let integrityPaused = false;
let integrityAlerted = false;
let integrityPausePromise = null;
const activeJobs = new Map();
const emptySubjectUntil = new Map();
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
  if (cachedSchedule.globallyPaused && settings && !settings.globallyPaused) integrityAlerted = false;
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
      const schedule = await currentSchedule();
      if (!schedule.globallyPaused && !integrityPaused
        && (!lastQueueRepairAt || Date.now() - lastQueueRepairAt >= queueRepairIntervalMs)) {
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
          if (isDatabaseIntegrityError(error)) await pauseQueueForIntegrityError(error);
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
            lastClaimDurationMs,
            lastGenerationDurationMs,
            lastWriteDurationMs,
            lastRepairError,
            queueRepairCursor,
          },
        });
      }
      if (schedule.globallyPaused || cachedSchedule.globallyPaused || integrityPaused) {
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
      if (isDatabaseIntegrityError(error)) await pauseQueueForIntegrityError(error);
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
