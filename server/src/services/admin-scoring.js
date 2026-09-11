import crypto from "node:crypto";
import { once } from "node:events";

function placeholders(length) {
  return Array.from({ length }, () => "?").join(", ");
}
function chunk(items, size = 400) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function criterionFromTaskType(taskType) {
  return String(taskType || "").split(":")[1] || null;
}

function reportRate(count, total) {
  return total ? count / total : 0;
}

async function writeResponseChunk(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

async function endResponseStream(stream, chunk = "") {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off?.("finish", onFinish);
      reject(error);
    };
    const onFinish = () => {
      stream.off?.("error", onError);
      resolve();
    };
    stream.once?.("error", onError);
    stream.once?.("finish", onFinish);
    stream.end(chunk);
  });
}

function exportProgress(onProgress, stage, progress) {
  onProgress?.({
    stage,
    progress: Math.max(0, Math.min(99, Math.round(progress))),
  });
}

function parseOptionalScorer(value, httpError) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > 100) throw httpError(400, "打分人不能超过 100 字");
  return text;
}

function parseOptionalSubmissionMode(value, httpError) {
  const mode = String(value ?? "").trim();
  if (!mode) return null;
  if (!["direct", "ranked", "untracked"].includes(mode)) {
    throw httpError(400, "提交方式筛选不正确");
  }
  return mode;
}

function parseTaskCursor(value, httpError) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw httpError(400, "任务分页游标格式不正确");
  }
  const completedAt = String(parsed?.completedAt ?? "");
  const id = String(parsed?.id ?? "");
  if (!completedAt || !id) throw httpError(400, "任务分页游标格式不正确");
  return { completedAt, id };
}

function includeTaskTotal(query = {}) {
  return ["1", "true", "yes"].includes(
    String(query.includeTotal ?? "").toLowerCase(),
  );
}

function parseDurationSeconds(value, label, httpError) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw httpError(400, `${label}不正确`);
  }
  return Math.round(seconds * 1000);
}

function taskIdFromPayloadItem(item) {
  if (typeof item === "string" || typeof item === "number") return item;
  if (!item || typeof item !== "object") return null;
  return item.id ?? item.taskId ?? item._id ?? null;
}

function extractTaskIds(payload, httpError) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.taskIds)
      ? payload.taskIds
      : Array.isArray(payload?.ids)
        ? payload.ids
        : Array.isArray(payload?.tasks)
          ? payload.tasks
          : Array.isArray(payload?.rows)
            ? payload.rows
            : [];

  const rawIds = source
    .map(taskIdFromPayloadItem)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (!rawIds.length) throw httpError(400, "JSON 中未找到可回退的任务 ID");
  if (rawIds.length > 10000) throw httpError(400, "一次最多回退 10000 个任务");

  const seen = new Set();
  const taskIds = [];
  rawIds.forEach((id) => {
    if (seen.has(id)) return;
    seen.add(id);
    taskIds.push(id);
  });
  return {
    rawTaskCount: rawIds.length,
    duplicateTaskCount: rawIds.length - taskIds.length,
    taskIds,
  };
}

function normalizeScorerNameList(value, label, httpError) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const names = [];
  const seen = new Set();
  source.forEach((item) => {
    const name = String(item ?? "").trim();
    if (!name) return;
    if (name.length > 100) throw httpError(400, `${label}不能超过 100 字`);
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  });
  if (!names.length) throw httpError(400, `请选择${label}`);
  if (names.length > 100) throw httpError(400, `${label}一次最多选择 100 人`);
  return names;
}

function rollbackSource(payload = {}) {
  return payload?.source === "scorer_full" ? "scorer_full" : "task_ids";
}

function scorerFullRollbackMode(payload = {}) {
  const mode = String(
    payload.returnMode ?? payload.rollbackMode ?? payload.reassignmentMode ?? "",
  ).trim();
  if (payload.returnToSource === true || mode === "original" || mode === "return_original") {
    return "original";
  }
  return "reassign";
}

function reassignmentAllocationInput(payload = {}) {
  return payload?.reassignment?.allocations ?? payload?.allocations ?? payload?.assignees;
}

function parseRollbackAssigneeAllocations(value, httpError) {
  if (!Array.isArray(value)) throw httpError(400, "请设置承接人和承接数量");
  const allocations = [];
  const seen = new Set();
  value.forEach((item) => {
    const scorer = String(item?.scorer ?? item?.username ?? item?.name ?? "").trim();
    const taskCount = Math.floor(Number(item?.taskCount ?? item?.count ?? 0));
    if (!scorer && !taskCount) return;
    if (!scorer) throw httpError(400, "承接人不能为空");
    if (seen.has(scorer)) throw httpError(400, `承接人 ${scorer} 重复设置`);
    seen.add(scorer);
    if (!Number.isInteger(taskCount) || taskCount < 0) {
      throw httpError(400, `承接人 ${scorer} 的承接数量必须是非负整数`);
    }
    if (taskCount > 0) allocations.push({ scorer, taskCount });
  });
  if (!allocations.length) throw httpError(400, "请至少设置一名承接人");
  if (allocations.length > 100) throw httpError(400, "承接人一次最多选择 100 人");
  return allocations;
}

function randomShuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const selectedIndex = crypto.randomInt(0, index + 1);
    [shuffled[index], shuffled[selectedIndex]] = [shuffled[selectedIndex], shuffled[index]];
  }
  return shuffled;
}

