import { resolveThumbnailSchedule } from "../thumbnail-scheduler.js";

function integerInRange(value, name, minimum, maximum, httpError) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw httpError(400, `${name}必须是 ${minimum}-${maximum} 之间的整数`);
  }
  return parsed;
}

function booleanValue(value, name, httpError) {
  if (typeof value !== "boolean") throw httpError(400, `${name}必须是布尔值`);
  return value;
}

function validateTimeZone(value, httpError) {
  const timeZone = String(value || "").trim();
  if (!timeZone || timeZone.length > 80) throw httpError(400, "时区不正确");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw httpError(400, "时区不正确");
  }
  return timeZone;
}

export function createAdminThumbnailService({ db, httpError, nowIso }) {
  let overviewCache = null;
  let overviewCacheAt = 0;
  let overviewPromise = null;
  let overviewEpoch = 0;
  function invalidateOverview() {
    overviewEpoch += 1;
    overviewCache = null;
    overviewCacheAt = 0;
  }
  const selectSettingsStmt = db.prepare(`
    SELECT globallyPaused, daytimeConcurrency, nighttimeConcurrency,
           nightStartHour, nightEndHour, timeZone, updatedAt, updatedBy
    FROM thumbnail_queue_settings
    WHERE id = 'default'
  `);
  const updateSettingsStmt = db.prepare(`
    UPDATE thumbnail_queue_settings
    SET globallyPaused = @globallyPaused,
        daytimeConcurrency = @daytimeConcurrency,
        nighttimeConcurrency = @nighttimeConcurrency,
        nightStartHour = @nightStartHour,
        nightEndHour = @nightEndHour,
        timeZone = @timeZone,
        updatedAt = @updatedAt,
        updatedBy = @updatedBy
    WHERE id = 'default'
  `);
  const selectSubjectStmt = db.prepare(`
    SELECT id, name
    FROM subjects
    WHERE id = ? AND deletionRequestedAt IS NULL
  `);
  const upsertSubjectControlStmt = db.prepare(`
    INSERT INTO thumbnail_subject_controls (
      subjectId, generationEnabled, paused, priority, updatedAt, updatedBy
    ) VALUES (
      @subjectId, @generationEnabled, @paused, @priority, @updatedAt, @updatedBy
    )
    ON CONFLICT (subjectId) DO UPDATE SET
      generationEnabled = EXCLUDED.generationEnabled,
      paused = EXCLUDED.paused,
      priority = EXCLUDED.priority,
      updatedAt = EXCLUDED.updatedAt,
      updatedBy = EXCLUDED.updatedBy
  `);
  const selectSubjectControlStmt = db.prepare(`
    SELECT COALESCE(controls.generationEnabled, true) AS generationEnabled,
           COALESCE(controls.paused, false) AS paused,
           COALESCE(controls.priority, 0) AS priority
    FROM subjects
    LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = subjects.id
    WHERE subjects.id = ? AND subjects.deletionRequestedAt IS NULL
  `);
  const retrySubjectFailedStmt = db.prepare(`
    UPDATE thumbnail_jobs jobs
    SET status = 'pending', attempts = 0, workerId = NULL, lockedUntil = NULL,
        nextRetryAt = @now, lastError = NULL, updatedAt = @now, completedAt = NULL
    FROM images
    WHERE images.id = jobs.imageId
      AND images.subjectId = @subjectId
      AND jobs.status = 'failed'
  `);
  const retryAllFailedStmt = db.prepare(`
    UPDATE thumbnail_jobs
    SET status = 'pending', attempts = 0, workerId = NULL, lockedUntil = NULL,
        nextRetryAt = @now, lastError = NULL, updatedAt = @now, completedAt = NULL
    WHERE status = 'failed'
  `);
  const selectGlobalCountsStmt = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COUNT(*) FILTER (WHERE status = 'processing') AS processing,
      COUNT(*) FILTER (WHERE status = 'ready') AS ready,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) AS total,
      MIN(createdAt) FILTER (WHERE status = 'pending') AS oldestPendingAt,
      COUNT(*) FILTER (WHERE completedAt >= NOW() - INTERVAL '5 minutes') AS completedLastFiveMinutes
    FROM thumbnail_jobs
  `);
  const selectPackageRowsStmt = db.prepare(`
    SELECT
      subjects.id AS subjectId,
      subjects.name,
      subjects.imageCount,
      COALESCE(controls.generationEnabled, true) AS generationEnabled,
      COALESCE(controls.paused, false) AS paused,
      COALESCE(controls.priority, 0) AS priority,
      COALESCE(job_counts.pending, 0) AS pending,
      COALESCE(job_counts.processing, 0) AS processing,
      COALESCE(job_counts.ready, 0) AS ready,
      COALESCE(job_counts.failed, 0) AS failed,
      COALESCE(job_counts.total, 0) AS total,
      job_counts.oldestPendingAt,
      COALESCE(job_counts.completedLastFiveMinutes, 0) AS completedLastFiveMinutes,
      controls.updatedAt AS controlUpdatedAt,
      controls.updatedBy AS controlUpdatedBy
    FROM subjects
    LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = subjects.id
    LEFT JOIN (
      SELECT images.subjectId,
        COUNT(*) FILTER (WHERE jobs.status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE jobs.status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE jobs.status = 'ready') AS ready,
        COUNT(*) FILTER (WHERE jobs.status = 'failed') AS failed,
        COUNT(*) AS total,
        MIN(jobs.createdAt) FILTER (WHERE jobs.status = 'pending') AS oldestPendingAt,
        COUNT(*) FILTER (WHERE jobs.completedAt >= NOW() - INTERVAL '5 minutes') AS completedLastFiveMinutes
      FROM thumbnail_jobs jobs
      JOIN images ON images.id = jobs.imageId
      GROUP BY images.subjectId
    ) job_counts ON job_counts.subjectId = subjects.id
    WHERE subjects.deletionRequestedAt IS NULL
      AND subjects.imageCount > 0
    ORDER BY COALESCE(controls.priority, 0) DESC,
             COALESCE(job_counts.processing, 0) DESC,
             COALESCE(job_counts.pending, 0) DESC,
             subjects.createdAt DESC
  `);

  function settingsDto(row) {
    const settings = {
      globallyPaused: Boolean(row?.globallyPaused),
      daytimeConcurrency: Number(row?.daytimeConcurrency || 2),
      nighttimeConcurrency: Number(row?.nighttimeConcurrency || 6),
      nightStartHour: Number(row?.nightStartHour ?? 22),
      nightEndHour: Number(row?.nightEndHour ?? 8),
      timeZone: row?.timeZone || "Asia/Shanghai",
      updatedAt: row?.updatedAt || null,
      updatedBy: row?.updatedBy || null,
    };
    return { ...settings, activeSchedule: resolveThumbnailSchedule(settings) };
  }

  function packageDto(row) {
    const pending = Number(row.pending || 0);
    const processing = Number(row.processing || 0);
    const ready = Number(row.ready || 0);
    const failed = Number(row.failed || 0);
    const completedLastFiveMinutes = Number(row.completedLastFiveMinutes || 0);
    const ratePerMinute = completedLastFiveMinutes / 5;
    let state = "completed";
    if (!row.generationEnabled) state = "disabled";
    else if (row.paused) state = "paused";
    else if (processing > 0) state = "processing";
    else if (pending > 0) state = "queued";
    else if (failed > 0) state = "failed";
    return {
      subjectId: row.subjectId,
      name: row.name,
      imageCount: Number(row.imageCount || 0),
      generationEnabled: Boolean(row.generationEnabled),
      paused: Boolean(row.paused),
      priority: Number(row.priority || 0),
      state,
      counts: { pending, processing, ready, failed, total: Number(row.total || 0) },
      oldestPendingAt: row.oldestPendingAt || null,
      completedLastFiveMinutes,
      ratePerMinute,
      estimatedMinutes: row.generationEnabled && !row.paused && pending > 0 && ratePerMinute > 0
        ? Math.ceil(pending / ratePerMinute)
        : null,
      controlUpdatedAt: row.controlUpdatedAt || null,
      controlUpdatedBy: row.controlUpdatedBy || null,
    };
  }

  async function getOverview() {
    if (overviewCache && Date.now() - overviewCacheAt < 30_000) return overviewCache;
    if (overviewPromise) return overviewPromise;
    const epoch = overviewEpoch;
    overviewPromise = (async () => {
      const [settings, counts, rows] = await Promise.all([
        selectSettingsStmt.get(),
        selectGlobalCountsStmt.get(),
        selectPackageRowsStmt.all(),
      ]);
      const packages = rows.map(packageDto);
      const completedLastFiveMinutes = Number(counts?.completedLastFiveMinutes || 0);
      const overview = {
        settings: settingsDto(settings),
        counts: {
          pending: Number(counts?.pending || 0),
          eligiblePending: packages.reduce((total, item) => total + (item.generationEnabled ? item.counts.pending : 0), 0),
          excludedPending: packages.reduce((total, item) => total + (item.generationEnabled ? 0 : item.counts.pending), 0),
          processing: Number(counts?.processing || 0),
          ready: Number(counts?.ready || 0),
          failed: Number(counts?.failed || 0),
          total: Number(counts?.total || 0),
          oldestPendingAt: counts?.oldestPendingAt || null,
          completedLastFiveMinutes,
          ratePerMinute: completedLastFiveMinutes / 5,
        },
        packages,
        generatedAt: nowIso(),
      };
      if (epoch === overviewEpoch) {
        overviewCache = overview;
        overviewCacheAt = Date.now();
      }
      return overview;
    })().finally(() => { overviewPromise = null; });
    return overviewPromise;
  }

  async function updateSettings(payload, actor) {
    const current = settingsDto(await selectSettingsStmt.get());
    const next = {
      globallyPaused: payload.globallyPaused == null
        ? current.globallyPaused
        : booleanValue(payload.globallyPaused, "全局暂停状态", httpError),
      daytimeConcurrency: payload.daytimeConcurrency == null
        ? current.daytimeConcurrency
        : integerInRange(payload.daytimeConcurrency, "白天并发", 1, 16, httpError),
      nighttimeConcurrency: payload.nighttimeConcurrency == null
        ? current.nighttimeConcurrency
        : integerInRange(payload.nighttimeConcurrency, "夜间并发", 1, 16, httpError),
      nightStartHour: payload.nightStartHour == null
        ? current.nightStartHour
        : integerInRange(payload.nightStartHour, "夜间开始时间", 0, 23, httpError),
      nightEndHour: payload.nightEndHour == null
        ? current.nightEndHour
        : integerInRange(payload.nightEndHour, "夜间结束时间", 0, 23, httpError),
      timeZone: payload.timeZone == null
        ? current.timeZone
        : validateTimeZone(payload.timeZone, httpError),
    };
    if (next.nightStartHour === next.nightEndHour) {
      throw httpError(400, "夜间开始和结束时间不能相同");
    }
    await updateSettingsStmt.run({ ...next, updatedAt: nowIso(), updatedBy: actor || null });
    invalidateOverview();
    return settingsDto(await selectSettingsStmt.get());
  }

  async function updatePackageControl(subjectId, payload, actor) {
    const subject = await selectSubjectStmt.get(subjectId);
    if (!subject) throw httpError(404, "图包不存在");
    const current = await selectSubjectControlStmt.get(subjectId);
    const generationEnabled = payload.generationEnabled == null
      ? Boolean(current.generationEnabled)
      : booleanValue(payload.generationEnabled, "缩略图生成状态", httpError);
    const paused = payload.paused == null
      ? Boolean(current.paused)
      : booleanValue(payload.paused, "暂停状态", httpError);
    const priority = payload.priority == null
      ? Number(current.priority || 0)
      : integerInRange(payload.priority, "优先级", -100000, 100000, httpError);
    await upsertSubjectControlStmt.run({
      subjectId,
      generationEnabled,
      paused: generationEnabled ? paused : false,
      priority,
      updatedAt: nowIso(),
      updatedBy: actor || null,
    });
    invalidateOverview();
    return { subjectId, generationEnabled, paused: generationEnabled ? paused : false, priority };
  }

  async function retryPackageFailed(subjectId) {
    const subject = await selectSubjectStmt.get(subjectId);
    if (!subject) throw httpError(404, "图包不存在");
    const result = await retrySubjectFailedStmt.run({ subjectId, now: nowIso() });
    invalidateOverview();
    return { subjectId, retried: result.changes };
  }

  async function retryAllFailed() {
    const result = await retryAllFailedStmt.run({ now: nowIso() });
    invalidateOverview();
    return { retried: result.changes };
  }

  return { getOverview, updateSettings, updatePackageControl, retryPackageFailed, retryAllFailed };
}
