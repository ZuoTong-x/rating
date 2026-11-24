import crypto from "node:crypto";
import type { db as database } from "../postgres.ts";
import type { createTaskSubmissionValidation } from "./task-submission-validation.ts";
import type { createTaskQueryCore } from "./task-query-core.ts";
import type { createTaskStatsWriteService } from "./task-stats-write.ts";

type ValidationFns = ReturnType<typeof createTaskSubmissionValidation>;
type QueryFns = ReturnType<typeof createTaskQueryCore>;
type StatsFns = ReturnType<typeof createTaskStatsWriteService>;
type TaskRow = Parameters<QueryFns["completedTaskResultDto"]>[0] & {
  projectId?: string;
  status: string;
  scorer?: string | null;
  taskType: string;
  behaviorTracked?: boolean;
  dragActionCount?: number;
  orderChanged?: boolean;
  largeImageOpened?: boolean;
  largeImageOpenCount?: number;
  firstActionMs?: number | null;
  pageBlurCount?: number;
  isBacktest?: boolean;
  durationMs?: number | null;
  riskScore?: number | null;
  submissionMode?: string | null;
  completedAt?: string | null;
  rollbackCount?: number;
};
type StepTimer = {
  mark: (step: string) => void;
  warnIfSlow: (operation: string, context: Record<string, unknown>) => void;
};

