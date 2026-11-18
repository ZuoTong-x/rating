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
  const overviewCache = new Map();
  const overviewPromises = new Map();
  let globalCountsCache = null;
  let globalCountsPromise = null;
  let overviewEpoch = 0;
  function invalidateOverview() {
    overviewEpoch += 1;
    overviewCache.clear();
    globalCountsCache = null;
    globalCountsPromise = null;
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
      COALESCE(SUM(stats.pending), 0) AS pending,
      COALESCE(SUM(stats.processing), 0) AS processing,
      COALESCE(SUM(stats.ready), 0) AS ready,
      COALESCE(SUM(stats.failed), 0) AS failed,
      COALESCE(SUM(stats.total), 0) AS total,
      COUNT(*) FILTER (WHERE COALESCE(stats.initialized, false) = false) AS uninitialized,
      COALESCE(SUM(stats.pending) FILTER (WHERE COALESCE(controls.generationEnabled, true)), 0) AS eligiblePending,
      COALESCE(SUM(stats.pending) FILTER (WHERE NOT COALESCE(controls.generationEnabled, true)), 0) AS excludedPending
    FROM subjects
    LEFT JOIN thumbnail_subject_stats stats ON stats.subjectId = subjects.id
    LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = subjects.id
    WHERE subjects.deletionRequestedAt IS NULL AND subjects.imageCount > 0
  `);
  const selectRecentCompletedStmt = db.prepare(`
    SELECT COUNT(*) AS completedLastFiveMinutes
    FROM thumbnail_jobs
    WHERE status = 'ready' AND completedAt >= NOW() - INTERVAL '5 minutes'
  `);
  async function getGlobalCounts() {
    if (globalCountsCache && Date.now() - globalCountsCache.at < 45_000) return globalCountsCache.value;
    if (globalCountsPromise) return globalCountsPromise;
    const epoch = overviewEpoch;
    let pending;
    pending = selectGlobalCountsStmt.get()
      .then((value) => {
        if (epoch === overviewEpoch) globalCountsCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => { if (globalCountsPromise === pending) globalCountsPromise = null; });
    globalCountsPromise = pending;
    return pending;
  }
  const selectPackageRowsStmt = db.prepare(`
    SELECT
      subjects.id AS subjectId,
      subjects.name,
      subjects.imageCount,
      subjects.createdAt AS importedAt,
      COALESCE(controls.generationEnabled, true) AS generationEnabled,
      COALESCE(controls.paused, false) AS paused,
      COALESCE(controls.priority, 0) AS priority,
      controls.updatedAt AS controlUpdatedAt,
      controls.updatedBy AS controlUpdatedBy
    FROM subjects
    LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = subjects.id
    LEFT JOIN thumbnail_subject_stats stats ON stats.subjectId = subjects.id
    WHERE subjects.deletionRequestedAt IS NULL
      AND subjects.imageCount > 0
    ORDER BY COALESCE(controls.priority, 0) DESC,
             COALESCE(stats.processing, 0) DESC,
             COALESCE(stats.pending, 0) DESC,
             subjects.createdAt DESC
  `);
  const selectPackageTotalStmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM subjects
    WHERE deletionRequestedAt IS NULL AND imageCount > 0
      AND (? = '' OR LOWER(name) LIKE ? OR id LIKE ?)
  `);
  const selectMaxPriorityStmt = db.prepare(`
    SELECT COALESCE(MAX(priority), 0) AS maxPriority FROM thumbnail_subject_controls
  `);
  const completedPackageCondition = `
    EXISTS (
      SELECT 1 FROM projects project
      WHERE project.deletionRequestedAt IS NULL
        AND project.taskStatus = 'task_completed'
        AND (project.packageId = subjects.id OR EXISTS (
          SELECT 1 FROM project_packages link
          WHERE link.projectId = project.id AND link.packageId = subjects.id
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM projects project
      WHERE project.deletionRequestedAt IS NULL
        AND project.taskStatus <> 'task_completed'
        AND (project.packageId = subjects.id OR EXISTS (
          SELECT 1 FROM project_packages link
          WHERE link.projectId = project.id AND link.packageId = subjects.id
        ))
    )
  `;
  const selectCompletedCandidatesStmt = db.prepare(`
    SELECT subjects.id AS subjectId, subjects.name, subjects.createdAt AS importedAt,
           pending.pending AS pendingCount
    FROM subjects
    LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = subjects.id
    JOIN thumbnail_subject_stats pending ON pending.subjectId = subjects.id
    WHERE subjects.deletionRequestedAt IS NULL
      AND COALESCE(controls.generationEnabled, true) = true
      AND pending.initialized = true AND pending.pending > 0
      AND ${completedPackageCondition}
    ORDER BY subjects.createdAt DESC, subjects.id ASC
    LIMIT 100
  `);
  const selectPackagePageStmt = db.prepare(`
    SELECT subjects.id AS subjectId, subjects.name, subjects.imageCount,
           subjects.createdAt AS importedAt,
           COALESCE(controls.generationEnabled, true) AS generationEnabled,
           COALESCE(controls.paused, false) AS paused,
           COALESCE(controls.priority, 0) AS priority,
           controls.updatedAt AS controlUpdatedAt,
           controls.updatedBy AS controlUpdatedBy
    FROM subjects
    LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = subjects.id
    WHERE subjects.deletionRequestedAt IS NULL AND subjects.imageCount > 0
      AND (? = '' OR LOWER(subjects.name) LIKE ? OR subjects.id LIKE ?)
    ORDER BY COALESCE(controls.priority, 0) DESC, subjects.createdAt DESC, subjects.id ASC
    LIMIT ? OFFSET ?
  `);

  async function getPageJobCounts(subjectIds) {
    if (!subjectIds.length) return new Map();
    const values = subjectIds.map(() => "(?)").join(", ");
    const statsRows = await db.prepare(`
      WITH selected(subjectId) AS (VALUES ${values})
      SELECT selected.subjectId, COALESCE(stats.initialized, false) AS statsReady,
             COALESCE(stats.pending, 0) AS pending,
             COALESCE(stats.processing, 0) AS processing,
             COALESCE(stats.ready, 0) AS ready,
             COALESCE(stats.failed, 0) AS failed,
             COALESCE(stats.total, 0) AS total
      FROM selected
      LEFT JOIN thumbnail_subject_stats stats ON stats.subjectId = selected.subjectId
    `).all(...subjectIds);
    const recentRows = await db.prepare(`
      SELECT images.subjectId, COUNT(*) AS completedLastFiveMinutes
      FROM thumbnail_jobs jobs
      JOIN images ON images.id = jobs.imageId
      WHERE jobs.status = 'ready'
        AND jobs.completedAt >= NOW() - INTERVAL '5 minutes'
        AND images.subjectId IN (${subjectIds.map(() => "?").join(", ")})
      GROUP BY images.subjectId
    `).all(...subjectIds);
    const recent = new Map(recentRows.map((row) => [row.subjectId, Number(row.completedLastFiveMinutes || 0)]));
    return new Map(statsRows.map((row) => [row.subjectId, {
      ...row,
      completedLastFiveMinutes: recent.get(row.subjectId) || 0,
    }]));
  }

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
    if (!row.statsReady) state = "calculating";
    if (!row.generationEnabled) state = "disabled";
    else if (row.paused) state = "paused";
    else if (processing > 0) state = "processing";
    else if (pending > 0) state = "queued";
    else if (failed > 0) state = "failed";
    return {
      subjectId: row.subjectId,
      name: row.name,
      imageCount: Number(row.imageCount || 0),
      importedAt: row.importedAt || null,
      generationEnabled: Boolean(row.generationEnabled),
      paused: Boolean(row.paused),
      priority: Number(row.priority || 0),
      statsReady: Boolean(row.statsReady),
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
      skipReason: !row.generationEnabled && String(row.controlUpdatedBy || "").startsWith("completed-project:")
        ? "关联项目已完成"
        : null,
    };
  }

  async function getOverview(query = {}) {
    const requestedPage = Number.parseInt(String(query.page ?? ""), 10);
    const paged = Number.isInteger(requestedPage) && requestedPage > 0;
    const page = paged ? Math.min(requestedPage, 100000) : 1;
    const requestedPageSize = Number.parseInt(String(query.pageSize ?? ""), 10);
    const pageSize = paged && Number.isInteger(requestedPageSize)
      ? Math.max(10, Math.min(requestedPageSize, 50))
      : 25;
    const search = paged ? String(query.search || "").trim().toLowerCase().slice(0, 80) : "";
    const searchPattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const cacheKey = paged ? JSON.stringify([page, pageSize, search]) : "all";
    const promiseKey = `${overviewEpoch}:${cacheKey}`;
    const cached = overviewCache.get(cacheKey);
    if (cached && Date.now() - cached.at < (paged ? 45_000 : 5 * 60_000)) {
      return cached.value;
    }
    if (overviewPromises.has(promiseKey)) return overviewPromises.get(promiseKey);
    const epoch = overviewEpoch;
    const promise = (async () => {
      const rowsPromise = paged
        ? selectPackagePageStmt.all(search, searchPattern, searchPattern, pageSize, (page - 1) * pageSize)
        : selectPackageRowsStmt.all();
      const pageCountsPromise = rowsPromise.then((rows) => getPageJobCounts(rows.map((row) => row.subjectId)));
      const [settings, counts, recentCompleted, rows, totalRow, maxPriorityRow, pageCounts] = await Promise.all([
        selectSettingsStmt.get(),
        getGlobalCounts(),
        selectRecentCompletedStmt.get(),
        rowsPromise,
        selectPackageTotalStmt.get(search, searchPattern, searchPattern),
        selectMaxPriorityStmt.get(),
        pageCountsPromise,
      ]);
      const packages = rows.map((row) => packageDto({ ...row, ...(pageCounts?.get(row.subjectId) || {}) }));
      const completedLastFiveMinutes = Number(recentCompleted?.completedLastFiveMinutes || 0);
      const overview = {
        settings: settingsDto(settings),
        counts: {
          statsReady: Number(counts?.uninitialized || 0) === 0,
          pending: Number(counts?.pending || 0),
          eligiblePending: Number(counts?.eligiblePending || 0),
          excludedPending: Number(counts?.excludedPending || 0),
          processing: Number(counts?.processing || 0),
          ready: Number(counts?.ready || 0),
          failed: Number(counts?.failed || 0),
          total: Number(counts?.total || 0),
          oldestPendingAt: null,
          completedLastFiveMinutes,
          ratePerMinute: completedLastFiveMinutes / 5,
        },
        packages,
        totalPackages: Number(totalRow?.total || 0),
        page,
        pageSize,
        maxPriority: Number(maxPriorityRow?.maxPriority || 0),
        generatedAt: nowIso(),
      };
      if (epoch === overviewEpoch) {
        overviewCache.set(cacheKey, { value: overview, at: Date.now() });
        if (overviewCache.size > 64) {
          const oldestPageKey = [...overviewCache.keys()].find((key) => key !== "all");
          if (oldestPageKey) overviewCache.delete(oldestPageKey);
        }
      }
      return overview;
    })().finally(() => { overviewPromises.delete(promiseKey); });
    overviewPromises.set(promiseKey, promise);
    return promise;
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

  async function getCompletedCandidates() {
    const rows = await selectCompletedCandidatesStmt.all();
    return rows.map((row) => ({
      subjectId: row.subjectId,
      name: row.name,
      importedAt: row.importedAt,
      pendingCount: Number(row.pendingCount || 0),
    }));
  }

  async function disableCompletedPackages(subjectIds, actor) {
    if (!Array.isArray(subjectIds) || subjectIds.length < 1 || subjectIds.length > 100
      || subjectIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 200)) {
      throw httpError(400, "请选择 1–100 个已完成图包");
    }
    const ids = [...new Set(subjectIds)];
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = db.prepare(`
      INSERT INTO thumbnail_subject_controls (
        subjectId, generationEnabled, paused, priority, updatedAt, updatedBy
      )
      SELECT subjects.id, false, false, COALESCE(controls.priority, 0), ?, ?
      FROM subjects
      LEFT JOIN thumbnail_subject_controls controls ON controls.subjectId = subjects.id
      WHERE subjects.id IN (${placeholders})
        AND subjects.deletionRequestedAt IS NULL
        AND COALESCE(controls.generationEnabled, true) = true
        AND ${completedPackageCondition}
        AND EXISTS (
          SELECT 1 FROM thumbnail_subject_stats stats
          WHERE stats.subjectId = subjects.id AND stats.initialized = true AND stats.pending > 0
        )
      ON CONFLICT (subjectId) DO UPDATE SET
        generationEnabled = false, paused = false,
        updatedAt = EXCLUDED.updatedAt, updatedBy = EXCLUDED.updatedBy
      RETURNING subjectId
    `);
    const rows = await stmt.all(nowIso(), `completed-project:${actor || "admin"}`, ...ids);
    invalidateOverview();
    return { disabled: rows.length, subjectIds: rows.map((row) => row.subjectId) };
  }

  return {
    getOverview, updateSettings, updatePackageControl, retryPackageFailed, retryAllFailed,
    getCompletedCandidates, disableCompletedPackages,
  };
}
