import crypto from "node:crypto";
import { once } from "node:events";
import type { Writable } from "node:stream";
import type { db as database } from "../postgres.ts";

type Query = Record<string, unknown>;
type Row = Record<string, unknown>;
type HttpError = (status: number, message: string) => Error;
type Progress = (value: { stage: string; progress: number }) => void;
type Allocation = { scorer: string; taskCount: number };
type RollbackTaskRow = Row & {
  id: string; subjectId: string; projectId: string | null;
  taskVersion: string; status: string; scorer: string;
};
type RollbackAnalysis = {
  source: "task_ids" | "scorer_full"; rawTaskCount: number;
  duplicateTaskCount: number; taskIds: string[];
  matchedRows: RollbackTaskRow[]; rollbackRows: RollbackTaskRow[];
  ignoredRows: RollbackTaskRow[]; missingTaskIds: string[];
  sourceScorers: string[]; projectId: string | null; submissionMode: string | null;
};
type RollbackResult = { requestedTaskCount: number; uniqueTaskCount: number; [key: string]: unknown };
type TaskFilter = {
  where: string; params: unknown[]; scorer: string | null; projectId: string | null;
  submissionMode: string | null; minDurationMs: number | null;
  maxDurationMs: number | null; riskFilter: string | null;
};
type SummaryTotals = {
  scorerCount: number; totalTaskCount: number; undraggedSubmitCount: number;
  rankedSubmitCount: number; untrackedSubmitCount: number;
  largeImageOpenedCount: number; highRiskCount: number;
  fastSubmitCount: number; noLargeImageCount: number;
  orderUnchangedCount: number; riskScoreTotal: number;
  behaviorTrackedCount: number; pageBlurCountTotal: number;
};
type RollbackJob = {
  jobId: string; status: string; stage: string; progress: number;
  message: string | null; result: RollbackResult | null;
  requestedTaskCount: number; uniqueTaskCount: number;
};
type Statement = ReturnType<typeof database.prepare>;
type ServiceDependencies = {
  db: typeof database; taskVersion: string; httpError: HttpError; nowIso: () => string;
  parseProjectId: (value: unknown) => Promise<string>;
  parseTaskPagination: (query: Query) => { page: number; pageSize: number };
  selectScorerByUsernameStmt: Statement;
  assertScorerAssignable: (scorer: Row, name: string) => Promise<unknown>;
  withDatabaseContext: <T>(task: () => Promise<T>) => Promise<T>;
  onTasksChanged: () => void;
  recordTaskStatsEvents: (events: Array<Record<string, unknown>>) => Promise<void>;
};

function asRecord(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function placeholders(length: number) {
  return Array.from({ length }, () => "?").join(", ");
}
function chunk<T>(items: T[], size = 400): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function criterionFromTaskType(taskType: unknown) {
  return String(taskType || "").split(":")[1] || null;
}

function reportRate(count: number, total: number) {
  return total ? count / total : 0;
}

function parseRiskFlags(value: unknown) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((item) => String(item ?? "").trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

async function writeResponseChunk(stream: Writable, chunk: string) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

async function endResponseStream(stream: Writable, chunk = "") {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
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

function exportProgress(onProgress: Progress | undefined, stage: string, progress: number) {
  onProgress?.({
    stage,
    progress: Math.max(0, Math.min(99, Math.round(progress))),
  });
}

function parseOptionalScorer(value: unknown, httpError: HttpError) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (text.length > 100) throw httpError(400, "打分人不能超过 100 字");
  return text;
}

function parseOptionalSubmissionMode(value: unknown, httpError: HttpError) {
  const mode = String(value ?? "").trim();
  if (!mode) return null;
  if (!["direct", "ranked", "untracked"].includes(mode)) {
    throw httpError(400, "提交方式筛选不正确");
  }
  return mode;
}

function parseTaskCursor(value: unknown, httpError: HttpError) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw httpError(400, "任务分页游标格式不正确");
  }
  const completedAt = String(asRecord(parsed).completedAt ?? "");
  const id = String(asRecord(parsed).id ?? "");
  if (!completedAt || !id) throw httpError(400, "任务分页游标格式不正确");
  return { completedAt, id };
}

function includeTaskTotal(query: Query = {}) {
  return ["1", "true", "yes"].includes(
    String(query.includeTotal ?? "").toLowerCase(),
  );
}

function parseDurationSeconds(value: unknown, label: string, httpError: HttpError) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw httpError(400, `${label}不正确`);
  }
  return Math.round(seconds * 1000);
}

function taskIdFromPayloadItem(item: unknown) {
  if (typeof item === "string" || typeof item === "number") return item;
  if (!item || typeof item !== "object") return null;
  const row = asRecord(item);
  return row.id ?? row.taskId ?? row._id ?? null;
}

