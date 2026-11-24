import type { db as database, runWithDatabaseContext as databaseContext } from "../postgres.ts";
import type { retryTaskStatsRefresh as retryRefresh } from "../task-stats-retry.ts";
import type { createTaskStatsWriteService } from "./task-stats-write.ts";

type Statement = ReturnType<typeof database.prepare>;
type StatsFns = ReturnType<typeof createTaskStatsWriteService>;
type Aggregates = ReturnType<StatsFns["aggregateTaskStatsEvents"]>;
type StatsEvent = Parameters<StatsFns["aggregateTaskStatsEvents"]>[0][number] & {
  id: string;
  eventType: string;
  projectId: string;
  oldScoringStats?: unknown;
};
type ProjectDelta = Aggregates["projectDeltas"];
type ScorerTaskDelta = Aggregates["scorerTaskDeltas"];
type ScoringDelta = Aggregates["scoringDeltas"];

export function createTaskStatsWorkerService({
  db, taskVersion, nowIso, scoringStatsAdditiveFields, aggregateTaskStatsEvents,
  getProjectTaskStats, subjectTaskReportCache, getTaskGenerationCapacity,
  runWithDatabaseContext, retryTaskStatsRefresh, activeTaskGenerationBySubject,
  taskGenerationJobs, taskStatsEventRetentionMs, taskStatsEventScanBatchSize,
  taskStatsEventFlushIntervalMs, taskStatsEventCleanupIntervalMs,
  invalidateScorerQueryCaches, updateProjectTaskStatsDeltaStmt,
  reconcileProjectTaskStatsStmt, updateScorerTaskStatsDeltaStmt,
  insertScorerTaskStatsDeltaStmt, deleteEmptyScorerTaskStatsStmt,
  updateScorerScoringStatsDeltaStmt, insertScorerScoringStatsDeltaStmt,
  refreshScorerScoringExtremaStmt, deleteEmptyScorerScoringStatsStmt,
  addDashboardCompletionHourStatsStmt, subtractDashboardCompletionHourStatsStmt,
  deleteProjectTaskStatsStmt, insertProjectTaskStatsFromTasksStmt,
  deleteScorerTaskStatsStmt, insertScorerTaskStatsFromTasksStmt,
  deleteScorerScoringStatsStmt, insertScorerScoringStatsFromTasksStmt,
  selectPendingProjectTaskStatsEventHourDeltasStmt,
  markPendingProjectTaskStatsEventsStmt, selectProjectByIdStmt,
  updateSubjectTaskStatusStmt, lockTaskStatsMaintenanceStmt,
  deleteProcessedTaskStatsEventsStmt, tryTaskStatsMaintenanceLockStmt,
  selectPendingTaskStatsEventsStmt, selectActiveTaskGenerationSubjectsStmt,
  markTaskStatsEventsProcessedByIdsStmt,
}: Pick<StatsFns, "scoringStatsAdditiveFields" | "aggregateTaskStatsEvents" | "getProjectTaskStats"> & {
  db: typeof database;
  taskVersion: string;
  nowIso: () => string;
  subjectTaskReportCache: Map<string, unknown>;
  getTaskGenerationCapacity: (projectId: string) => Promise<{ availableTaskCount: number }>;
  runWithDatabaseContext: typeof databaseContext;
  retryTaskStatsRefresh: typeof retryRefresh;
  activeTaskGenerationBySubject: Map<string, string>;
  taskGenerationJobs: Map<string, { status: string }>;
  taskStatsEventRetentionMs: number;
  taskStatsEventScanBatchSize: number;
  taskStatsEventFlushIntervalMs: number;
  taskStatsEventCleanupIntervalMs: number;
  invalidateScorerQueryCaches: () => void;
  updateProjectTaskStatsDeltaStmt: Statement;
  reconcileProjectTaskStatsStmt: Statement;
  updateScorerTaskStatsDeltaStmt: Statement;
  insertScorerTaskStatsDeltaStmt: Statement;
  deleteEmptyScorerTaskStatsStmt: Statement;
  updateScorerScoringStatsDeltaStmt: Statement;
  insertScorerScoringStatsDeltaStmt: Statement;
  refreshScorerScoringExtremaStmt: Statement;
  deleteEmptyScorerScoringStatsStmt: Statement;
  addDashboardCompletionHourStatsStmt: Statement;
  subtractDashboardCompletionHourStatsStmt: Statement;
  deleteProjectTaskStatsStmt: Statement;
  insertProjectTaskStatsFromTasksStmt: Statement;
  deleteScorerTaskStatsStmt: Statement;
  insertScorerTaskStatsFromTasksStmt: Statement;
  deleteScorerScoringStatsStmt: Statement;
  insertScorerScoringStatsFromTasksStmt: Statement;
  selectPendingProjectTaskStatsEventHourDeltasStmt: Statement;
  markPendingProjectTaskStatsEventsStmt: Statement;
  selectProjectByIdStmt: Statement;
  updateSubjectTaskStatusStmt: Statement;
  lockTaskStatsMaintenanceStmt: Statement;
  deleteProcessedTaskStatsEventsStmt: Statement;
  tryTaskStatsMaintenanceLockStmt: Statement;
  selectPendingTaskStatsEventsStmt: Statement;
  selectActiveTaskGenerationSubjectsStmt: Statement;
  markTaskStatsEventsProcessedByIdsStmt: (count: number) => Statement;
}) {
async function applyProjectTaskStatsDeltas(deltas: ProjectDelta, updatedAt: string) {
  for (const delta of deltas.values()) {
    const changed = delta.total || delta.pending || delta.assigned || delta.completed ||
      delta.baseTotal || delta.basePending;
    if (!changed) continue;
    const result = await updateProjectTaskStatsDeltaStmt.run({ ...delta, updatedAt });
    if (!result.changes) {
      await reconcileProjectTaskStatsStmt.run({
        projectId: delta.projectId,
        taskVersion: delta.taskVersion,
        updatedAt,
      });
    }
  }
}

async function applyScorerTaskStatsDeltas(deltas: ScorerTaskDelta, updatedAt: string) {
  for (const delta of deltas.values()) {
    if (!delta.assigned && !delta.completed) continue;
    const values = { ...delta, updatedAt };
    const result = await updateScorerTaskStatsDeltaStmt.run(values);
    if (!result.changes && (delta.assigned > 0 || delta.completed > 0)) {
      await insertScorerTaskStatsDeltaStmt.run({
        ...values,
        assigned: Math.max(0, delta.assigned),
        completed: Math.max(0, delta.completed),
      });
    }
    await deleteEmptyScorerTaskStatsStmt.run(
      delta.scorer,
      delta.taskVersion,
      delta.projectId,
    );
  }
}

async function applyScorerScoringStatsDeltas(deltas: ScoringDelta, updatedAt: string) {
  for (const delta of deltas.values()) {
    const values = { ...delta, updatedAt };
    const result = await updateScorerScoringStatsDeltaStmt.run(values);
    if (!result.changes && delta.taskCount > 0) {
      await insertScorerScoringStatsDeltaStmt.run({
        ...values,
        ...Object.fromEntries(
          scoringStatsAdditiveFields.map((field) => [field, Math.max(0, delta[field])]),
        ),
      });
    }
    if (delta.requiresExtremaRefresh) {
      await refreshScorerScoringExtremaStmt.get(
        delta.scorer,
        delta.taskVersion,
        delta.projectId,
        delta.submissionMode,
      );
    }
    await deleteEmptyScorerScoringStatsStmt.run(
      delta.scorer,
      delta.taskVersion,
      delta.projectId,
      delta.submissionMode,
    );
  }
}

async function applyTaskStatsEventBatch(events: StatsEvent[], processedAt: string) {
  const aggregates = aggregateTaskStatsEvents(events);
  await applyProjectTaskStatsDeltas(aggregates.projectDeltas, processedAt);
  await applyScorerTaskStatsDeltas(aggregates.scorerTaskDeltas, processedAt);
  await applyScorerScoringStatsDeltas(aggregates.scoringDeltas, processedAt);
  await applyDashboardCompletionHourDeltas(
    [...aggregates.hourDeltas.entries()].map(([key, delta]) => {
      const [version, hour] = key.split("\u0000");
      return { taskVersion: version, hour: Number(hour), delta };
    }),
    processedAt,
  );
}

async function applyDashboardCompletionHourDeltas(deltas: Array<{ taskVersion?: string; hour: number; delta: number }>, updatedAt = nowIso()) {
  for (const row of deltas) {
    const version = row.taskVersion || taskVersion;
    const hour = Number(row.hour);
    const delta = Number(row.delta || 0);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    if (!delta) continue;
    if (delta > 0) {
      await addDashboardCompletionHourStatsStmt.run(version, hour, delta, updatedAt);
    } else {
      await subtractDashboardCompletionHourStatsStmt.run(Math.abs(delta), updatedAt, version, hour);
    }
  }
}

async function refreshProjectTaskStats(projectId: string, version = taskVersion) {
  const refreshedAt = nowIso();
  await deleteProjectTaskStatsStmt.run(projectId, version);
  await insertProjectTaskStatsFromTasksStmt.run(
    refreshedAt,
    projectId,
    version,
  );
  await deleteScorerTaskStatsStmt.run(projectId, version);
  await insertScorerTaskStatsFromTasksStmt.run(
    refreshedAt,
    projectId,
    version,
  );
  await deleteScorerScoringStatsStmt.run(projectId, version);
  await insertScorerScoringStatsFromTasksStmt.run(
    refreshedAt,
    projectId,
    version,
  );
  const hourDeltas = await selectPendingProjectTaskStatsEventHourDeltasStmt.all(
    version,
    projectId,
    refreshedAt,
    version,
    projectId,
    refreshedAt,
  ) as Array<{ taskVersion?: string; hour: number; delta: number }>;
  await applyDashboardCompletionHourDeltas(hourDeltas, refreshedAt);
  await markPendingProjectTaskStatsEventsStmt.run(
    refreshedAt,
    version,
    projectId,
    refreshedAt,
  );
}

let taskGenerationAnalyzeQueued = false;
function queueTaskGenerationAnalyze() {
  if (taskGenerationAnalyzeQueued) return;
  taskGenerationAnalyzeQueued = true;
  setImmediate(async () => {
    try {
      for (const table of [
        "rating_tasks",
        "rating_task_items",
        "project_task_stats",
        "scorer_task_stats",
      ]) {
        await db.exec(`ANALYZE ${table}`);
      }
    } catch (error) {
      console.error("Task generation analyze failed", error);
    } finally {
      taskGenerationAnalyzeQueued = false;
    }
  });
}

function invalidateTaskSummaryCaches(projectId: string) {
  subjectTaskReportCache.delete(projectId);
}

const queuedProjectTaskSummaries = new Set<string>();
const dirtyProjectTaskSummaries = new Set<string>();

function queueProjectTaskSummary(projectId: string) {
  if (queuedProjectTaskSummaries.has(projectId)) {
    dirtyProjectTaskSummaries.add(projectId);
    return;
  }
  queuedProjectTaskSummaries.add(projectId);
  setImmediate(async () => {
    try {
      const project = await selectProjectByIdStmt.get(projectId);
      if (!project) return;
      const taskStats = await getProjectTaskStats(projectId);
      if (!taskStats.total) return;
      const capacity = taskStats.pending + taskStats.assigned === 0
        ? await getTaskGenerationCapacity(projectId)
        : null;
      const taskStatus = capacity?.availableTaskCount === 0
        ? "task_completed"
        : "scoring";
      if (project.taskStatus !== taskStatus) {
        await updateSubjectTaskStatusStmt.run({
          id: projectId,
          taskStatus,
          updatedAt: nowIso(),
        });
      }
    } catch (error) {
      // This summary update is eventually consistent; a durable job would be
      // needed if recovery after process loss becomes a requirement.
      console.error("failed to update project task summary", error);
    } finally {
      queuedProjectTaskSummaries.delete(projectId);
      if (dirtyProjectTaskSummaries.delete(projectId)) {
        queueProjectTaskSummary(projectId);
      }
    }
  });
}

let taskStatsEventFlushRunning = false;
let taskStatsEventFlushQueued = false;
let taskStatsEventFlushIntervalHandle: NodeJS.Timeout | null = null;
let taskStatsEventCleanupRunning = false;
let taskStatsEventCleanupIntervalHandle: NodeJS.Timeout | null = null;

async function runTaskStatsRefreshTransaction<T>(callback: () => Promise<T>, { repeatableRead = false }: { repeatableRead?: boolean } = {}) {
  return await runWithDatabaseContext(async () => {
    await db.exec("BEGIN");
    try {
      if (repeatableRead) {
        await db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      }
      const result = await callback();
      await db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

async function refreshGeneratedProjectTaskStats(projectId: string) {
  await retryTaskStatsRefresh(async () => {
    await runTaskStatsRefreshTransaction(async () => {
      // The API event flusher and generation workers run in different processes.
      await db.exec("SET LOCAL lock_timeout = '30000ms'");
      await lockTaskStatsMaintenanceStmt.get();
      await refreshProjectTaskStats(projectId);
    }, { repeatableRead: true });
  }, (error, attempt) => {
    console.warn("Task generation stats refresh retry", {
      projectId,
      attempt,
      code: error && typeof error === "object" && "code" in error ? error.code : null,
    });
  });
}

function hasActiveTaskGeneration(projectId: string) {
  const jobId = activeTaskGenerationBySubject.get(projectId);
  if (!jobId) return false;
  const job = taskGenerationJobs.get(jobId);
  return Boolean(job && ["queued", "running"].includes(job.status));
}

async function cleanupProcessedTaskStatsEvents() {
  const cutoff = new Date(Date.now() - taskStatsEventRetentionMs).toISOString();
  await deleteProcessedTaskStatsEventsStmt.run(cutoff);
}

async function runTaskStatsEventCleanup() {
  if (taskStatsEventCleanupRunning) return;
  taskStatsEventCleanupRunning = true;
  try {
    await cleanupProcessedTaskStatsEvents();
  } catch (error) {
    console.error("Task stats event cleanup failed", error);
  } finally {
    taskStatsEventCleanupRunning = false;
  }
}

async function flushTaskStatsEvents() {
  if (taskStatsEventFlushRunning) {
    taskStatsEventFlushQueued = true;
    return;
  }
  taskStatsEventFlushRunning = true;
  let failed = false;
  let processedCount = 0;
  let changedProjectIds: string[] = [];
  try {
    const result = await runTaskStatsRefreshTransaction(async () => {
      const lock = await tryTaskStatsMaintenanceLockStmt.get();
      if (!lock?.locked) return { processedCount: 0, changedProjectIds: [] };
      const cutoff = nowIso();
      const pendingEvents = await selectPendingTaskStatsEventsStmt.all(
        taskVersion,
        cutoff,
        taskStatsEventScanBatchSize,
      ) as StatsEvent[];
      const activeSubjects = new Set<string>(
        (await selectActiveTaskGenerationSubjectsStmt.all() as Array<{ subjectId: string }>).map((row) => row.subjectId),
      );
      const events = pendingEvents.filter((event) =>
        !activeSubjects.has(event.projectId) && !hasActiveTaskGeneration(event.projectId));
      if (!events.length) return { processedCount: 0, changedProjectIds: [] };

      const processedAt = nowIso();
      const exactRefreshProjectIds = new Set(
        events
          .filter((event) => event.eventType === "task_rolled_back" && !event.oldScoringStats)
          .map((event) => event.projectId),
      );
      for (const projectId of exactRefreshProjectIds) {
        await refreshProjectTaskStats(projectId);
      }
      const incrementalEvents = events.filter(
        (event) => !exactRefreshProjectIds.has(event.projectId),
      );
      if (incrementalEvents.length) {
        await applyTaskStatsEventBatch(incrementalEvents, processedAt);
        await markTaskStatsEventsProcessedByIdsStmt(incrementalEvents.length).run(
          processedAt,
          ...incrementalEvents.map((event) => event.id),
        );
      }
      return {
        processedCount: events.length,
        changedProjectIds: [...new Set(events.map((event) => event.projectId).filter(Boolean))],
      };
    });
    processedCount = result?.processedCount || 0;
    changedProjectIds = result?.changedProjectIds || [];
    for (const projectId of changedProjectIds) {
      invalidateTaskSummaryCaches(projectId);
      queueProjectTaskSummary(projectId);
    }
    if (processedCount) invalidateScorerQueryCaches();
  } catch (error) {
    failed = true;
    console.error("Task stats event flush failed", error);
  } finally {
    taskStatsEventFlushRunning = false;
    if (!failed && (taskStatsEventFlushQueued || processedCount >= taskStatsEventScanBatchSize)) {
      taskStatsEventFlushQueued = false;
      setImmediate(() => flushTaskStatsEvents());
    } else {
      taskStatsEventFlushQueued = false;
    }
  }
}

function startTaskStatsWorkers() {
  if (taskStatsEventFlushIntervalHandle) return;
  taskStatsEventFlushIntervalHandle = setInterval(() => {
    flushTaskStatsEvents();
  }, taskStatsEventFlushIntervalMs);
  taskStatsEventFlushIntervalHandle.unref?.();

  taskStatsEventCleanupIntervalHandle = setInterval(() => {
    runTaskStatsEventCleanup();
  }, taskStatsEventCleanupIntervalMs);
  taskStatsEventCleanupIntervalHandle.unref?.();

  // Incremental events are the normal statistics path; avoid periodic full-project scans.
  setImmediate(() => flushTaskStatsEvents());
}
  return {
    applyDashboardCompletionHourDeltas, refreshProjectTaskStats,
    queueTaskGenerationAnalyze, invalidateTaskSummaryCaches,
    queueProjectTaskSummary, runTaskStatsRefreshTransaction,
    refreshGeneratedProjectTaskStats, hasActiveTaskGeneration,
    flushTaskStatsEvents, startTaskStatsWorkers,
  };
}