function groupTaskIdsByAssignee(rows, allocations) {
  const shuffledTaskIds = randomShuffle(rows.map((row) => row.id));
  const groups = [];
  let offset = 0;
  allocations.forEach((allocation) => {
    const taskIds = shuffledTaskIds.slice(offset, offset + allocation.taskCount);
    offset += allocation.taskCount;
    groups.push({ scorer: allocation.scorer, taskIds });
  });
  return groups;
}

function taskRecordDto(row) {
  const durationMs = row.durationMs == null ? null : Number(row.durationMs);
  return {
    taskId: row.id,
    projectId: row.projectId || row.subjectId,
    projectName: row.projectName || "未命名项目",
    criterion: criterionFromTaskType(row.taskType),
    status: row.status,
    scorer: row.scorer || "未分配",
    submissionMode: row.submissionMode || null,
    rankingActionCount: Number(row.rankingActionCount || 0),
    largeImageOpened: Boolean(row.largeImageOpened),
    isBacktest: Boolean(row.isBacktest),
    backtestSourceTaskId: row.backtestSourceId || null,
    durationMs,
    durationSeconds: durationMs == null ? null : durationMs / 1000,
    completedAt: row.completedAt ?? null,
    editedAt: row.editedAt ?? null,
    editCount: Number(row.editCount || 0),
    rollbackCount: Number(row.rollbackCount || 0),
    updatedAt: row.updatedAt,
  };
}

function groupRollbackRows(rows, key, nameKey) {
  const map = new Map();
  rows.forEach((row) => {
    const id = row[key] || "unknown";
    const item = map.get(id) || {
      id,
      name: row[nameKey] || id,
      taskCount: 0,
    };
    item.taskCount += 1;
    map.set(id, item);
  });
  return [...map.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN"),
  );
}