function extractTaskIds(payload: unknown, httpError: HttpError) {
  const data = asRecord(payload);
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(data.taskIds)
      ? data.taskIds
      : Array.isArray(data.ids)
        ? data.ids
        : Array.isArray(data.tasks)
          ? data.tasks
          : Array.isArray(data.rows)
            ? data.rows
            : [];

  const rawIds = source
    .map(taskIdFromPayloadItem)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (!rawIds.length) throw httpError(400, "JSON 中未找到可回退的任务 ID");
  if (rawIds.length > 10000) throw httpError(400, "一次最多回退 10000 个任务");

  const seen = new Set<string>();
  const taskIds: string[] = [];
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

function normalizeScorerNameList(value: unknown, label: string, httpError: HttpError) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const names: string[] = [];
  const seen = new Set<string>();
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

function rollbackSource(payload: Query = {}) {
  return payload?.source === "scorer_full" ? "scorer_full" : "task_ids";
}

function scorerFullRollbackMode(payload: Query = {}) {
  const mode = String(
    payload.returnMode ?? payload.rollbackMode ?? payload.reassignmentMode ?? "",
  ).trim();
  if (payload.returnToSource === true || mode === "original" || mode === "return_original") {
    return "original";
  }
  return "reassign";
}

function reassignmentAllocationInput(payload: Query = {}) {
  return asRecord(payload.reassignment).allocations ?? payload.allocations ?? payload.assignees;
}

function parseRollbackAssigneeAllocations(value: unknown, httpError: HttpError) {
  if (!Array.isArray(value)) throw httpError(400, "请设置承接人和承接数量");
  const allocations: Allocation[] = [];
  const seen = new Set<string>();
  value.forEach((item) => {
    const row = asRecord(item);
    const scorer = String(row.scorer ?? row.username ?? row.name ?? "").trim();
    const taskCount = Math.floor(Number(row.taskCount ?? row.count ?? 0));
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

function randomShuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const selectedIndex = crypto.randomInt(0, index + 1);
    [shuffled[index], shuffled[selectedIndex]] = [shuffled[selectedIndex], shuffled[index]];
  }
  return shuffled;
}

function groupTaskIdsByAssignee(rows: Array<{ id: string }>, allocations: Allocation[]) {
  const shuffledTaskIds = randomShuffle(rows.map((row) => row.id));
  const groups: Array<{ scorer: string; taskIds: string[] }> = [];
  let offset = 0;
  allocations.forEach((allocation) => {
    const taskIds = shuffledTaskIds.slice(offset, offset + allocation.taskCount);
    offset += allocation.taskCount;
    groups.push({ scorer: allocation.scorer, taskIds });
  });
  return groups;
}

function taskRecordDto(row: Row) {
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
    dragActionCount: Number(row.dragActionCount || 0),
    orderChanged: Boolean(row.orderChanged),
    largeImageOpened: Boolean(row.largeImageOpened),
    largeImageOpenCount: Number(row.largeImageOpenCount || 0),
    behaviorTracked: Boolean(row.behaviorTracked),
    isBacktest: Boolean(row.isBacktest),
    backtestSourceTaskId: row.backtestSourceId || null,
    durationMs,
    durationSeconds: durationMs == null ? null : durationMs / 1000,
    firstActionMs: row.firstActionMs == null ? null : Number(row.firstActionMs),
    firstActionSeconds: row.firstActionMs == null ? null : Number(row.firstActionMs) / 1000,
    pageBlurCount: Number(row.pageBlurCount || 0),
    riskScore: Number(row.riskScore || 0),
    riskFlags: parseRiskFlags(row.riskFlags),
    completedAt: row.completedAt ?? null,
    editedAt: row.editedAt ?? null,
    editCount: Number(row.editCount || 0),
    rollbackCount: Number(row.rollbackCount || 0),
    updatedAt: row.updatedAt,
  };
}

function groupRollbackRows(rows: Row[], key: string, nameKey: string) {
  const map = new Map<string, { id: string; name: string; taskCount: number }>();
  rows.forEach((row) => {
    const id = String(row[key] || "unknown");
    const item = map.get(id) || {
      id,
      name: String(row[nameKey] || id),
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
  recordTaskStatsEvents,
}: ServiceDependencies) {
  const rollbackJobs = new Map<string, RollbackJob>();
  const activeRollbackJobsByKey = new Map<string, string>();
  const summaryCache = new Map<string, { value: Awaited<ReturnType<typeof calculateScoringSummary>>; expiresAt: number }>();
  const summaryInFlight = new Map<string, ReturnType<typeof calculateScoringSummary>>();
  const summaryCacheTtlMs = 15 * 1000;

  async function buildSummaryFilter(query: Query = {}) {
    const clauses = [
      "rating_tasks.taskVersion = ?",
      "rating_tasks.status = 'completed'",
      "rating_tasks.scorer IS NOT NULL",
      "TRIM(rating_tasks.scorer) <> ''",
    ];
    const params: unknown[] = [taskVersion];
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

  async function buildTaskFilter(query: Query = {}) {
    const filter = await buildSummaryFilter(query);
    const clauses = [filter.where.replace(/^WHERE\s+/i, "")];
    const params = [...filter.params];
    const submissionMode = parseOptionalSubmissionMode(query.submissionMode, httpError);
    const minDurationMs = parseDurationSeconds(query.minDurationSeconds, "最短打分时长", httpError);
    const maxDurationMs = parseDurationSeconds(query.maxDurationSeconds, "最长打分时长", httpError);
    const riskFilter = String(query.riskFilter ?? "").trim();
    if (riskFilter && !["high", "fast", "no_large_image", "no_order_change", "page_blur"].includes(riskFilter)) {
      throw httpError(400, "行为风险筛选不正确");
    }

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
    if (riskFilter) clauses.push("rating_tasks.behaviorTracked = true");
    if (riskFilter === "high") clauses.push("rating_tasks.riskScore >= 60");
    if (riskFilter === "fast") clauses.push("rating_tasks.durationMs >= 0 AND rating_tasks.durationMs < 3000");
    if (riskFilter === "no_large_image") clauses.push("rating_tasks.largeImageOpened = false");
    if (riskFilter === "no_order_change") clauses.push("rating_tasks.orderChanged = false AND rating_tasks.dragActionCount = 0");
    if (riskFilter === "page_blur") clauses.push("rating_tasks.pageBlurCount >= 3");
    return {
      where: `WHERE ${clauses.join(" AND ")}`,
      params,
      scorer: filter.scorer,
      projectId: filter.projectId,
      submissionMode,
      minDurationMs,
      maxDurationMs,
      riskFilter: riskFilter || null,
    };
  }

  function summaryResultFromRows(rows: Row[], totalsRow: Row, page: number, pageSize: number) {
    const totals = {
      scorerCount: Number(totalsRow?.scorerCount || 0),
      totalTaskCount: Number(totalsRow?.totalTaskCount || 0),
      undraggedSubmitCount: Number(totalsRow?.undraggedSubmitCount || 0),
      rankedSubmitCount: Number(totalsRow?.rankedSubmitCount || 0),
      untrackedSubmitCount: Number(totalsRow?.untrackedSubmitCount || 0),
      largeImageOpenedCount: Number(totalsRow?.largeImageOpenedCount || 0),
      highRiskCount: Number(totalsRow?.highRiskCount || 0),
      fastSubmitCount: Number(totalsRow?.fastSubmitCount || 0),
      noLargeImageCount: Number(totalsRow?.noLargeImageCount || 0),
      orderUnchangedCount: Number(totalsRow?.orderUnchangedCount || 0),
      behaviorTrackedCount: Number(totalsRow?.behaviorTrackedCount || 0),
      riskScoreTotal: Number(totalsRow?.riskScoreTotal || 0),
    };
    return {
      ...totals,
      directSubmitCount: totals.undraggedSubmitCount,
      page,
      pageSize,
      directSubmitRate: reportRate(totals.undraggedSubmitCount, totals.totalTaskCount),
      undraggedSubmitRate: reportRate(totals.undraggedSubmitCount, totals.totalTaskCount),
      largeImageOpenedRate: reportRate(totals.largeImageOpenedCount, totals.totalTaskCount),
      highRiskRate: reportRate(totals.highRiskCount, totals.behaviorTrackedCount),
      fastSubmitRate: reportRate(totals.fastSubmitCount, totals.behaviorTrackedCount),
      noLargeImageRate: reportRate(totals.noLargeImageCount, totals.behaviorTrackedCount),
      orderUnchangedRate: reportRate(totals.orderUnchangedCount, totals.behaviorTrackedCount),
      pageBlurCountTotal: Number(totalsRow?.pageBlurCountTotal || 0),
      averageRiskScore: totals.behaviorTrackedCount ? totals.riskScoreTotal / totals.behaviorTrackedCount : 0,
      maxRiskScore: rows.reduce((max, row) => Math.max(max, Number(row.maxRiskScore || 0)), 0),
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
        const highRiskCount = Number(row.highRiskCount || 0);
        const fastSubmitCount = Number(row.fastSubmitCount || 0);
        const noLargeImageCount = Number(row.noLargeImageCount || 0);
        const orderUnchangedCount = Number(row.orderUnchangedCount || 0);
        const behaviorTrackedCount = Number(row.behaviorTrackedCount || 0);
        const riskScoreTotal = Number(row.riskScoreTotal || 0);
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
          highRiskCount,
          highRiskRate: reportRate(highRiskCount, behaviorTrackedCount),
          fastSubmitCount,
          fastSubmitRate: reportRate(fastSubmitCount, behaviorTrackedCount),
          noLargeImageCount,
          noLargeImageRate: reportRate(noLargeImageCount, behaviorTrackedCount),
          orderUnchangedCount,
          orderUnchangedRate: reportRate(orderUnchangedCount, behaviorTrackedCount),
          averageRiskScore: behaviorTrackedCount ? riskScoreTotal / behaviorTrackedCount : 0,
          behaviorTrackedCount,
          pageBlurCountTotal: Number(row.pageBlurCountTotal || 0),
          maxRiskScore: Number(row.maxRiskScore || 0),
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
    const hasTaskLevelFilter = filter.minDurationMs != null || filter.maxDurationMs != null || filter.riskFilter;
    const source = hasTaskLevelFilter ? `
      SELECT rating_tasks.scorer,
             rating_tasks.projectId,
             rating_tasks.submissionMode,
             rating_tasks.largeImageOpened,
             rating_tasks.orderChanged,
             rating_tasks.behaviorTracked,
             rating_tasks.riskScore,
             rating_tasks.pageBlurCount,
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
             trackedlargeimageopenedcount,
             orderchangedcount,
             fastsubmitcount,
             highriskcount,
             behaviortrackedcount,
             riskscoretotal,
             riskscoremax,
             pageblurcounttotal,
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
    const sourceParams = hasTaskLevelFilter
      ? filter.params
      : (() => {
        const values = [taskVersion];
        if (filter.scorer) values.push(filter.scorer);
        if (filter.projectId) values.push(filter.projectId);
        if (filter.submissionMode) values.push(filter.submissionMode);
        return values;
      })();
    const groupedSelect = hasTaskLevelFilter ? `
      COUNT(*) AS totalTaskCount,
      COUNT(DISTINCT projectId) AS projectCount,
      SUM(CASE WHEN submissionMode = 'direct' THEN 1 ELSE 0 END) AS undraggedSubmitCount,
      SUM(CASE WHEN submissionMode = 'ranked' THEN 1 ELSE 0 END) AS rankedSubmitCount,
      SUM(CASE WHEN submissionMode IS NULL THEN 1 ELSE 0 END) AS untrackedSubmitCount,
      SUM(CASE WHEN largeImageOpened THEN 1 ELSE 0 END) AS largeImageOpenedCount,
      SUM(CASE WHEN COALESCE(behaviorTracked, false) AND COALESCE(orderChanged, false) = false THEN 1 ELSE 0 END) AS orderUnchangedCount,
      SUM(CASE WHEN COALESCE(behaviorTracked, false) AND COALESCE(riskScore, 0) >= 60 THEN 1 ELSE 0 END) AS highRiskCount,
      SUM(CASE WHEN COALESCE(behaviorTracked, false) AND durationMs >= 0 AND durationMs < 3000 THEN 1 ELSE 0 END) AS fastSubmitCount,
      SUM(CASE WHEN COALESCE(behaviorTracked, false) AND largeImageOpened = false THEN 1 ELSE 0 END) AS noLargeImageCount,
      SUM(CASE WHEN COALESCE(behaviorTracked, false) THEN 1 ELSE 0 END) AS behaviorTrackedCount,
      SUM(CASE WHEN COALESCE(behaviorTracked, false) THEN COALESCE(riskScore, 0) ELSE 0 END) AS riskScoreTotal,
      MAX(CASE WHEN COALESCE(behaviorTracked, false) THEN COALESCE(riskScore, 0) ELSE 0 END) AS maxRiskScore,
      SUM(CASE WHEN COALESCE(behaviorTracked, false) THEN COALESCE(pageBlurCount, 0) ELSE 0 END) AS pageBlurCountTotal,
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
      SUM(behaviortrackedcount - orderchangedcount) AS orderUnchangedCount,
      SUM(highriskcount) AS highRiskCount,
      SUM(fastsubmitcount) AS fastSubmitCount,
      SUM(behaviortrackedcount - trackedlargeimageopenedcount) AS noLargeImageCount,
      SUM(behaviortrackedcount) AS behaviorTrackedCount,
      SUM(riskscoretotal) AS riskScoreTotal,
      MAX(riskscoremax) AS maxRiskScore,
      SUM(pageblurcounttotal) AS pageBlurCountTotal,
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
    const totalsRow = rows.reduce<SummaryTotals>((totals, row) => ({
      scorerCount: totals.scorerCount + 1,
      totalTaskCount: totals.totalTaskCount + Number(row.totalTaskCount || 0),
      undraggedSubmitCount: totals.undraggedSubmitCount + Number(row.undraggedSubmitCount || 0),
      rankedSubmitCount: totals.rankedSubmitCount + Number(row.rankedSubmitCount || 0),
      untrackedSubmitCount: totals.untrackedSubmitCount + Number(row.untrackedSubmitCount || 0),
      largeImageOpenedCount: totals.largeImageOpenedCount + Number(row.largeImageOpenedCount || 0),
      highRiskCount: totals.highRiskCount + Number(row.highRiskCount || 0),
      fastSubmitCount: totals.fastSubmitCount + Number(row.fastSubmitCount || 0),
      noLargeImageCount: totals.noLargeImageCount + Number(row.noLargeImageCount || 0),
      orderUnchangedCount: totals.orderUnchangedCount + Number(row.orderUnchangedCount || 0),
      riskScoreTotal: totals.riskScoreTotal + Number(row.riskScoreTotal || 0),
      behaviorTrackedCount: totals.behaviorTrackedCount + Number(row.behaviorTrackedCount || 0),
      pageBlurCountTotal: totals.pageBlurCountTotal + Number(row.pageBlurCountTotal || 0),
    }), {
      scorerCount: 0,
      totalTaskCount: 0,
      undraggedSubmitCount: 0,
      rankedSubmitCount: 0,
      untrackedSubmitCount: 0,
      largeImageOpenedCount: 0,
      highRiskCount: 0,
      fastSubmitCount: 0,
      noLargeImageCount: 0,
      orderUnchangedCount: 0,
      riskScoreTotal: 0,
      behaviorTrackedCount: 0,
      pageBlurCountTotal: 0,
    });
    return summaryResultFromRows(rows.slice((page - 1) * pageSize, page * pageSize), totalsRow, page, pageSize);
  }

  async function listScoringSummary(query: Query = {}) {
    const key = JSON.stringify({
      page: query.page || 1,
      pageSize: query.pageSize || 10,
      scorer: query.scorer || null,
      projectId: query.projectId || null,
      submissionMode: query.submissionMode || null,
      riskFilter: query.riskFilter || null,
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

  async function listScoringTaskRecords(query: Query = {}) {
    const { page, pageSize } = parseTaskPagination(query);
    const filter = await buildTaskFilter(query);
    const cursor = parseTaskCursor(query.cursor, httpError);
    const hasTaskLevelFilter = filter.minDurationMs != null || filter.maxDurationMs != null || filter.riskFilter;
    let total = null;
    if (includeTaskTotal(query)) {
      if (hasTaskLevelFilter) {
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
                rating_tasks.submissionMode, rating_tasks.rankingActionCount, rating_tasks.dragActionCount,
                rating_tasks.orderChanged, rating_tasks.largeImageOpened, rating_tasks.largeImageOpenCount,
                rating_tasks.behaviorTracked,
                rating_tasks.isBacktest, rating_tasks.backtestSourceId,
                rating_tasks.durationMs, rating_tasks.firstActionMs, rating_tasks.pageBlurCount,
                rating_tasks.riskScore, rating_tasks.riskFlags,
                rating_tasks.completedAt, rating_tasks.editedAt,
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

  function scoringStatsFilter(filter: TaskFilter) {
    const clauses = ["taskVersion = ?"];
    const params: unknown[] = [taskVersion];
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

  async function scoringOperationExportSummary(filter: TaskFilter) {
    const hasTaskLevelFilter = filter.minDurationMs != null || filter.maxDurationMs != null || filter.riskFilter;
    if (!hasTaskLevelFilter) {
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

  async function writeScoringOperationsExport(stream: Writable, query: Query = {}, onProgress?: Progress) {
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
        riskFilter: filter.riskFilter,
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
               rating_tasks.submissionMode, rating_tasks.rankingActionCount, rating_tasks.dragActionCount,
               rating_tasks.orderChanged, rating_tasks.largeImageOpened, rating_tasks.largeImageOpenCount,
               rating_tasks.behaviorTracked,
               rating_tasks.isBacktest, rating_tasks.backtestSourceId,
               rating_tasks.durationMs, rating_tasks.firstActionMs, rating_tasks.pageBlurCount,
               rating_tasks.riskScore, rating_tasks.riskFlags,
               rating_tasks.completedAt, rating_tasks.editedAt,
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

  async function buildScoringRiskReportFilter(query: Query = {}) {
    const scorers = normalizeScorerNameList(query.scorers, "打分人", httpError);
    const projectId = query.projectId ? await parseProjectId(query.projectId) : null;
    const submissionMode = parseOptionalSubmissionMode(query.submissionMode, httpError);
    const clauses = [
      "rating_tasks.taskVersion = ?",
      "rating_tasks.status = 'completed'",
      "rating_tasks.scorer = ?",
    ];
    if (projectId) {
      clauses.push("rating_tasks.projectId = ?");
    }
    if (submissionMode === "untracked") {
      clauses.push("rating_tasks.submissionMode IS NULL");
    } else if (submissionMode) {
      clauses.push("rating_tasks.submissionMode = ?");
    }

    return {
      scorers,
      projectId,
      submissionMode,
      where: `WHERE ${clauses.join(" AND ")}`,
      paramsForScorer(scorer: string) {
        return [taskVersion, scorer, ...(projectId ? [projectId] : []), ...(submissionMode && submissionMode !== "untracked" ? [submissionMode] : [])];
      },
    };
  }

  function scoringRiskReportSummary(row: Row | undefined) {
    const completedTaskCount = Number(row?.completedTaskCount || 0);
    const behaviorTrackedTaskCount = Number(row?.behaviorTrackedTaskCount || 0);
    const riskScoreTotal = Number(row?.riskScoreTotal || 0);
    const durationCount = Number(row?.durationCount || 0);
    const firstActionCount = Number(row?.firstActionCount || 0);
    return {
      completedTaskCount,
      behaviorTrackedTaskCount,
      behaviorUntrackedTaskCount: completedTaskCount - behaviorTrackedTaskCount,
      projectCount: Number(row?.projectCount || 0),
      directSubmitCount: Number(row?.directSubmitCount || 0),
      rankedSubmitCount: Number(row?.rankedSubmitCount || 0),
      untrackedSubmitCount: Number(row?.untrackedSubmitCount || 0),
      largeImageOpenedTaskCount: Number(row?.largeImageOpenedTaskCount || 0),
      largeImageOpenCountTotal: Number(row?.largeImageOpenCountTotal || 0),
      dragActionCountTotal: Number(row?.dragActionCountTotal || 0),
      orderChangedTaskCount: Number(row?.orderChangedTaskCount || 0),
      pageBlurCountTotal: Number(row?.pageBlurCountTotal || 0),
      averageDurationSeconds: durationCount ? Number(row?.durationTotal || 0) / durationCount / 1000 : null,
      averageFirstActionSeconds: firstActionCount ? Number(row?.firstActionTotal || 0) / firstActionCount / 1000 : null,
      averageRiskScore: behaviorTrackedTaskCount ? riskScoreTotal / behaviorTrackedTaskCount : 0,
      maxRiskScore: Number(row?.maxRiskScore || 0),
      highRiskTaskCount: Number(row?.highRiskTaskCount || 0),
      fastSubmitTaskCount: Number(row?.fastSubmitTaskCount || 0),
      noLargeImageTaskCount: Number(row?.noLargeImageTaskCount || 0),
      noOrderChangeTaskCount: Number(row?.noOrderChangeTaskCount || 0),
      lateFirstActionTaskCount: Number(row?.lateFirstActionTaskCount || 0),
      frequentPageBlurTaskCount: Number(row?.frequentPageBlurTaskCount || 0),
      riskScoreTotal,
    };
  }

  function addScoringRiskReportTotals(totals: Record<string, number>, summary: ReturnType<typeof scoringRiskReportSummary>) {
    [
      "completedTaskCount",
      "behaviorTrackedTaskCount",
      "behaviorUntrackedTaskCount",
      "directSubmitCount",
      "rankedSubmitCount",
      "untrackedSubmitCount",
      "largeImageOpenedTaskCount",
      "largeImageOpenCountTotal",
      "dragActionCountTotal",
      "orderChangedTaskCount",
      "pageBlurCountTotal",
      "highRiskTaskCount",
      "fastSubmitTaskCount",
      "noLargeImageTaskCount",
      "noOrderChangeTaskCount",
      "lateFirstActionTaskCount",
      "frequentPageBlurTaskCount",
      "riskScoreTotal",
    ].forEach((key) => {
      totals[key] += Number((summary as Row)[key] || 0);
    });
    totals.maxRiskScore = Math.max(totals.maxRiskScore, Number(summary.maxRiskScore || 0));
  }

  async function writeScoringRiskTaskIds(stream: Writable, filter: Awaited<ReturnType<typeof buildScoringRiskReportFilter>>, scorer: string, condition: string) {
    const batchSize = 1000;
    let written = 0;
    let lastId = null;
    await writeResponseChunk(stream, "[");
    while (true) {
      const rows = await db.prepare(`
        SELECT rating_tasks.id
        FROM rating_tasks
        ${filter.where}
          AND rating_tasks.behaviorTracked = true
          AND (${condition})
          AND (?::text IS NULL OR rating_tasks.id > ?)
        ORDER BY rating_tasks.id ASC
        LIMIT ?
      `).all(...filter.paramsForScorer(scorer), lastId, lastId, batchSize);
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;
      await writeResponseChunk(
        stream,
        rows.map((row) => `${written++ ? "," : ""}${JSON.stringify(row.id)}`).join(""),
      );
    }
    await writeResponseChunk(stream, "]");
    return written;
  }

  async function writeScoringRiskReport(stream: Writable, query: Query = {}, onProgress?: Progress) {
    exportProgress(onProgress, "正在准备风险报告", 3);
    const filter = await buildScoringRiskReportFilter(query);
    const totals = {
      scorerCount: filter.scorers.length,
      completedTaskCount: 0,
      behaviorTrackedTaskCount: 0,
      behaviorUntrackedTaskCount: 0,
      directSubmitCount: 0,
      rankedSubmitCount: 0,
      untrackedSubmitCount: 0,
      largeImageOpenedTaskCount: 0,
      largeImageOpenCountTotal: 0,
      dragActionCountTotal: 0,
      orderChangedTaskCount: 0,
      pageBlurCountTotal: 0,
      highRiskTaskCount: 0,
      fastSubmitTaskCount: 0,
      noLargeImageTaskCount: 0,
      noOrderChangeTaskCount: 0,
      lateFirstActionTaskCount: 0,
      frequentPageBlurTaskCount: 0,
      riskScoreTotal: 0,
      maxRiskScore: 0,
    };
    const violations = [
      {
        key: "highRiskTaskIds",
        condition: "COALESCE(rating_tasks.riskScore, 0) >= 60",
      },
      {
        key: "fastSubmitTaskIds",
        condition: "rating_tasks.durationMs >= 0 AND rating_tasks.durationMs < 3000",
      },
      {
        key: "noLargeImageTaskIds",
        condition: "COALESCE(rating_tasks.largeImageOpened, false) = false AND COALESCE(rating_tasks.largeImageOpenCount, 0) <= 0",
      },
      {
        key: "noOrderChangeTaskIds",
        condition: "COALESCE(rating_tasks.orderChanged, false) = false AND COALESCE(rating_tasks.rankingActionCount, 0) <= 0 AND COALESCE(rating_tasks.dragActionCount, 0) <= 0",
      },
      {
        key: "lateFirstActionTaskIds",
        condition: "rating_tasks.firstActionMs IS NULL OR (rating_tasks.durationMs >= 1000 AND rating_tasks.firstActionMs > rating_tasks.durationMs * 0.8)",
      },
      {
        key: "frequentPageBlurTaskIds",
        condition: "COALESCE(rating_tasks.pageBlurCount, 0) >= 3",
      },
    ];

    const header = {
      exportedAt: nowIso(),
      taskVersion,
      filters: {
        scorers: filter.scorers,
        projectId: filter.projectId,
        submissionMode: filter.submissionMode,
      },
      riskRules: {
        highRiskScore: 60,
        fastSubmitDurationMs: 3000,
        frequentPageBlurCount: 3,
      },
      violationDefinitions: {
        highRiskTaskIds: "风险分不低于 60",
        fastSubmitTaskIds: "提交用时少于 3 秒",
        noLargeImageTaskIds: "未打开大图",
        noOrderChangeTaskIds: "未发生排序变化",
        lateFirstActionTaskIds: "首次操作缺失或发生在打分时长后 20% 区间",
        frequentPageBlurTaskIds: "页面失焦至少 3 次",
      },
    };
    await writeResponseChunk(stream, `${JSON.stringify(header).slice(0, -1)},"scorerReports":[`);

    for (let scorerIndex = 0; scorerIndex < filter.scorers.length; scorerIndex += 1) {
      const scorer = filter.scorers[scorerIndex];
      exportProgress(
        onProgress,
        `正在汇总 ${scorer} 的风险行为`,
        5 + (scorerIndex / filter.scorers.length) * 90,
      );
      const row = await db.prepare(`
        SELECT COUNT(*) AS "completedTaskCount",
               COUNT(DISTINCT rating_tasks.projectId) AS "projectCount",
               SUM(CASE WHEN rating_tasks.submissionMode = 'direct' THEN 1 ELSE 0 END) AS "directSubmitCount",
               SUM(CASE WHEN rating_tasks.submissionMode = 'ranked' THEN 1 ELSE 0 END) AS "rankedSubmitCount",
               SUM(CASE WHEN rating_tasks.submissionMode IS NULL THEN 1 ELSE 0 END) AS "untrackedSubmitCount",
               SUM(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) THEN 1 ELSE 0 END) AS "behaviorTrackedTaskCount",
               SUM(CASE WHEN rating_tasks.largeImageOpened THEN 1 ELSE 0 END) AS "largeImageOpenedTaskCount",
               SUM(COALESCE(rating_tasks.largeImageOpenCount, 0)) AS "largeImageOpenCountTotal",
               SUM(COALESCE(rating_tasks.dragActionCount, 0)) AS "dragActionCountTotal",
               SUM(CASE WHEN COALESCE(rating_tasks.orderChanged, false) THEN 1 ELSE 0 END) AS "orderChangedTaskCount",
               SUM(COALESCE(rating_tasks.pageBlurCount, 0)) AS "pageBlurCountTotal",
               SUM(CASE WHEN rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs ELSE 0 END) AS "durationTotal",
               SUM(CASE WHEN rating_tasks.durationMs >= 0 THEN 1 ELSE 0 END) AS "durationCount",
               SUM(CASE WHEN rating_tasks.firstActionMs >= 0 THEN rating_tasks.firstActionMs ELSE 0 END) AS "firstActionTotal",
               SUM(CASE WHEN rating_tasks.firstActionMs >= 0 THEN 1 ELSE 0 END) AS "firstActionCount",
               SUM(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) THEN COALESCE(rating_tasks.riskScore, 0) ELSE 0 END) AS "riskScoreTotal",
               MAX(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) THEN COALESCE(rating_tasks.riskScore, 0) ELSE 0 END) AS "maxRiskScore",
               SUM(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) AND COALESCE(rating_tasks.riskScore, 0) >= 60 THEN 1 ELSE 0 END) AS "highRiskTaskCount",
               SUM(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) AND rating_tasks.durationMs >= 0 AND rating_tasks.durationMs < 3000 THEN 1 ELSE 0 END) AS "fastSubmitTaskCount",
               SUM(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) AND COALESCE(rating_tasks.largeImageOpened, false) = false AND COALESCE(rating_tasks.largeImageOpenCount, 0) <= 0 THEN 1 ELSE 0 END) AS "noLargeImageTaskCount",
               SUM(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) AND COALESCE(rating_tasks.orderChanged, false) = false AND COALESCE(rating_tasks.rankingActionCount, 0) <= 0 AND COALESCE(rating_tasks.dragActionCount, 0) <= 0 THEN 1 ELSE 0 END) AS "noOrderChangeTaskCount",
               SUM(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) AND (rating_tasks.firstActionMs IS NULL OR (rating_tasks.durationMs >= 1000 AND rating_tasks.firstActionMs > rating_tasks.durationMs * 0.8)) THEN 1 ELSE 0 END) AS "lateFirstActionTaskCount",
               SUM(CASE WHEN COALESCE(rating_tasks.behaviorTracked, false) AND COALESCE(rating_tasks.pageBlurCount, 0) >= 3 THEN 1 ELSE 0 END) AS "frequentPageBlurTaskCount"
        FROM rating_tasks
        ${filter.where}
      `).get(...filter.paramsForScorer(scorer));
      const behaviorSummary = scoringRiskReportSummary(row);
      addScoringRiskReportTotals(totals, behaviorSummary);

      await writeResponseChunk(
        stream,
        `${scorerIndex ? "," : ""}${JSON.stringify({ scorer, behaviorSummary }).slice(0, -1)},"violations":{`,
      );
      for (let violationIndex = 0; violationIndex < violations.length; violationIndex += 1) {
        const violation = violations[violationIndex];
        await writeResponseChunk(stream, `${violationIndex ? "," : ""}${JSON.stringify(violation.key)}:`);
        await writeScoringRiskTaskIds(stream, filter, scorer, violation.condition);
        exportProgress(
          onProgress,
          `正在写入 ${scorer} 的风险任务 ID`,
          5 + ((scorerIndex + (violationIndex + 1) / violations.length) / filter.scorers.length) * 90,
        );
      }
      await writeResponseChunk(stream, "}}");
    }

    const totalSummary = {
      ...totals,
      averageRiskScore: totals.behaviorTrackedTaskCount
        ? totals.riskScoreTotal / totals.behaviorTrackedTaskCount
        : 0,
    };
    const publicSummary = Object.fromEntries(
      Object.entries(totalSummary).filter(([key]) => key !== "riskScoreTotal"),
    );
    await endResponseStream(stream, `],"summary":${JSON.stringify(publicSummary)}}`);
    exportProgress(onProgress, "风险报告 JSON 已写入", 95);
    return publicSummary;
  }

  async function selectTasksByIds(taskIds: string[]): Promise<RollbackTaskRow[]> {
    const rows: RollbackTaskRow[] = [];
    for (const ids of chunk(taskIds)) {
      rows.push(
        ...(await db
          .prepare(
            `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
                    rating_tasks.taskVersion, rating_tasks.taskType, rating_tasks.status,
                    rating_tasks.scorer, rating_tasks.submissionMode,
                    rating_tasks.rankingActionCount, rating_tasks.dragActionCount,
                    rating_tasks.orderChanged, rating_tasks.largeImageOpened, rating_tasks.largeImageOpenCount,
                    rating_tasks.behaviorTracked,
                    rating_tasks.isBacktest, rating_tasks.backtestSourceId, rating_tasks.durationMs,
                    rating_tasks.firstActionMs, rating_tasks.pageBlurCount,
                    rating_tasks.riskScore, rating_tasks.riskFlags,
                    rating_tasks.completedAt, rating_tasks.editedAt, rating_tasks.editCount,
                    rating_tasks.rollbackCount, rating_tasks.updatedAt,
                    projects.name AS projectName
             FROM rating_tasks
             LEFT JOIN projects ON projects.id = rating_tasks.projectId
             WHERE rating_tasks.id IN (${placeholders(ids.length)})`,
          )
          .all(...ids)) as RollbackTaskRow[],
      );
    }
    const order = new Map(taskIds.map((id, index) => [id, index]));
    return rows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  }

  async function selectCompletedTasksByScorers({ scorers, projectId, submissionMode }: {
    scorers: string[]; projectId: string | null; submissionMode: string | null;
  }): Promise<RollbackTaskRow[]> {
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
             rating_tasks.rankingActionCount, rating_tasks.dragActionCount,
             rating_tasks.orderChanged, rating_tasks.largeImageOpened, rating_tasks.largeImageOpenCount,
             rating_tasks.behaviorTracked,
             rating_tasks.isBacktest, rating_tasks.backtestSourceId, rating_tasks.durationMs,
             rating_tasks.firstActionMs, rating_tasks.pageBlurCount,
             rating_tasks.riskScore, rating_tasks.riskFlags,
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
    `).all(...params) as RollbackTaskRow[];
  }

  async function analyzeTaskIdRollbackPayload(payload: Query): Promise<RollbackAnalysis> {
    const extracted = extractTaskIds(payload, httpError);
    const rows = await selectTasksByIds(extracted.taskIds);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const missingTaskIds = extracted.taskIds.filter((id) => !rowById.has(id));
    const matchedRows = extracted.taskIds
      .map((id) => rowById.get(id))
      .filter((row): row is RollbackTaskRow => Boolean(row));
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

  async function analyzeScorerRollbackPayload(payload: Query): Promise<RollbackAnalysis> {
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

  async function analyzeRollbackPayload(payload: Query): Promise<RollbackAnalysis> {
    return rollbackSource(payload) === "scorer_full"
      ? await analyzeScorerRollbackPayload(payload)
      : await analyzeTaskIdRollbackPayload(payload);
  }

  function rollbackPreviewDto(analysis: RollbackAnalysis, options: { includeTaskIds?: boolean; assignees?: Array<{ id: string; name: string; taskCount: number }> } = {}) {
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

  async function previewRollback(payload: Query = {}) {
    const analysis = await analyzeRollbackPayload(payload);
    return rollbackPreviewDto(analysis, {
      includeTaskIds: analysis.source !== "scorer_full",
    });
  }

  async function validateRollbackAssignees(payload: Query, analysis: RollbackAnalysis) {
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
      if (!user) throw httpError(400, `承接人 ${allocations[index].scorer} 不存在`);
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

  async function updateRolledBackTasks(ids: string[], { assignee, now, adminName }: {
    assignee: string | null; now: string; adminName: string;
  }) {
    const scorerAssignment = assignee ? "scorer = ?," : "";
    const params = assignee ? [assignee] : [];
    return Number((await db
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
             dragActionCount = 0,
             orderChanged = false,
             largeImageOpened = false,
             largeImageOpenCount = 0,
             startedAt = NULL,
             completedAt = NULL,
             durationMs = NULL,
             firstActionMs = NULL,
             pageBlurCount = 0,
             behaviorTracked = false,
             riskScore = 0,
             riskFlags = NULL,
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
      .run(...params, now, adminName, now, taskVersion, ...ids)).changes || 0);
  }

  async function rollbackScoringTasks(payload: Query = {}, admin: Query = {}, onProgress?: Progress) {
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
    const nextScorerByTaskId = new Map(
      analysis.rollbackRows.map((row) => [row.id, row.scorer]),
    );
    reassignment?.groups.forEach((group) => {
      group.taskIds.forEach((taskId) => nextScorerByTaskId.set(taskId, group.scorer));
    });
    let changed = 0;

    onProgress?.({
      stage: reassignment ? "正在回退并分配承接人" : "正在回退任务",
      progress: 20,
    });
    await db.exec("BEGIN");
    try {
      await db.exec("SET LOCAL app.skip_rating_task_stats = 'on'");
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
      await recordTaskStatsEvents?.(analysis.rollbackRows.map((row) => ({
        eventType: "task_rolled_back",
        oldTask: row,
        newTask: {
          ...row,
          status: "assigned",
          scorer: nextScorerByTaskId.get(row.id),
          completedAt: null,
          updatedAt: now,
        },
        applyScorerTaskStats: true,
        createdAt: now,
      })));

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

  function rollbackJobDto(job: RollbackJob) {
    const dto: Record<string, unknown> = {
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

  function rollbackJobKey(taskIds: string[]) {
    return [...taskIds].sort().join("\u0000");
  }

  function rollbackJobKeyFromPayload(payload: Query = {}) {
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

  function startRollbackJob(payload: Query = {}, admin: Query = {}) {
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

    const job: RollbackJob = {
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
        job.message = error instanceof Error ? error.message : "任务回退失败，请重试";
        console.error(`Scoring rollback failed (${job.jobId})`, error);
      } finally {
        activeRollbackJobsByKey.delete(key);
        setTimeout(() => rollbackJobs.delete(job.jobId), 24 * 60 * 60 * 1000).unref();
      }
    });

    return job;
  }

  function getRollbackJob(jobId: string) {
    return rollbackJobs.get(jobId) || null;
  }

  return {
    listScoringSummary,
    listScoringTaskRecords,
    listScoringOptions,
    writeScoringOperationsExport,
    writeScoringRiskReport,
    invalidateSummaryCache,
    previewRollback,
    rollbackScoringTasks,
    startRollbackJob,
    getRollbackJob,
    rollbackJobDto,
  };
}
