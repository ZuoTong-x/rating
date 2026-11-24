import { createTaskStatsCalculation, type TaskStatsEvent } from "./task-stats-calculation.ts";
import type { db as database } from "../postgres.ts";

type TaskStatsWriteDependencies = {
  db: typeof database;
  taskVersion: string;
  nowIso: () => string;
  selectProjectTaskStatsStmt: ReturnType<typeof database.prepare>;
  taskStatsEventInsertBatchSize: number;
};

export function createTaskStatsWriteService({
  db, taskVersion, nowIso, selectProjectTaskStatsStmt,
  taskStatsEventInsertBatchSize,
}: TaskStatsWriteDependencies) {
  async function getProjectTaskStats(projectId: string, version = taskVersion) {
    const row = await selectProjectTaskStatsStmt.get(projectId, version);
    return {
      total: Number(row?.total || 0),
      pending: Number(row?.pending || 0),
      assigned: Number(row?.assigned || 0),
      completed: Number(row?.completed || 0),
      baseTotal: row?.baseTotal == null ? null : Number(row.baseTotal || 0),
      basePending: row?.basePending == null ? null : Number(row.basePending || 0),
    };
  }

  async function beginTaskStatsSkippedTransaction() {
    await db.exec("BEGIN");
    await db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    // Task counters are rebuilt in batches. Keep row-level triggers out of hot
    // task write paths so scoring submissions do not compete on stats rows.
    await db.exec("SET LOCAL app.skip_rating_task_stats = 'on'");
  }

  async function beginSynchronousTaskStatsTransaction() {
    await db.exec("BEGIN");
    await db.exec("SET LOCAL app.sync_rating_task_stats = 'on'");
  }

  async function beginTaskWriteTransaction() {
    await beginTaskStatsSkippedTransaction();
  }

  const {
    normalizedTaskStatsEvent, taskScoringStatsSnapshot,
    scoringStatsAdditiveFields, aggregateTaskStatsEvents,
  } = createTaskStatsCalculation({ taskVersion, nowIso });

  async function recordTaskStatsEvents(events: TaskStatsEvent | TaskStatsEvent[]) {
    const rows = (Array.isArray(events) ? events : [events])
      .map(normalizedTaskStatsEvent)
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    for (let start = 0; start < rows.length; start += taskStatsEventInsertBatchSize) {
      const batch = rows.slice(start, start + taskStatsEventInsertBatchSize);
      const params: unknown[] = [];
      batch.forEach((row) => {
        params.push(
          row.taskId,
          row.projectId,
          row.taskVersion,
          row.eventType,
          row.oldStatus,
          row.newStatus,
          row.oldScorer,
          row.newScorer,
          row.oldCompletedAt,
          row.newCompletedAt,
          row.isBacktest,
          row.applyScorerTaskStats,
          row.oldScoringStats ? JSON.stringify(row.oldScoringStats) : null,
          row.newScoringStats ? JSON.stringify(row.newScoringStats) : null,
          row.createdAt,
        );
      });
      await db.prepare(
        `INSERT INTO task_stats_events (
           taskId, projectId, taskVersion, eventType,
           oldStatus, newStatus, oldScorer, newScorer,
           oldCompletedAt, newCompletedAt, isBacktest, applyScorerTaskStats,
           oldScoringStats, newScoringStats, createdAt
         ) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)").join(", ")}`,
      ).run(...params);
    }
  }

  return {
    getProjectTaskStats, beginTaskStatsSkippedTransaction,
    beginSynchronousTaskStatsTransaction, beginTaskWriteTransaction,
    recordTaskStatsEvents, taskScoringStatsSnapshot,
    scoringStatsAdditiveFields, aggregateTaskStatsEvents,
  };
}