export function createTaskSubmissionService({
    nowIso, taskClaimLeaseMs, db, claimAssignedTaskStmt, taskVersion,
    selectTaskByIdStmt, assertProjectTasksUnlocked, httpError, parseTaskClaimToken,
    releaseTaskClaimStmt, createStepTimer, parseScorerName, completedTaskResultDto,
    selectTaskImageIdsStmt, parseTaskExcludedImageIds, parseTaskCorrectImageIds,
    parseTaskRanking, parseTaskRankingRelations, parseTaskDuration,
    parseRankingActionCount, hasTaskBehaviorTracking, parseTaskBehaviorCount,
    parseTaskBehaviorBoolean, parseLargeImageOpened, parseFirstActionMs,
    calculateTaskRisk, parseTaskSubmissionMode, beginSynchronousTaskStatsTransaction,
    completeAssignedTaskStmt, recordTaskStatsEvents, invalidateTaskSummaryCaches,
    invalidateScorerQueryCaches, updateCompletedTaskStmt, hydrateTaskRows,
}: Pick<ValidationFns,
  "parseTaskClaimToken" | "parseTaskExcludedImageIds" | "parseTaskCorrectImageIds" |
  "parseTaskRanking" | "parseTaskRankingRelations" | "parseTaskDuration" |
  "parseRankingActionCount" | "hasTaskBehaviorTracking" | "parseTaskBehaviorCount" |
  "parseTaskBehaviorBoolean" | "parseLargeImageOpened" | "parseFirstActionMs" |
  "calculateTaskRisk" | "parseTaskSubmissionMode"
> & Pick<QueryFns, "completedTaskResultDto" | "hydrateTaskRows"> &
  Pick<StatsFns, "beginSynchronousTaskStatsTransaction" | "recordTaskStatsEvents"> & {
  nowIso: () => string;
  taskClaimLeaseMs: number;
  db: typeof database;
  claimAssignedTaskStmt: ReturnType<typeof database.prepare>;
  taskVersion: string;
  selectTaskByIdStmt: ReturnType<typeof database.prepare>;
  assertProjectTasksUnlocked: (projectId: string) => Promise<unknown>;
  httpError: (status: number, message: string) => Error;
  releaseTaskClaimStmt: ReturnType<typeof database.prepare>;
  createStepTimer: () => StepTimer;
  parseScorerName: (value: unknown) => string | null;
  selectTaskImageIdsStmt: ReturnType<typeof database.prepare>;
  invalidateTaskSummaryCaches: (projectId: string) => void;
  invalidateScorerQueryCaches: () => void;
  completeAssignedTaskStmt: ReturnType<typeof database.prepare>;
  updateCompletedTaskStmt: ReturnType<typeof database.prepare>;
}) {
async function claimTaskForScorer(taskId: string, scorer: string, requestedClaimToken: string | null = null) {
  const claimToken = requestedClaimToken || crypto.randomBytes(24).toString("base64url");
  const requestedToken = requestedClaimToken || "";
  const claimedAt = nowIso();
  const claimExpiresAt = new Date(Date.now() + taskClaimLeaseMs).toISOString();

  await db.exec("BEGIN");
  try {
    const result = await claimAssignedTaskStmt.run({
      id: taskId,
      taskVersion,
      scorer,
      claimToken,
      requestedClaimToken: requestedToken,
      claimedAt,
      claimExpiresAt,
    });
    if (result.changes !== 1) {
      const current = await selectTaskByIdStmt.get(taskId) as TaskRow | undefined;
      if (current?.status === "assigned" && current.scorer === scorer) {
        await assertProjectTasksUnlocked(current.projectId || current.subjectId);
        await db.exec("COMMIT");
        return current;
      }
      throw httpError(409, "任务状态已变更，请刷新后重试");
    }
    const claimedTask = await selectTaskByIdStmt.get(taskId);
    await db.exec("COMMIT");
    return claimedTask;
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

async function releaseTaskClaim(taskId: string, scorer: string, claimToken: unknown) {
  const token = parseTaskClaimToken(claimToken);
  if (!token) return { released: false };
  return {
    released: (await releaseTaskClaimStmt.run(
      taskId,
      taskVersion,
      scorer,
      token,
    )).changes === 1,
  };
}

async function completeAssignedTask(taskId: string, body: Record<string, unknown> = {}) {
  const timer = createStepTimer();
  const scorer = parseScorerName(body.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const task = await selectTaskByIdStmt.get(taskId) as TaskRow | undefined;
  timer.mark("selectTask");
  if (!task) throw httpError(404, "任务不存在");
  await assertProjectTasksUnlocked(task.projectId || task.subjectId);
  if (task.status === "completed") {
    if (task.scorer === scorer) {
      const completedTask = completedTaskResultDto(task);
      timer.mark("buildAlreadyCompletedResponse");
      timer.warnIfSlow("completeAssignedTask", {
        taskId,
        scorer,
        projectId: task.projectId || task.subjectId,
        alreadyCompleted: true,
      });
      return completedTask;
    }
    throw httpError(409, "该任务已完成");
  }
  if (task.status !== "assigned" || task.scorer !== scorer)
    throw httpError(403, "该任务未分配给当前打分人");
  if (body.projectId && String(body.projectId) !== (task.projectId || task.subjectId))
    throw httpError(400, "任务项目不匹配");

  const taskImageIds = (await selectTaskImageIdsStmt
    .all(task.id) as Array<{ imageId: string }>)
    .map((item) => item.imageId);
  timer.mark("selectTaskImageIds");
  const excludedImageIds = parseTaskExcludedImageIds(
    body.excludedImageIds,
    taskImageIds,
    task.taskType,
  );
  const correctImageIds = parseTaskCorrectImageIds(
    body.correctImageIds,
    taskImageIds,
    task.taskType,
    excludedImageIds,
  );
  const ranking = parseTaskRanking(
    body.ranking,
    taskImageIds,
    excludedImageIds,
  );
  const rankingRelations = parseTaskRankingRelations(
    body.rankingRelations,
    ranking,
  );
  const durationMs = parseTaskDuration(body.durationMs);
  const rankingActionCount = parseRankingActionCount(body.rankingActionCount);
  const behaviorTracked = hasTaskBehaviorTracking(body) || Boolean(task.behaviorTracked);
  const dragActionCount = parseTaskBehaviorCount(
    body.dragActionCount,
    "拖动次数",
    Number(task.dragActionCount || rankingActionCount),
  );
  const orderChanged = parseTaskBehaviorBoolean(
    body.orderChanged,
    "排序变化记录",
    Boolean(task.orderChanged) || rankingActionCount > 0 || dragActionCount > 0,
  );
  const largeImageOpened = Object.hasOwn(body, "largeImageOpened")
    ? parseLargeImageOpened(body.largeImageOpened)
    : Boolean(task.largeImageOpened);
  const largeImageOpenCount = parseTaskBehaviorCount(
    body.largeImageOpenCount,
    "大图查看次数",
    Number(task.largeImageOpenCount || (largeImageOpened ? 1 : 0)),
    10000,
  );
  const firstActionMs = Object.hasOwn(body, "firstActionMs")
    ? parseFirstActionMs(body.firstActionMs, durationMs)
    : task.firstActionMs ?? null;
  const pageBlurCount = parseTaskBehaviorCount(
    body.pageBlurCount,
    "页面失焦次数",
    Number(task.pageBlurCount || 0),
    10000,
  );
  const risk = behaviorTracked ? calculateTaskRisk({
    durationMs,
    rankingActionCount,
    dragActionCount,
    orderChanged,
    largeImageOpened,
    largeImageOpenCount,
    firstActionMs,
    pageBlurCount,
  }) : { score: 0, flags: [] };
  const submissionMode = parseTaskSubmissionMode(
    body.submissionMode,
    rankingActionCount,
    Object.hasOwn(body, "submissionMode") ||
      Object.hasOwn(body, "rankingActionCount"),
  );
  const completedAt = nowIso();
  const startedAt = new Date(Date.now() - durationMs).toISOString();
  const projectId = task.projectId || task.subjectId;
  timer.mark("validatePayload");

  await beginSynchronousTaskStatsTransaction();
  timer.mark("beginTransaction");
  try {
    const result = await completeAssignedTaskStmt.run({
      id: task.id,
      scorer,
      ranking: JSON.stringify(ranking),
      excludedImageIds: JSON.stringify(excludedImageIds),
      correctImageIds: JSON.stringify(correctImageIds),
      rankingRelations: JSON.stringify(rankingRelations),
      submissionMode,
      rankingActionCount,
      dragActionCount,
      orderChanged,
      largeImageOpened,
      largeImageOpenCount,
      startedAt,
      completedAt,
      durationMs,
      firstActionMs,
      pageBlurCount,
      behaviorTracked,
      riskScore: risk.score,
      riskFlags: JSON.stringify(risk.flags),
      updatedAt: completedAt,
    });
    timer.mark("updateTask");
    if (result.changes === 0)
      throw httpError(409, "任务状态已变更，请刷新后重试");
    await recordTaskStatsEvents({
      eventType: "task_completed",
      oldTask: task,
      newTask: {
        ...task,
        status: "completed",
        scorer,
        projectId,
        submissionMode,
        rankingActionCount,
        dragActionCount,
        orderChanged,
        largeImageOpened,
        largeImageOpenCount,
        startedAt,
        completedAt,
        durationMs,
        firstActionMs,
        pageBlurCount,
        behaviorTracked,
        riskScore: risk.score,
        updatedAt: completedAt,
      },
      createdAt: completedAt,
    });
    timer.mark("appendStatsEvent");
    await db.exec("COMMIT");
    timer.mark("commit");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTaskSummaryCaches(projectId);
  invalidateScorerQueryCaches();
  timer.mark("invalidateCaches");
  const persistedTask = await selectTaskByIdStmt.get(task.id) as TaskRow | undefined;
  if (!persistedTask || persistedTask.status !== "completed") {
    throw new Error("任务提交后状态校验失败，请刷新后重试");
  }
  const completedTask = completedTaskResultDto(persistedTask);
  timer.mark("buildResponse");
  timer.warnIfSlow("completeAssignedTask", { taskId: task.id, scorer, projectId });
  return completedTask;
}

async function updateCompletedTask(taskId: string, body: Record<string, unknown> = {}) {
  const scorer = parseScorerName(body.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const task = await selectTaskByIdStmt.get(taskId) as TaskRow | undefined;
  if (!task) throw httpError(404, "任务不存在");
  await assertProjectTasksUnlocked(task.projectId || task.subjectId);
  if (task.status !== "completed" || task.scorer !== scorer)
    throw httpError(403, "只能修改已分配给当前打分人的已完成任务");
  if (body.projectId && String(body.projectId) !== (task.projectId || task.subjectId))
    throw httpError(400, "任务项目不匹配");

  const taskImageIds = (await selectTaskImageIdsStmt
    .all(task.id) as Array<{ imageId: string }>)
    .map((item) => item.imageId);
  const excludedImageIds = parseTaskExcludedImageIds(
    body.excludedImageIds,
    taskImageIds,
    task.taskType,
  );
  const correctImageIds = parseTaskCorrectImageIds(
    body.correctImageIds,
    taskImageIds,
    task.taskType,
    excludedImageIds,
  );
  const ranking = parseTaskRanking(
    body.ranking,
    taskImageIds,
    excludedImageIds,
  );
  const rankingRelations = parseTaskRankingRelations(
    body.rankingRelations,
    ranking,
  );
  const rankingActionCount = parseRankingActionCount(body.rankingActionCount);
  const durationMs = parseTaskDuration(body.durationMs);
  const behaviorTracked = hasTaskBehaviorTracking(body) || Boolean(task.behaviorTracked);
  const dragActionCount = parseTaskBehaviorCount(
    body.dragActionCount,
    "拖动次数",
    Number(task.dragActionCount || rankingActionCount),
  );
  const orderChanged = parseTaskBehaviorBoolean(
    body.orderChanged,
    "排序变化记录",
    Boolean(task.orderChanged) || rankingActionCount > 0 || dragActionCount > 0,
  );
  const largeImageOpened = Object.hasOwn(body, "largeImageOpened")
    ? parseLargeImageOpened(body.largeImageOpened)
    : Boolean(task.largeImageOpened);
  const largeImageOpenCount = parseTaskBehaviorCount(
    body.largeImageOpenCount,
    "大图查看次数",
    Number(task.largeImageOpenCount || (largeImageOpened ? 1 : 0)),
    10000,
  );
  const firstActionMs = Object.hasOwn(body, "firstActionMs")
    ? parseFirstActionMs(body.firstActionMs, durationMs)
    : task.firstActionMs ?? null;
  const pageBlurCount = parseTaskBehaviorCount(
    body.pageBlurCount,
    "页面失焦次数",
    Number(task.pageBlurCount || 0),
    10000,
  );
  const risk = behaviorTracked ? calculateTaskRisk({
    durationMs,
    rankingActionCount,
    dragActionCount,
    orderChanged,
    largeImageOpened,
    largeImageOpenCount,
    firstActionMs,
    pageBlurCount,
  }) : { score: 0, flags: [] };
  const submissionMode = parseTaskSubmissionMode(
    body.submissionMode,
    rankingActionCount,
    Object.hasOwn(body, "submissionMode") ||
      Object.hasOwn(body, "rankingActionCount"),
  );
  const editedAt = nowIso();

  await beginSynchronousTaskStatsTransaction();
  try {
    const result = await updateCompletedTaskStmt.run({
      id: task.id,
      scorer,
      ranking: JSON.stringify(ranking),
      excludedImageIds: JSON.stringify(excludedImageIds),
      correctImageIds: JSON.stringify(correctImageIds),
      rankingRelations: JSON.stringify(rankingRelations),
      submissionMode,
      rankingActionCount,
      dragActionCount,
      orderChanged,
      largeImageOpened,
      largeImageOpenCount,
      firstActionMs,
      pageBlurCount,
      behaviorTracked,
      riskScore: risk.score,
      riskFlags: JSON.stringify(risk.flags),
      editedAt,
      updatedAt: editedAt,
    });
    if (result.changes === 0)
      throw httpError(409, "任务状态已变更，请刷新后重试");
    await recordTaskStatsEvents({
      eventType: "task_completed_updated",
      oldTask: task,
      newTask: {
        ...task,
        status: "completed",
        scorer,
        submissionMode,
        rankingActionCount,
        dragActionCount,
        orderChanged,
        largeImageOpened,
        largeImageOpenCount,
        firstActionMs,
        pageBlurCount,
        behaviorTracked,
        riskScore: risk.score,
        editedAt,
        updatedAt: editedAt,
      },
      createdAt: editedAt,
    });
    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  const projectId = task.projectId || task.subjectId;
  invalidateTaskSummaryCaches(projectId);
  invalidateScorerQueryCaches();
  const updated = await selectTaskByIdStmt.get(task.id) as TaskRow;
  return (await hydrateTaskRows([updated]))[0];
}

  return { claimTaskForScorer, releaseTaskClaim, completeAssignedTask, updateCompletedTask };
}
