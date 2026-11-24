import type { db as database } from "../postgres.ts";

export function createTaskCoreStatements(db: typeof database) {
const selectTaskRowsPageStmt = db.prepare(`
  SELECT id, subjectId, projectId, taskVersion, taskType, status, scorer, ranking, excludedImageIds, correctImageIds, rankingRelations,
         submissionMode, rankingActionCount, dragActionCount, orderChanged, largeImageOpened, largeImageOpenCount,
         firstActionMs, pageBlurCount, behaviorTracked, riskScore, riskFlags, isBacktest, backtestSourceId, startedAt, completedAt, durationMs, editedAt, editCount,
         rollbackCount, lastRolledBackAt, lastRolledBackBy, imageKey, createdAt, updatedAt
  FROM rating_tasks
  WHERE projectId = ? AND taskVersion = ?
  ORDER BY taskType ASC, createdAt ASC, id ASC
  LIMIT ? OFFSET ?
`);
const selectAssignedTaskRowsPageStmt = db.prepare(`
  SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId, rating_tasks.taskVersion,
         rating_tasks.taskType, rating_tasks.status, rating_tasks.scorer, rating_tasks.ranking, rating_tasks.excludedImageIds, rating_tasks.correctImageIds, rating_tasks.rankingRelations,
         rating_tasks.submissionMode, rating_tasks.rankingActionCount, rating_tasks.dragActionCount,
         rating_tasks.orderChanged, rating_tasks.largeImageOpened, rating_tasks.largeImageOpenCount,
         rating_tasks.firstActionMs, rating_tasks.pageBlurCount, rating_tasks.behaviorTracked, rating_tasks.riskScore, rating_tasks.riskFlags,
         rating_tasks.isBacktest, rating_tasks.backtestSourceId,
         rating_tasks.startedAt, rating_tasks.completedAt, rating_tasks.durationMs, rating_tasks.editedAt, rating_tasks.editCount,
         rating_tasks.rollbackCount, rating_tasks.lastRolledBackAt, rating_tasks.lastRolledBackBy,
         rating_tasks.imageKey, rating_tasks.createdAt, rating_tasks.updatedAt,
         projects.name AS subjectName
  FROM rating_tasks
  JOIN projects ON projects.id = rating_tasks.projectId
  WHERE rating_tasks.taskVersion = ?
    AND rating_tasks.scorer = ?
    AND rating_tasks.status = 'assigned'
    AND (?::text IS NULL OR rating_tasks.projectId = ?)
  ORDER BY rating_tasks.updatedAt DESC, rating_tasks.id ASC
  LIMIT ? OFFSET ?
`);
const selectAssignedTaskCountStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM rating_tasks
  WHERE taskVersion = ?
    AND scorer = ?
    AND status = 'assigned'
    AND (?::text IS NULL OR projectId = ?)
`);
const selectScorerTaskStatsStmt = db.prepare(`
  SELECT
    COALESCE(SUM(stats.assigned), 0) AS pendingTasks,
    COALESCE(SUM(stats.completed), 0) AS completedTasks
  FROM scorer_task_stats stats
  JOIN projects ON projects.id = stats.projectId
  WHERE stats.taskVersion = ?
    AND stats.scorer = ?
    AND projects.tasksLocked = false
    AND projects.deletionRequestedAt IS NULL
    AND (?::text IS NULL OR stats.projectId = ?)
`);
const selectScorerTaskListTotalStmt = db.prepare(`
  SELECT COALESCE(SUM(
    CASE
      WHEN ?::text = 'assigned' THEN stats.assigned
      WHEN ?::text = 'completed' THEN stats.completed
      ELSE stats.assigned + stats.completed
    END
  ), 0) AS total
  FROM scorer_task_stats stats
  JOIN projects ON projects.id = stats.projectId
  WHERE stats.taskVersion = ?
    AND stats.scorer = ?
    AND projects.tasksLocked = false
    AND projects.deletionRequestedAt IS NULL
    AND (?::text IS NULL OR stats.projectId = ?)
`);
const selectScorerProjectCountStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM scorer_task_stats stats
  JOIN projects ON projects.id = stats.projectId
  WHERE stats.taskVersion = ?
    AND stats.scorer = ?
    AND stats.projectId <> ''
    AND (stats.assigned + stats.completed) > 0
    AND projects.tasksLocked = false
    AND projects.deletionRequestedAt IS NULL
`);
const selectTaskByIdStmt = db.prepare(`
  SELECT id, subjectId, projectId, taskVersion, taskType, status, scorer, ranking, excludedImageIds, correctImageIds, rankingRelations,
         submissionMode, rankingActionCount, dragActionCount, orderChanged, largeImageOpened, largeImageOpenCount,
         firstActionMs, pageBlurCount, behaviorTracked, riskScore, riskFlags, isBacktest, backtestSourceId, startedAt, completedAt, durationMs, editedAt, editCount,
         rollbackCount, lastRolledBackAt, lastRolledBackBy, claimToken, claimedAt, claimExpiresAt,
         imageKey, createdAt, updatedAt
  FROM rating_tasks
  WHERE id = ?
`);
const claimAssignedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET claimToken = @claimToken,
      claimedAt = CASE
        WHEN claimToken = @claimToken THEN COALESCE(claimedAt, @claimedAt)
        ELSE @claimedAt
      END,
      claimExpiresAt = @claimExpiresAt
  WHERE id = @id
    AND taskVersion = @taskVersion
    AND scorer = @scorer
    AND status = 'assigned'
    AND EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = rating_tasks.projectId
        AND projects.tasksLocked = false
        AND projects.deletionRequestedAt IS NULL
    )
    AND (
      (
        @requestedClaimToken <> ''
        AND (
          claimToken = @requestedClaimToken
          OR claimToken IS NULL
          OR claimExpiresAt IS NULL
          OR claimExpiresAt <= @claimedAt
        )
      )
      OR (
        @requestedClaimToken = ''
        AND (
          claimToken IS NULL
          OR claimExpiresAt IS NULL
          OR claimExpiresAt <= @claimedAt
        )
      )
    )