export function createAdminScoringService({
  db,
  taskVersion,
  httpError,
  nowIso,
  parseProjectId,
  parseTaskPagination,
  selectScorerByUsernameStmt,
  assertScorerAssignable,
  withDatabaseContext,
  onTasksChanged,
}) {
  const rollbackJobs = new Map();
  const activeRollbackJobsByKey = new Map();
  const summaryCache = new Map();
  const summaryInFlight = new Map();
  const summaryCacheTtlMs = 15 * 1000;

  async function buildSummaryFilter(query = {}) {
    const clauses = [
      "rating_tasks.taskVersion = ?",
      "rating_tasks.status = 'completed'",
      "rating_tasks.scorer IS NOT NULL",
      "TRIM(rating_tasks.scorer) <> ''",
    ];
    const params = [taskVersion];
    const scorer = parseOptionalScorer(query.scorer, httpError);
    const projectId = query.projectId ? await parseProjectId(query.projectId) : null;
    if (scorer) {
      clauses.push("rating_tasks.scorer = ?");
      params.push(scorer);
    }
    if (projectId) {
      clauses.push("rating_tasks.projectId = ?");
      params.push(projectId);
    }
    return {
      where: `WHERE ${clauses.join(" AND ")}`,
      params,
      scorer,
      projectId,
    };
  }

  async function buildTaskFilter(query = {}) {
    const filter = await buildSummaryFilter(query);
    const clauses = [filter.where.replace(/^WHERE\s+/i, "")];
    const params = [...filter.params];
    const submissionMode = parseOptionalSubmissionMode(query.submissionMode, httpError);
    const minDurationMs = parseDurationSeconds(query.minDurationSeconds, "最短打分时长", httpError);
    const maxDurationMs = parseDurationSeconds(query.maxDurationSeconds, "最长打分时长", httpError);

    if (submissionMode === "untracked") {
      clauses.push("rating_tasks.submissionMode IS NULL");
    } else if (submissionMode) {
      clauses.push("rating_tasks.submissionMode = ?");
      params.push(submissionMode);
    }
    if (minDurationMs != null) {
      clauses.push("rating_tasks.durationMs >= ?");
      params.push(minDurationMs);
    }
    if (maxDurationMs != null) {
      clauses.push("rating_tasks.durationMs <= ?");
      params.push(maxDurationMs);
    }
    return {
      where: `WHERE ${clauses.join(" AND ")}`,
      params,
      scorer: filter.scorer,
      projectId: filter.projectId,
      submissionMode,
      minDurationMs,
      maxDurationMs,
    };
  }

  function summaryResultFromRows(rows, totalsRow, page, pageSize) {
    const totals = {
      scorerCount: Number(totalsRow?.scorerCount || 0),
      totalTaskCount: Number(totalsRow?.totalTaskCount || 0),
      undraggedSubmitCount: Number(totalsRow?.undraggedSubmitCount || 0),
      rankedSubmitCount: Number(totalsRow?.rankedSubmitCount || 0),
      untrackedSubmitCount: Number(totalsRow?.untrackedSubmitCount || 0),
      largeImageOpenedCount: Number(totalsRow?.largeImageOpenedCount || 0),
    };
    totals.directSubmitCount = totals.undraggedSubmitCount;

    return {
      ...totals,
      page,
      pageSize,
      directSubmitRate: reportRate(totals.undraggedSubmitCount, totals.totalTaskCount),
      undraggedSubmitRate: reportRate(totals.undraggedSubmitCount, totals.totalTaskCount),
      largeImageOpenedRate: reportRate(totals.largeImageOpenedCount, totals.totalTaskCount),
      scorers: rows.map((row) => {
        const totalTaskCount = Number(row.totalTaskCount || 0);
        const undraggedSubmitCount = Number(row.undraggedSubmitCount || 0);
        const rankedSubmitCount = Number(row.rankedSubmitCount || 0);
        const untrackedSubmitCount = Number(row.untrackedSubmitCount || 0);
        const averageDurationMs = Number(row.durationCount || 0)
          ? Number(row.durationTotal || 0) / Number(row.durationCount)
          : null;
        const minDurationMs = row.durationMin == null ? null : Number(row.durationMin);
        const maxDurationMs = row.durationMax == null ? null : Number(row.durationMax);
        const largeImageOpenedCount = Number(row.largeImageOpenedCount || 0);
        return {
          scorer: row.scorer,
          projectCount: Number(row.projectCount || 0),
          totalTaskCount,
          undraggedSubmitCount,
          directSubmitCount: undraggedSubmitCount,
          rankedSubmitCount,
          untrackedSubmitCount,
          directSubmitRate: reportRate(undraggedSubmitCount, totalTaskCount),
          undraggedSubmitRate: reportRate(undraggedSubmitCount, totalTaskCount),
          largeImageOpenedCount,
          largeImageOpenedRate: reportRate(largeImageOpenedCount, totalTaskCount),
          averageDurationMs,
          averageDurationSeconds: averageDurationMs == null ? null : averageDurationMs / 1000,
          minDurationMs,
          minDurationSeconds: minDurationMs == null ? null : minDurationMs / 1000,
          maxDurationMs,
          maxDurationSeconds: maxDurationMs == null ? null : maxDurationMs / 1000,
          rollbackCount: Number(row.rollbackCount || 0),
        };
      }),
    };
  }

  async function calculateScoringSummary(query = {}) {
    const { page, pageSize } = parseTaskPagination(query);
    const filter = await buildTaskFilter(query);
    const hasDurationFilter = filter.minDurationMs != null || filter.maxDurationMs != null;
    const source = hasDurationFilter ? `
      SELECT rating_tasks.scorer,
             rating_tasks.projectId,
             rating_tasks.submissionMode,
             rating_tasks.largeImageOpened,
             rating_tasks.durationMs,
             rating_tasks.rollbackCount
      FROM rating_tasks
      ${filter.where}
    ` : `
      SELECT scorer,
             NULLIF(projectId, '') AS projectId,
             NULLIF(submissionMode, 'untracked') AS submissionMode,
             taskCount,
             largeImageOpenedCount,
             durationTotal,
             durationCount,
             durationMin,
             durationMax,
             rollbackCount
      FROM scorer_scoring_stats
      WHERE taskVersion = ?
        ${filter.scorer ? "AND scorer = ?" : ""}
        ${filter.projectId ? "AND projectId = ?" : ""}
        ${filter.submissionMode ? "AND submissionMode = ?" : ""}
    `;
    const sourceParams = hasDurationFilter
      ? filter.params
      : (() => {
        const values = [taskVersion];
        if (filter.scorer) values.push(filter.scorer);
        if (filter.projectId) values.push(filter.projectId);
        if (filter.submissionMode) values.push(filter.submissionMode);
        return values;
      })();
    const groupedSelect = hasDurationFilter ? `
      COUNT(*) AS totalTaskCount,
      COUNT(DISTINCT projectId) AS projectCount,
      SUM(CASE WHEN submissionMode = 'direct' THEN 1 ELSE 0 END) AS undraggedSubmitCount,
      SUM(CASE WHEN submissionMode = 'ranked' THEN 1 ELSE 0 END) AS rankedSubmitCount,
      SUM(CASE WHEN submissionMode IS NULL THEN 1 ELSE 0 END) AS untrackedSubmitCount,
      SUM(CASE WHEN largeImageOpened THEN 1 ELSE 0 END) AS largeImageOpenedCount,
      SUM(CASE WHEN durationMs >= 0 THEN durationMs ELSE 0 END) AS durationTotal,
      SUM(CASE WHEN durationMs >= 0 THEN 1 ELSE 0 END) AS durationCount,
      SUM(CASE WHEN durationMs >= 0 THEN durationMs ELSE 0 END)::double precision
        / NULLIF(SUM(CASE WHEN durationMs >= 0 THEN 1 ELSE 0 END), 0) AS averageDurationMs,
      MIN(CASE WHEN durationMs >= 0 THEN durationMs END) AS durationMin,
      MAX(CASE WHEN durationMs >= 0 THEN durationMs END) AS durationMax,
      SUM(COALESCE(rollbackCount, 0)) AS rollbackCount
    ` : `
      SUM(taskCount) AS totalTaskCount,
      COUNT(DISTINCT projectId) AS projectCount,
      SUM(CASE WHEN submissionMode = 'direct' THEN taskCount ELSE 0 END) AS undraggedSubmitCount,
      SUM(CASE WHEN submissionMode = 'ranked' THEN taskCount ELSE 0 END) AS rankedSubmitCount,
      SUM(CASE WHEN submissionMode IS NULL THEN taskCount ELSE 0 END) AS untrackedSubmitCount,
      SUM(largeImageOpenedCount) AS largeImageOpenedCount,
      SUM(durationTotal) AS durationTotal,
      SUM(durationCount) AS durationCount,
      SUM(durationTotal)::double precision / NULLIF(SUM(durationCount), 0) AS averageDurationMs,
      MIN(durationMin) AS durationMin,
      MAX(durationMax) AS durationMax,
      SUM(rollbackCount) AS rollbackCount
    `;
    const rows = await db.prepare(`
      SELECT scorer,
             ${groupedSelect}
      FROM (${source}) filtered
      GROUP BY scorer
      ORDER BY undraggedSubmitCount DESC,
               averageDurationMs ASC NULLS LAST,
               LOWER(scorer) ASC,
               scorer ASC
    `).all(...sourceParams);
    const totalsRow = rows.reduce((totals, row) => ({
      scorerCount: totals.scorerCount + 1,
      totalTaskCount: totals.totalTaskCount + Number(row.totalTaskCount || 0),
      undraggedSubmitCount: totals.undraggedSubmitCount + Number(row.undraggedSubmitCount || 0),
      rankedSubmitCount: totals.rankedSubmitCount + Number(row.rankedSubmitCount || 0),
      untrackedSubmitCount: totals.untrackedSubmitCount + Number(row.untrackedSubmitCount || 0),
      largeImageOpenedCount: totals.largeImageOpenedCount + Number(row.largeImageOpenedCount || 0),
    }), {
      scorerCount: 0,
      totalTaskCount: 0,
      undraggedSubmitCount: 0,
      rankedSubmitCount: 0,
      untrackedSubmitCount: 0,
      largeImageOpenedCount: 0,
    });
    return summaryResultFromRows(rows.slice((page - 1) * pageSize, page * pageSize), totalsRow, page, pageSize);
  }

  async function listScoringSummary(query = {}) {
    const key = JSON.stringify({
      page: query.page || 1,
      pageSize: query.pageSize || 10,
      scorer: query.scorer || null,
      projectId: query.projectId || null,
      submissionMode: query.submissionMode || null,
      minDurationSeconds: query.minDurationSeconds || null,
      maxDurationSeconds: query.maxDurationSeconds || null,
    });
    const cached = summaryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = summaryInFlight.get(key);
    if (pending) return await pending;
    const pendingValue = calculateScoringSummary(query)
      .then((value) => {
        summaryCache.set(key, {
          value,
          expiresAt: Date.now() + summaryCacheTtlMs,
        });
        return value;
      })
      .finally(() => summaryInFlight.delete(key));
    summaryInFlight.set(key, pendingValue);
    const value = await pendingValue;
    summaryCache.set(key, {
      value,
      expiresAt: Date.now() + summaryCacheTtlMs,
    });
    return value;
  }

  function invalidateSummaryCache() {
    summaryCache.clear();
  }

  async function listScoringOptions() {
    const [projects, scorers] = await Promise.all([
      db.prepare(`
        SELECT id AS _id, name
        FROM projects
        WHERE deletionRequestedAt IS NULL
        ORDER BY createdAt DESC, id ASC
      `).all(),
      db.prepare(`
        SELECT username
        FROM users
        WHERE role = 'scorer'
        ORDER BY LOWER(username) ASC, username ASC
      `).all(),
    ]);
    return {
      projects,
      scorers: scorers.map((row) => row.username),
    };
  }

  async function listScoringTaskRecords(query = {}) {
    const { page, pageSize } = parseTaskPagination(query);
    const filter = await buildTaskFilter(query);
    const cursor = parseTaskCursor(query.cursor, httpError);
    const hasDurationFilter = filter.minDurationMs != null || filter.maxDurationMs != null;
    let total = null;
    if (includeTaskTotal(query)) {
      if (hasDurationFilter) {
        const row = await db
          .prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${filter.where}`)
          .get(...filter.params);
        total = Number(row?.total || 0);
      } else {
        const stats = scoringStatsFilter(filter);
        const row = await db
          .prepare(`
            SELECT COALESCE(SUM(taskCount), 0) AS total
            FROM scorer_scoring_stats
            ${stats.where}
          `)
          .get(...stats.params);
        total = Number(row?.total || 0);
      }
    }
    const rows = await db
      .prepare(
        `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
                rating_tasks.taskType, rating_tasks.status, rating_tasks.scorer,
                rating_tasks.submissionMode, rating_tasks.rankingActionCount,
                rating_tasks.largeImageOpened,
                rating_tasks.isBacktest, rating_tasks.backtestSourceId,
                rating_tasks.durationMs, rating_tasks.completedAt, rating_tasks.editedAt,
                rating_tasks.editCount, rating_tasks.rollbackCount, rating_tasks.updatedAt,
                projects.name AS projectName
         FROM rating_tasks
         JOIN projects ON projects.id = rating_tasks.projectId
         ${filter.where}
         ${cursor ? "AND (rating_tasks.completedAt < ? OR (rating_tasks.completedAt = ? AND rating_tasks.id > ?))" : ""}
         ORDER BY rating_tasks.completedAt DESC NULLS LAST, rating_tasks.id ASC
         LIMIT ?${cursor ? "" : " OFFSET ?"}`,
      )
      .all(
      ...filter.params,
      ...(cursor ? [cursor.completedAt, cursor.completedAt, cursor.id] : []),
      pageSize + 1,
      ...(cursor ? [] : [(page - 1) * pageSize])
    );
    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const lastRow = pageRows[pageRows.length - 1];

    return {
      total,
      page,
      pageSize,
      hasMore,
      nextCursor: hasMore && lastRow
        ? JSON.stringify({ completedAt: lastRow.completedAt, id: lastRow.id })
        : null,
      tasks: pageRows.map(taskRecordDto),
    };
  }

  function scoringStatsFilter(filter) {
    const clauses = ["taskVersion = ?"];
    const params = [taskVersion];
    if (filter.scorer) {
      clauses.push("scorer = ?");
      params.push(filter.scorer);
    }
    if (filter.projectId) {
      clauses.push("projectId = ?");
      params.push(filter.projectId);
    }
    if (filter.submissionMode) {
      clauses.push("submissionMode = ?");
      params.push(filter.submissionMode);
    }
    return { where: `WHERE ${clauses.join(" AND ")}`, params };
  }

  async function scoringOperationExportSummary(filter) {
    const hasDurationFilter = filter.minDurationMs != null || filter.maxDurationMs != null;
    if (!hasDurationFilter) {
      const stats = scoringStatsFilter(filter);
      const [totals, scorerRows] = await Promise.all([
        db.prepare(`
          SELECT COALESCE(SUM(taskCount), 0) AS taskCount,
                 COUNT(DISTINCT scorer) AS scorerCount
          FROM scorer_scoring_stats
          ${stats.where}
        `).get(...stats.params),
        db.prepare(`
          SELECT scorer,
                 COALESCE(SUM(taskCount), 0) AS taskCount
          FROM scorer_scoring_stats
          ${stats.where}
          GROUP BY scorer
          ORDER BY LOWER(scorer) ASC, scorer ASC
        `).all(...stats.params),
      ]);
      return {
        taskCount: Number(totals?.taskCount || 0),
        scorerCount: Number(totals?.scorerCount || 0),
        scorers: scorerRows.map((row) => ({
          scorer: row.scorer,
          taskCount: Number(row.taskCount || 0),
        })),
      };
    }

    const [totals, scorerRows] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*) AS taskCount,
               COUNT(DISTINCT rating_tasks.scorer) AS scorerCount
        FROM rating_tasks
        ${filter.where}
      `).get(...filter.params),
      db.prepare(`
        SELECT rating_tasks.scorer AS scorer,
               COUNT(*) AS taskCount
        FROM rating_tasks
        ${filter.where}
        GROUP BY rating_tasks.scorer
        ORDER BY LOWER(rating_tasks.scorer) ASC, rating_tasks.scorer ASC
      `).all(...filter.params),
    ]);
    return {
      taskCount: Number(totals?.taskCount || 0),
      scorerCount: Number(totals?.scorerCount || 0),
      scorers: scorerRows.map((row) => ({
        scorer: row.scorer,
        taskCount: Number(row.taskCount || 0),
      })),
    };
  }

  async function writeScoringOperationsExport(stream, query = {}, onProgress) {
    exportProgress(onProgress, "正在统计打分操作", 5);
    const filter = await buildTaskFilter(query);
    const summary = await scoringOperationExportSummary(filter);
    exportProgress(onProgress, "正在准备导出文件", 10);
    const payload = {
      exportedAt: nowIso(),
      taskVersion,
      filters: {
        scorer: filter.scorer,
        projectId: filter.projectId,
        submissionMode: filter.submissionMode,
        minDurationSeconds: filter.minDurationMs == null ? null : filter.minDurationMs / 1000,
        maxDurationSeconds: filter.maxDurationMs == null ? null : filter.maxDurationMs / 1000,
      },
      taskCount: summary.taskCount,
      scorerCount: summary.scorerCount,
      scorers: summary.scorers,
    };
    await writeResponseChunk(stream, `${JSON.stringify(payload).slice(0, -1)},"operations":[`);

    const batchSize = 1000;
    let written = 0;
    let lastId = null;
    while (true) {
      const rows = await db.prepare(`
        SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
               rating_tasks.taskType, rating_tasks.status, rating_tasks.scorer,
               rating_tasks.submissionMode, rating_tasks.rankingActionCount,
               rating_tasks.largeImageOpened,
               rating_tasks.isBacktest, rating_tasks.backtestSourceId,
               rating_tasks.durationMs, rating_tasks.completedAt, rating_tasks.editedAt,
               rating_tasks.editCount, rating_tasks.rollbackCount, rating_tasks.updatedAt,
               projects.name AS projectName
        FROM rating_tasks
        LEFT JOIN projects ON projects.id = rating_tasks.projectId
        ${filter.where}
          AND (?::text IS NULL OR rating_tasks.id > ?)
        ORDER BY rating_tasks.id ASC
        LIMIT ?
      `).all(...filter.params, lastId, lastId, batchSize);
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;
      const serializedRows = [];
      for (const row of rows) {
        serializedRows.push(`${written ? "," : ""}${JSON.stringify(taskRecordDto(row))}`);
        written += 1;
      }
      await writeResponseChunk(stream, serializedRows.join(""));
      exportProgress(
        onProgress,
        `已写入 ${written}/${summary.taskCount} 条打分操作`,
        summary.taskCount ? 10 + (written / summary.taskCount) * 85 : 95,
      );
    }

    await endResponseStream(stream, "]}");
    exportProgress(onProgress, "打分操作 JSON 已写入", 95);
    return {
      taskCount: summary.taskCount,
      scorerCount: summary.scorerCount,
      operationCount: written,
    };
  }

  async function selectTasksByIds(taskIds) {
    const rows = [];
    for (const ids of chunk(taskIds)) {
      rows.push(
        ...(await db
          .prepare(
            `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
                    rating_tasks.taskVersion, rating_tasks.taskType, rating_tasks.status,
                    rating_tasks.scorer, rating_tasks.submissionMode,
                    rating_tasks.rankingActionCount,
                    rating_tasks.largeImageOpened, rating_tasks.isBacktest,
                    rating_tasks.backtestSourceId, rating_tasks.durationMs,
                    rating_tasks.completedAt, rating_tasks.editedAt, rating_tasks.editCount,
                    rating_tasks.rollbackCount, rating_tasks.updatedAt,
                    projects.name AS projectName
             FROM rating_tasks
             LEFT JOIN projects ON projects.id = rating_tasks.projectId
             WHERE rating_tasks.id IN (${placeholders(ids.length)})`,
          )
          .all(...ids)),
      );
    }
    const order = new Map(taskIds.map((id, index) => [id, index]));
    return rows.sort((left, right) => order.get(left.id) - order.get(right.id));
  }

  async function selectCompletedTasksByScorers({ scorers, projectId, submissionMode }) {
    const clauses = [
      "rating_tasks.taskVersion = ?",
      "rating_tasks.status = 'completed'",
      `rating_tasks.scorer IN (${placeholders(scorers.length)})`,
    ];
    const params = [taskVersion, ...scorers];
    if (projectId) {
      clauses.push("rating_tasks.projectId = ?");
      params.push(projectId);
    }
    if (submissionMode === "untracked") {
      clauses.push("rating_tasks.submissionMode IS NULL");
    } else if (submissionMode) {
      clauses.push("rating_tasks.submissionMode = ?");
      params.push(submissionMode);
    }

    return await db.prepare(`
      SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
             rating_tasks.taskVersion, rating_tasks.taskType, rating_tasks.status,
             rating_tasks.scorer, rating_tasks.submissionMode,
             rating_tasks.rankingActionCount,
             rating_tasks.largeImageOpened, rating_tasks.isBacktest,
             rating_tasks.backtestSourceId, rating_tasks.durationMs,
             rating_tasks.completedAt, rating_tasks.editedAt, rating_tasks.editCount,
             rating_tasks.rollbackCount, rating_tasks.updatedAt,
             projects.name AS projectName
      FROM rating_tasks
      LEFT JOIN projects ON projects.id = rating_tasks.projectId
      WHERE ${clauses.join(" AND ")}
      ORDER BY rating_tasks.scorer ASC,
               rating_tasks.projectId ASC,
               rating_tasks.taskType ASC,
               rating_tasks.completedAt DESC NULLS LAST,
               rating_tasks.id ASC
    `).all(...params);
  }

  async function analyzeTaskIdRollbackPayload(payload) {
    const extracted = extractTaskIds(payload, httpError);
    const rows = await selectTasksByIds(extracted.taskIds);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const missingTaskIds = extracted.taskIds.filter((id) => !rowById.has(id));
    const matchedRows = extracted.taskIds
      .map((id) => rowById.get(id))
      .filter(Boolean);
    const rollbackRows = matchedRows.filter(
      (row) => row.taskVersion === taskVersion && row.status === "completed",
    );
    const ignoredRows = matchedRows.filter(
      (row) => row.taskVersion !== taskVersion || row.status !== "completed",
    );
    return {
      source: "task_ids",
      ...extracted,
      matchedRows,
      rollbackRows,
      ignoredRows,
      missingTaskIds,
      sourceScorers: [],
      projectId: null,
      submissionMode: null,
    };
  }

  async function analyzeScorerRollbackPayload(payload) {
    const sourceScorers = normalizeScorerNameList(
      payload.scorers ?? payload.sourceScorers,
      "回退打分人",
      httpError,
    );
    const projectId = payload.projectId ? await parseProjectId(payload.projectId) : null;
    const submissionMode = parseOptionalSubmissionMode(payload.submissionMode, httpError);
    const rollbackRows = await selectCompletedTasksByScorers({
      scorers: sourceScorers,
      projectId,
      submissionMode,
    });
    return {
      source: "scorer_full",
      rawTaskCount: rollbackRows.length,
      duplicateTaskCount: 0,
      taskIds: rollbackRows.map((row) => row.id),
      matchedRows: rollbackRows,
      rollbackRows,
      ignoredRows: [],
      missingTaskIds: [],
      sourceScorers,
      projectId,
      submissionMode,
    };
  }

  async function analyzeRollbackPayload(payload) {
    return rollbackSource(payload) === "scorer_full"
      ? await analyzeScorerRollbackPayload(payload)
      : await analyzeTaskIdRollbackPayload(payload);
  }

  function rollbackPreviewDto(analysis, options = {}) {
    const includeTaskIds = options.includeTaskIds ?? true;
    const taskPreviewLimit = 300;
    const ignoredPreviewLimit = 100;
    const projectRows = analysis.rollbackRows.map((row) => ({
      ...row,
      projectGroupId: row.projectId || row.subjectId,
      projectGroupName: row.projectName || row.projectId || row.subjectId,
    }));
    return {
      source: analysis.source || "task_ids",
      sourceScorers: analysis.sourceScorers || [],
      projectId: analysis.projectId || null,
      submissionMode: analysis.submissionMode || null,
      requestedTaskCount: analysis.rawTaskCount,
      uniqueTaskCount: analysis.taskIds.length,
      duplicateTaskCount: analysis.duplicateTaskCount,
      matchedTaskCount: analysis.matchedRows.length,
      rollbackTaskCount: analysis.rollbackRows.length,
      ignoredTaskCount: analysis.ignoredRows.length + analysis.missingTaskIds.length,
      missingTaskCount: analysis.missingTaskIds.length,
      taskIds: includeTaskIds ? analysis.rollbackRows.map((row) => row.id) : [],
      scorers: groupRollbackRows(analysis.rollbackRows, "scorer", "scorer"),
      projects: groupRollbackRows(projectRows, "projectGroupId", "projectGroupName"),
      assignees: options.assignees || [],
      tasks: analysis.rollbackRows.slice(0, taskPreviewLimit).map(taskRecordDto),
      ignoredTasks: analysis.ignoredRows.slice(0, ignoredPreviewLimit).map(taskRecordDto),
      missingTaskIds: analysis.missingTaskIds.slice(0, ignoredPreviewLimit),
      taskPreviewLimit,
      ignoredPreviewLimit,
      hasMoreTasks: analysis.rollbackRows.length > taskPreviewLimit,
      hasMoreIgnored: analysis.ignoredRows.length + analysis.missingTaskIds.length > ignoredPreviewLimit,
    };
  }

  async function previewRollback(payload = {}) {
    const analysis = await analyzeRollbackPayload(payload);
    return rollbackPreviewDto(analysis, {
      includeTaskIds: analysis.source !== "scorer_full",
    });
  }

  async function validateRollbackAssignees(payload, analysis) {
    if (analysis.source !== "scorer_full") return null;
    if (scorerFullRollbackMode(payload) === "original") return null;
    const allocations = parseRollbackAssigneeAllocations(
      reassignmentAllocationInput(payload),
      httpError,
    );
    const allocationTotal = allocations.reduce(
      (total, allocation) => total + allocation.taskCount,
      0,
    );
    if (allocationTotal !== analysis.rollbackRows.length) {
      throw httpError(
        400,
        `承接数量合计必须等于可回退任务数 ${analysis.rollbackRows.length}`,
      );
    }

    const sourceScorers = new Set(analysis.sourceScorers || []);
    const overlappingScorers = allocations
      .map((allocation) => allocation.scorer)
      .filter((scorer) => sourceScorers.has(scorer));
    if (overlappingScorers.length) {
      throw httpError(400, `承接人不能包含被回退人员：${overlappingScorers.join("、")}`);
    }

    const users = await Promise.all(allocations.map(async (allocation) =>
      await selectScorerByUsernameStmt.get(allocation.scorer),
    ));
    const missing = allocations
      .filter((_, index) => !users[index])
      .map((allocation) => allocation.scorer);
    if (missing.length) throw httpError(400, `承接人不存在：${missing.join("、")}`);
    await Promise.all(users.map(async (user, index) => {
      if (assertScorerAssignable) {
        await assertScorerAssignable(user, allocations[index].scorer);
        return;
      }
      if ((user.status || "enabled") !== "enabled") {
        throw httpError(400, `承接人 ${allocations[index].scorer} 已禁用`);
      }
    }));

    return {
      allocations,
      groups: groupTaskIdsByAssignee(analysis.rollbackRows, allocations),
      assignees: allocations.map((allocation) => ({
        id: allocation.scorer,
        name: allocation.scorer,
        taskCount: allocation.taskCount,
      })),
    };
  }

  async function updateRolledBackTasks(ids, { assignee, now, adminName }) {
    const scorerAssignment = assignee ? "scorer = ?," : "";
    const params = assignee ? [assignee] : [];
    return (await db
      .prepare(
        `UPDATE rating_tasks
         SET status = 'assigned',
             ${scorerAssignment}
             ranking = NULL,
             excludedImageIds = NULL,
             correctImageIds = NULL,
             rankingRelations = NULL,
             submissionMode = NULL,
             rankingActionCount = 0,
             largeImageOpened = false,
             startedAt = NULL,
             completedAt = NULL,
             durationMs = NULL,
             editedAt = NULL,
             editCount = 0,
             rollbackCount = COALESCE(rollbackCount, 0) + 1,
             lastRolledBackAt = ?,
             lastRolledBackBy = ?,
             updatedAt = ?
         WHERE taskVersion = ?
           AND status = 'completed'
           AND id IN (${placeholders(ids.length)})`,
      )
      .run(...params, now, adminName, now, taskVersion, ...ids)).changes;
  }

  async function rollbackScoringTasks(payload = {}, admin = {}, onProgress) {
    onProgress?.({ stage: "正在校验回退任务", progress: 8 });
    const analysis = await analyzeRollbackPayload(payload);
    if (!analysis.rollbackRows.length) throw httpError(400, "没有可回退的已完成任务");
    const reassignment = await validateRollbackAssignees(payload, analysis);

    const now = nowIso();
    const adminName = String(admin?.username || "admin");
    const taskIds = analysis.rollbackRows.map((row) => row.id);
    const projectIds = [
      ...new Set(
        analysis.rollbackRows
          .map((row) => row.projectId || row.subjectId)
          .filter(Boolean),
      ),
    ];
    let changed = 0;

    onProgress?.({
      stage: reassignment ? "正在回退并分配承接人" : "正在回退任务",
      progress: 20,
    });
    await db.exec("BEGIN");
    try {
      const updateGroups = reassignment
        ? reassignment.groups
        : [{ scorer: null, taskIds }];
      let processed = 0;
      for (const group of updateGroups) {
        for (const ids of chunk(group.taskIds)) {
          changed += await updateRolledBackTasks(ids, {
            assignee: group.scorer,
            now,
            adminName,
          });
          processed += ids.length;
          onProgress?.({
            stage: reassignment ? "正在回退并分配承接人" : "正在回退任务",
            progress: 20 + (taskIds.length ? Math.round((processed / taskIds.length) * 65) : 65),
          });
        }
      }

      onProgress?.({ stage: "正在更新项目状态", progress: 88 });
      if (changed !== taskIds.length) {
        throw httpError(409, "部分任务状态已变化，请重新预览后再回退");
      }

      for (const ids of chunk(projectIds)) {
        await db.prepare(
          `UPDATE projects
           SET taskStatus = 'scoring', updatedAt = ?
           WHERE id IN (${placeholders(ids.length)})`,
        ).run(now, ...ids);
      }

      await db.exec("COMMIT");
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {}
      throw error;
    }

    if (!changed) throw httpError(409, "任务状态已变化，请重新预览后再回退");
    invalidateSummaryCache();
    onTasksChanged?.();
    return {
      ...rollbackPreviewDto(analysis, {
        includeTaskIds: analysis.source !== "scorer_full",
        assignees: reassignment?.assignees || [],
      }),
      rolledBackTaskCount: changed,
      reassignedTaskCount: reassignment ? changed : 0,
      rolledBackAt: now,
      rolledBackBy: adminName,
    };
  }

  function rollbackJobDto(job) {
    const dto = {
      jobId: job.jobId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: job.message || null,
      requestedTaskCount: job.requestedTaskCount,
      uniqueTaskCount: job.uniqueTaskCount,
    };
    if (job.result) dto.result = job.result;
    return dto;
  }

  function rollbackJobKey(taskIds) {
    return [...taskIds].sort().join("\u0000");
  }

  function rollbackJobKeyFromPayload(payload = {}) {
    if (rollbackSource(payload) !== "scorer_full") {
      const extracted = extractTaskIds(payload, httpError);
      return {
        key: rollbackJobKey(extracted.taskIds),
        requestedTaskCount: extracted.rawTaskCount,
        uniqueTaskCount: extracted.taskIds.length,
      };
    }

    const sourceScorers = normalizeScorerNameList(
      payload.scorers ?? payload.sourceScorers,
      "回退打分人",
      httpError,
    );
    const mode = scorerFullRollbackMode(payload);
    const allocations = mode === "reassign"
      ? parseRollbackAssigneeAllocations(
        reassignmentAllocationInput(payload),
        httpError,
      )
      : [];
    return {
      key: JSON.stringify({
        source: "scorer_full",
        mode,
        sourceScorers: [...sourceScorers].sort(),
        projectId: String(payload.projectId ?? "").trim(),
        submissionMode: String(payload.submissionMode ?? "").trim(),
        allocations: allocations
          .map((allocation) => ({
            scorer: allocation.scorer,
            taskCount: allocation.taskCount,
          }))
          .sort((left, right) => left.scorer.localeCompare(right.scorer, "zh-CN")),
      }),
      requestedTaskCount: 0,
      uniqueTaskCount: 0,
    };
  }

  function startRollbackJob(payload = {}, admin = {}) {
    const jobMeta = rollbackJobKeyFromPayload(payload);
    const key = jobMeta.key;
    const activeJobId = activeRollbackJobsByKey.get(key);
    if (activeJobId) {
      const activeJob = rollbackJobs.get(activeJobId);
      if (activeJob && ["queued", "running"].includes(activeJob.status)) {
        return activeJob;
      }
      activeRollbackJobsByKey.delete(key);
    }

    const job = {
      jobId: crypto.randomUUID(),
      status: "queued",
      stage: "等待回退任务",
      progress: 0,
      message: null,
      result: null,
      requestedTaskCount: jobMeta.requestedTaskCount,
      uniqueTaskCount: jobMeta.uniqueTaskCount,
    };
    rollbackJobs.set(job.jobId, job);
    activeRollbackJobsByKey.set(key, job.jobId);

    setImmediate(async () => {
      job.status = "running";
      job.stage = "正在准备回退任务";
      job.progress = 3;
      try {
        const run = async () => await rollbackScoringTasks(payload, admin, ({ stage, progress }) => {
          job.stage = stage;
          job.progress = Math.max(0, Math.min(99, progress));
        });
        job.result = withDatabaseContext
          ? await withDatabaseContext(run)
          : await run();
        job.requestedTaskCount = job.result.requestedTaskCount;
        job.uniqueTaskCount = job.result.uniqueTaskCount;
        job.status = "completed";
        job.stage = "任务回退完成";
        job.progress = 100;
      } catch (error) {
        job.status = "failed";
        job.stage = "任务回退失败";
        job.message = error?.message || "任务回退失败，请重试";
        console.error(`Scoring rollback failed (${job.jobId})`, error);
      } finally {
        activeRollbackJobsByKey.delete(key);
        setTimeout(() => rollbackJobs.delete(job.jobId), 24 * 60 * 60 * 1000).unref();
      }
    });

    return job;
  }

  function getRollbackJob(jobId) {
    return rollbackJobs.get(jobId) || null;
  }

  return {
    listScoringSummary,
    listScoringTaskRecords,
    listScoringOptions,
    writeScoringOperationsExport,
    invalidateSummaryCache,
    previewRollback,
    rollbackScoringTasks,
    startRollbackJob,
    getRollbackJob,
    rollbackJobDto,
  };
}
