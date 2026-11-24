import type { db as database } from "../postgres.ts";

export function createTaskStatsStatements({ db, placeholders }: {
  db: typeof database;
  placeholders: (length: number) => string;
}) {
const updateSubjectTaskStatusStmt = db.prepare(`
  UPDATE projects
  SET taskStatus = @taskStatus, updatedAt = @updatedAt
  WHERE id = @id
`);
const selectProjectTaskStatsStmt = db.prepare(`
  SELECT total, pending, assigned, completed, baseTotal, basePending
  FROM project_task_stats
  WHERE projectId = ? AND taskVersion = ?
`);
const deleteProjectTaskStatsStmt = db.prepare(`
  DELETE FROM project_task_stats
  WHERE projectId = ? AND taskVersion = ?
`);
const insertProjectTaskStatsFromTasksStmt = db.prepare(`
  INSERT INTO project_task_stats (
    projectId, taskVersion, total, pending, assigned, completed, baseTotal, basePending, updatedAt
  )
  SELECT
    projectId,
    taskVersion,
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE status = 'pending')::integer,
    COUNT(*) FILTER (WHERE status = 'assigned')::integer,
    COUNT(*) FILTER (WHERE status = 'completed')::integer,
    COUNT(*) FILTER (WHERE NOT isBacktest)::integer,
    COUNT(*) FILTER (WHERE NOT isBacktest AND status = 'pending')::integer,
    COALESCE(MAX(updatedAt), ?)
  FROM rating_tasks
  WHERE projectId = ? AND taskVersion = ?
  GROUP BY projectId, taskVersion
`);
const backfillProjectTaskBaseStatsStmt = db.prepare(`
  UPDATE project_task_stats stats
  SET baseTotal = task_counts.baseTotal,
      basePending = task_counts.basePending,
      updatedAt = GREATEST(stats.updatedAt, task_counts.updatedAt)
  FROM (
    SELECT
      projectId,
      taskVersion,
      COUNT(*) FILTER (WHERE NOT isBacktest)::integer AS baseTotal,
      COUNT(*) FILTER (WHERE NOT isBacktest AND status = 'pending')::integer AS basePending,
      COALESCE(MAX(updatedAt), ?) AS updatedAt
    FROM rating_tasks
    WHERE taskVersion = ?
      AND projectId IS NOT NULL
      AND TRIM(projectId) <> ''
    GROUP BY projectId, taskVersion
  ) task_counts
  WHERE stats.projectId = task_counts.projectId
    AND stats.taskVersion = task_counts.taskVersion
    AND (stats.baseTotal IS NULL OR stats.basePending IS NULL)
`);
const deleteScorerTaskStatsStmt = db.prepare(`
  DELETE FROM scorer_task_stats
  WHERE projectId = ? AND taskVersion = ?
`);
const insertScorerTaskStatsFromTasksStmt = db.prepare(`
  INSERT INTO scorer_task_stats (
    scorer, taskVersion, projectId, assigned, completed, updatedAt
  )
  SELECT
    scorer,
    taskVersion,
    projectId,
    COUNT(*) FILTER (WHERE status = 'assigned')::integer,
    COUNT(*) FILTER (WHERE status = 'completed')::integer,
    COALESCE(MAX(updatedAt), ?)
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND scorer IS NOT NULL
    AND TRIM(scorer) <> ''
    AND status IN ('assigned', 'completed')
  GROUP BY scorer, taskVersion, projectId
`);
const deleteScorerScoringStatsStmt = db.prepare(`
  DELETE FROM scorer_scoring_stats
  WHERE projectId = ? AND taskVersion = ?
`);
const insertScorerScoringStatsFromTasksStmt = db.prepare(`
  INSERT INTO scorer_scoring_stats (
    scorer, taskVersion, projectId, submissionMode, taskCount,
    largeImageOpenedCount, trackedLargeImageOpenedCount, largeImageOpenCountTotal, dragActionCountTotal,
    orderChangedCount, fastSubmitCount, highRiskCount, behaviorTrackedCount, riskScoreTotal, riskScoreMax,
    pageBlurCountTotal, durationTotal, durationCount, durationMin, durationMax,
    rollbackCount, updatedAt
  )
  SELECT
    scorer,
    taskVersion,
    COALESCE(projectId, ''),
    COALESCE(submissionMode, 'untracked'),
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE COALESCE(largeImageOpened, false))::bigint,
    COUNT(*) FILTER (WHERE COALESCE(behaviorTracked, false) AND COALESCE(largeImageOpened, false))::bigint,
    COALESCE(SUM(GREATEST(COALESCE(largeImageOpenCount, 0), 0)), 0)::bigint,
    COALESCE(SUM(GREATEST(COALESCE(dragActionCount, 0), 0)), 0)::bigint,
    COUNT(*) FILTER (WHERE COALESCE(behaviorTracked, false) AND COALESCE(orderChanged, false))::bigint,
    COUNT(*) FILTER (
      WHERE COALESCE(behaviorTracked, false)
        AND durationMs IS NOT NULL
        AND durationMs >= 0
        AND durationMs < 3000
    )::bigint,
    COUNT(*) FILTER (WHERE COALESCE(behaviorTracked, false) AND COALESCE(riskScore, 0) >= 60)::bigint,
    COUNT(*) FILTER (WHERE COALESCE(behaviorTracked, false))::bigint,
    COALESCE(SUM(
      CASE WHEN COALESCE(behaviorTracked, false)
        THEN GREATEST(COALESCE(riskScore, 0), 0)
        ELSE 0
      END
    ), 0)::bigint,
    COALESCE(MAX(GREATEST(COALESCE(riskScore, 0), 0)), 0)::integer,
    COALESCE(SUM(
      CASE WHEN COALESCE(behaviorTracked, false)
        THEN GREATEST(COALESCE(pageBlurCount, 0), 0)
        ELSE 0
      END
    ), 0)::bigint,
    COALESCE(SUM(
      CASE WHEN durationMs IS NOT NULL AND durationMs >= 0
        THEN durationMs
        ELSE 0
      END
    ), 0)::bigint,
    COUNT(*) FILTER (WHERE durationMs IS NOT NULL AND durationMs >= 0)::bigint,
    MIN(durationMs) FILTER (WHERE durationMs IS NOT NULL AND durationMs >= 0),
    MAX(durationMs) FILTER (WHERE durationMs IS NOT NULL AND durationMs >= 0),
    COALESCE(SUM(COALESCE(rollbackCount, 0)), 0)::bigint,
    COALESCE(MAX(updatedAt), ?)
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND scorer IS NOT NULL
    AND TRIM(scorer) <> ''
    AND status = 'completed'
  GROUP BY scorer, taskVersion, COALESCE(projectId, ''), COALESCE(submissionMode, 'untracked')
`);
const addDashboardCompletionHourStatsStmt = db.prepare(`
  INSERT INTO dashboard_completion_hour_stats (
    taskVersion, hour, completedTaskCount, updatedAt
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT (taskVersion, hour) DO UPDATE SET
    completedTaskCount = dashboard_completion_hour_stats.completedTaskCount + excluded.completedTaskCount,
    updatedAt = excluded.updatedAt
`);
const subtractDashboardCompletionHourStatsStmt = db.prepare(`
  UPDATE dashboard_completion_hour_stats
  SET completedTaskCount = GREATEST(0, completedTaskCount - ?),
      updatedAt = ?
  WHERE taskVersion = ?
    AND hour = ?
`);
const selectPendingTaskStatsEventsStmt = db.prepare(`
  SELECT id, taskId, projectId, taskVersion, eventType,
         oldStatus, newStatus, oldScorer, newScorer,
         oldCompletedAt, newCompletedAt, isBacktest, applyScorerTaskStats,
         oldScoringStats, newScoringStats, createdAt
  FROM task_stats_events
  WHERE taskVersion = ?
    AND processedAt IS NULL
    AND createdAt <= ?
  ORDER BY id ASC
  LIMIT ?
  FOR UPDATE SKIP LOCKED
`);
const selectPendingProjectTaskStatsEventHourDeltasStmt = db.prepare(`
  SELECT taskVersion, hour, SUM(delta)::integer AS delta
  FROM (
    SELECT taskVersion,
           EXTRACT(HOUR FROM oldCompletedAt AT TIME ZONE 'Asia/Shanghai')::integer AS hour,
           -COUNT(*)::integer AS delta
    FROM task_stats_events
    WHERE taskVersion = ?
      AND projectId = ?
      AND processedAt IS NULL
      AND createdAt <= ?
      AND oldStatus = 'completed'
      AND oldCompletedAt IS NOT NULL
    GROUP BY taskVersion, EXTRACT(HOUR FROM oldCompletedAt AT TIME ZONE 'Asia/Shanghai')::integer

    UNION ALL

    SELECT taskVersion,
           EXTRACT(HOUR FROM newCompletedAt AT TIME ZONE 'Asia/Shanghai')::integer AS hour,
           COUNT(*)::integer AS delta
    FROM task_stats_events
    WHERE taskVersion = ?
      AND projectId = ?
      AND processedAt IS NULL
      AND createdAt <= ?
      AND newStatus = 'completed'
      AND newCompletedAt IS NOT NULL
    GROUP BY taskVersion, EXTRACT(HOUR FROM newCompletedAt AT TIME ZONE 'Asia/Shanghai')::integer
  ) event_deltas
  GROUP BY taskVersion, hour
  ORDER BY hour ASC
`);
const markPendingProjectTaskStatsEventsStmt = db.prepare(`
  UPDATE task_stats_events
  SET processedAt = ?
  WHERE taskVersion = ?
    AND projectId = ?
    AND processedAt IS NULL
    AND createdAt <= ?
`);
const markTaskStatsEventsProcessedByIdsStmt = (eventCount: number) => db.prepare(`
  UPDATE task_stats_events
  SET processedAt = ?
  WHERE processedAt IS NULL
    AND id IN (${placeholders(eventCount)})
`);
const tryTaskStatsMaintenanceLockStmt = db.prepare(`
  SELECT pg_try_advisory_xact_lock(2026091401) AS locked
`);
const lockTaskStatsMaintenanceStmt = db.prepare(`
  SELECT pg_advisory_xact_lock(2026091401) AS locked
`);
const updateProjectTaskStatsDeltaStmt = db.prepare(`
  UPDATE project_task_stats
  SET total = GREATEST(0, total + @total),
      pending = GREATEST(0, pending + @pending),
      assigned = GREATEST(0, assigned + @assigned),
      completed = GREATEST(0, completed + @completed),
      baseTotal = GREATEST(0, COALESCE(baseTotal, total) + @baseTotal),
      basePending = GREATEST(0, COALESCE(basePending, pending) + @basePending),
      updatedAt = @updatedAt
  WHERE projectId = @projectId
    AND taskVersion = @taskVersion
`);
const reconcileProjectTaskStatsStmt = db.prepare(`
  INSERT INTO project_task_stats (
    projectId, taskVersion, total, pending, assigned, completed, baseTotal, basePending, updatedAt
  )
  SELECT
    projectId,
    taskVersion,
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE status = 'pending')::integer,
    COUNT(*) FILTER (WHERE status = 'assigned')::integer,
    COUNT(*) FILTER (WHERE status = 'completed')::integer,
    COUNT(*) FILTER (WHERE NOT isBacktest)::integer,
    COUNT(*) FILTER (WHERE NOT isBacktest AND status = 'pending')::integer,
    @updatedAt
  FROM rating_tasks
  WHERE projectId = @projectId
    AND taskVersion = @taskVersion
  GROUP BY projectId, taskVersion
  ON CONFLICT (projectId, taskVersion) DO UPDATE SET
    total = excluded.total,
    pending = excluded.pending,
    assigned = excluded.assigned,
    completed = excluded.completed,
    baseTotal = excluded.baseTotal,
    basePending = excluded.basePending,
    updatedAt = excluded.updatedAt
`);
const updateScorerTaskStatsDeltaStmt = db.prepare(`
  UPDATE scorer_task_stats
  SET assigned = GREATEST(0, assigned + @assigned),
      completed = GREATEST(0, completed + @completed),
      updatedAt = @updatedAt
  WHERE scorer = @scorer
    AND taskVersion = @taskVersion
    AND projectId = @projectId
`);
const insertScorerTaskStatsDeltaStmt = db.prepare(`
  INSERT INTO scorer_task_stats (
    scorer, taskVersion, projectId, assigned, completed, updatedAt
  ) VALUES (
    @scorer, @taskVersion, @projectId, @assigned, @completed, @updatedAt
  )
  ON CONFLICT DO NOTHING
`);
const deleteEmptyScorerTaskStatsStmt = db.prepare(`
  DELETE FROM scorer_task_stats
  WHERE scorer = ? AND taskVersion = ? AND projectId = ?
    AND assigned = 0 AND completed = 0
`);
const updateScorerScoringStatsDeltaStmt = db.prepare(`
  UPDATE scorer_scoring_stats
  SET taskCount = GREATEST(0, taskCount + @taskCount),
      largeImageOpenedCount = GREATEST(0, largeImageOpenedCount + @largeImageOpenedCount),
      trackedLargeImageOpenedCount = GREATEST(0, trackedLargeImageOpenedCount + @trackedLargeImageOpenedCount),
      largeImageOpenCountTotal = GREATEST(0, largeImageOpenCountTotal + @largeImageOpenCountTotal),
      dragActionCountTotal = GREATEST(0, dragActionCountTotal + @dragActionCountTotal),
      orderChangedCount = GREATEST(0, orderChangedCount + @orderChangedCount),
      fastSubmitCount = GREATEST(0, fastSubmitCount + @fastSubmitCount),
      highRiskCount = GREATEST(0, highRiskCount + @highRiskCount),
      behaviorTrackedCount = GREATEST(0, behaviorTrackedCount + @behaviorTrackedCount),
      riskScoreTotal = GREATEST(0, riskScoreTotal + @riskScoreTotal),
      riskScoreMax = GREATEST(riskScoreMax, @riskScoreMax),
      pageBlurCountTotal = GREATEST(0, pageBlurCountTotal + @pageBlurCountTotal),
      durationTotal = GREATEST(0, durationTotal + @durationTotal),
      durationCount = GREATEST(0, durationCount + @durationCount),
      durationMin = CASE
        WHEN @durationMin::bigint IS NULL THEN durationMin
        WHEN durationMin IS NULL THEN @durationMin::bigint
        ELSE LEAST(durationMin, @durationMin::bigint)
      END,
      durationMax = CASE
        WHEN @durationMax::bigint IS NULL THEN durationMax
        WHEN durationMax IS NULL THEN @durationMax::bigint
        ELSE GREATEST(durationMax, @durationMax::bigint)
      END,
      rollbackCount = GREATEST(0, rollbackCount + @rollbackCount),
      updatedAt = @updatedAt
  WHERE scorer = @scorer
    AND taskVersion = @taskVersion
    AND projectId = @projectId
    AND submissionMode = @submissionMode
`);
const insertScorerScoringStatsDeltaStmt = db.prepare(`
  INSERT INTO scorer_scoring_stats (
    scorer, taskVersion, projectId, submissionMode, taskCount,
    largeImageOpenedCount, trackedLargeImageOpenedCount, largeImageOpenCountTotal, dragActionCountTotal,
    orderChangedCount, fastSubmitCount, highRiskCount, behaviorTrackedCount, riskScoreTotal, riskScoreMax,
    pageBlurCountTotal, durationTotal, durationCount, durationMin, durationMax,
    rollbackCount, updatedAt
  ) VALUES (
    @scorer, @taskVersion, @projectId, @submissionMode, @taskCount,
    @largeImageOpenedCount, @trackedLargeImageOpenedCount, @largeImageOpenCountTotal, @dragActionCountTotal,
    @orderChangedCount, @fastSubmitCount, @highRiskCount, @behaviorTrackedCount, @riskScoreTotal, @riskScoreMax,
    @pageBlurCountTotal, @durationTotal, @durationCount, @durationMin, @durationMax,
    @rollbackCount, @updatedAt
  )
  ON CONFLICT DO NOTHING
`);
const deleteEmptyScorerScoringStatsStmt = db.prepare(`
  DELETE FROM scorer_scoring_stats
  WHERE scorer = ? AND taskVersion = ? AND projectId = ? AND submissionMode = ?
    AND taskCount = 0
`);
const refreshScorerScoringExtremaStmt = db.prepare(`
  SELECT refresh_scorer_scoring_duration(?, ?, ?, ?)
`);
const deleteProcessedTaskStatsEventsStmt = db.prepare(`
  DELETE FROM task_stats_events
  WHERE processedAt IS NOT NULL
    AND processedAt < ?
`);
const deleteProjectTaskStatsEventsStmt = db.prepare(`
  DELETE FROM task_stats_events
  WHERE projectId = ? AND taskVersion = ?
`);
  return {
    updateSubjectTaskStatusStmt, selectProjectTaskStatsStmt, deleteProjectTaskStatsStmt,
    insertProjectTaskStatsFromTasksStmt, backfillProjectTaskBaseStatsStmt,
    deleteScorerTaskStatsStmt, insertScorerTaskStatsFromTasksStmt,
    deleteScorerScoringStatsStmt, insertScorerScoringStatsFromTasksStmt,
    addDashboardCompletionHourStatsStmt, subtractDashboardCompletionHourStatsStmt,
    selectPendingTaskStatsEventsStmt, selectPendingProjectTaskStatsEventHourDeltasStmt,
    markPendingProjectTaskStatsEventsStmt, markTaskStatsEventsProcessedByIdsStmt,
    tryTaskStatsMaintenanceLockStmt, lockTaskStatsMaintenanceStmt,
    updateProjectTaskStatsDeltaStmt, reconcileProjectTaskStatsStmt,
    updateScorerTaskStatsDeltaStmt, insertScorerTaskStatsDeltaStmt,
    deleteEmptyScorerTaskStatsStmt, updateScorerScoringStatsDeltaStmt,
    insertScorerScoringStatsDeltaStmt, deleteEmptyScorerScoringStatsStmt,
    refreshScorerScoringExtremaStmt, deleteProcessedTaskStatsEventsStmt,
    deleteProjectTaskStatsEventsStmt,
  };
}