`);
const releaseTaskClaimStmt = db.prepare(`
  UPDATE rating_tasks
  SET claimToken = NULL,
      claimedAt = NULL,
      claimExpiresAt = NULL
  WHERE id = ?
    AND taskVersion = ?
    AND scorer = ?
    AND status = 'assigned'
    AND claimToken = ?
`);
const selectTaskImageIdsStmt = db.prepare(`
  SELECT imageId
  FROM rating_task_items
  WHERE taskId = ?
  ORDER BY position ASC, imageId ASC
`);
const completeAssignedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET status = 'completed',
      ranking = @ranking,
      excludedImageIds = @excludedImageIds,
      correctImageIds = @correctImageIds,
      rankingRelations = @rankingRelations,
      submissionMode = @submissionMode,
      rankingActionCount = @rankingActionCount,
      dragActionCount = @dragActionCount,
      orderChanged = @orderChanged,
      largeImageOpened = @largeImageOpened,
      largeImageOpenCount = @largeImageOpenCount,
      startedAt = @startedAt,
      completedAt = @completedAt,
      durationMs = @durationMs,
      firstActionMs = @firstActionMs,
      pageBlurCount = @pageBlurCount,
      behaviorTracked = @behaviorTracked,
      riskScore = @riskScore,
      riskFlags = @riskFlags,
      claimToken = NULL,
      claimedAt = NULL,
      claimExpiresAt = NULL,
      updatedAt = @updatedAt
  WHERE id = @id
    AND status = 'assigned'
    AND scorer = @scorer
    AND EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = rating_tasks.projectId
        AND projects.tasksLocked = false
        AND projects.deletionRequestedAt IS NULL
    )
`);
const updateCompletedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET ranking = @ranking,
      excludedImageIds = @excludedImageIds,
      correctImageIds = @correctImageIds,
      rankingRelations = @rankingRelations,
      submissionMode = @submissionMode,
      rankingActionCount = @rankingActionCount,
      dragActionCount = @dragActionCount,
      orderChanged = @orderChanged,
      largeImageOpened = @largeImageOpened,
      largeImageOpenCount = @largeImageOpenCount,
      firstActionMs = @firstActionMs,
      pageBlurCount = @pageBlurCount,
      behaviorTracked = @behaviorTracked,
      riskScore = @riskScore,
      riskFlags = @riskFlags,
      claimToken = NULL,
      claimedAt = NULL,
      claimExpiresAt = NULL,
      editedAt = @editedAt,
      editCount = COALESCE(editCount, 0) + 1,
      updatedAt = @updatedAt
  WHERE id = @id
    AND status = 'completed'
    AND scorer = @scorer
    AND EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id = rating_tasks.projectId
        AND projects.tasksLocked = false
        AND projects.deletionRequestedAt IS NULL
    )
`);
const insertRatingTaskStmt = db.prepare(`
  INSERT INTO rating_tasks (
    id, subjectId, projectId, taskVersion, round, taskType, status, scorer, ranking, assignmentKey, imageKey, isBacktest, backtestSourceId, createdAt, updatedAt
  ) VALUES (
    @id, @subjectId, @projectId, @taskVersion, @round, @taskType, 'pending', NULL, NULL, @assignmentKey, @imageKey, false, NULL, @createdAt, @updatedAt
  )
  ON CONFLICT DO NOTHING
`);
const insertRatingTaskItemStmt = db.prepare(`
  INSERT INTO rating_task_items (taskId, imageId, position, role)
  VALUES (@taskId, @imageId, @position, @role)
  ON CONFLICT DO NOTHING
`);
const selectSubjectTaskTemplatesStmt = db.prepare(`
  SELECT id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey
  FROM subject_task_templates
  WHERE subjectId = ?
  ORDER BY selectionKey ASC, id ASC
`);
  return {
    selectTaskRowsPageStmt,
    selectAssignedTaskRowsPageStmt,
    selectAssignedTaskCountStmt,
    selectScorerTaskStatsStmt,
    selectScorerTaskListTotalStmt,
    selectScorerProjectCountStmt,
    selectTaskByIdStmt,
    claimAssignedTaskStmt,
    releaseTaskClaimStmt,
    selectTaskImageIdsStmt,
    completeAssignedTaskStmt,
    updateCompletedTaskStmt,
    insertRatingTaskStmt,
    insertRatingTaskItemStmt,
    selectSubjectTaskTemplatesStmt,
  };
}
