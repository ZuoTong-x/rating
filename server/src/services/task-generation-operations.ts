import type { db as database } from "../postgres.ts";

type SelectedTask = { id: string };
type OperationsDependencies = {
  httpError: (status: number, message: string) => Error;
  nowIso: () => string;
  TASK_ASSIGN_BATCH_SIZE: number;
  beginTaskWriteTransaction: () => Promise<void>;
  db: typeof database;
  placeholders: (length: number) => string;
  yieldToEventLoop: () => Promise<void>;
  invalidateTaskSummaryCaches: (projectId: string) => void;
  invalidateScorerQueryCaches: () => void;
  TASK_WRITE_BATCH_SIZE: number;
  updateProjectTaskStatusStmt: ReturnType<typeof database.prepare>;
};

export function createTaskGenerationOperations({
    httpError, nowIso, TASK_ASSIGN_BATCH_SIZE, beginTaskWriteTransaction,
    db, placeholders, yieldToEventLoop, invalidateTaskSummaryCaches,
    invalidateScorerQueryCaches, TASK_WRITE_BATCH_SIZE, updateProjectTaskStatusStmt,
}: OperationsDependencies) {
async function assignGeneratedTasks(
  projectId: string,
  selectedTasks: SelectedTask[],
  assigneePlan: string[],
  onProgress?: (processed: number, total: number) => void,
) {
  if (!selectedTasks.length) {
    return {
      assignedCount: 0,
      taskIds: [],
    };
  }
  if (selectedTasks.length !== assigneePlan.length) {
    throw httpError(409, "待分配任务数量与人员计划不一致，请刷新后重试");
  }
  const updatedAt = nowIso();
  const assignedTaskIds: string[] = [];

  for (let start = 0; start < selectedTasks.length; start += TASK_ASSIGN_BATCH_SIZE) {
    const batch = selectedTasks.slice(start, start + TASK_ASSIGN_BATCH_SIZE);
    await beginTaskWriteTransaction();
    try {
      const whenClauses = batch.map(() => "WHEN ? THEN ?");
      const taskIds = batch.map((task) => task.id);
      const assignmentParams: string[] = [];
      batch.forEach((task, index) => {
        assignmentParams.push(task.id, assigneePlan[start + index]);
      });
      assignmentParams.push(updatedAt, ...taskIds);
      const result = await db
        .prepare(
          `UPDATE rating_tasks
           SET scorer = CASE id ${whenClauses.join(" ")} ELSE scorer END,
               status = 'assigned',
               updatedAt = ?
           WHERE status = 'pending'
             AND id IN (${placeholders(batch.length)})`,
        )
        .run(...assignmentParams);
      if (result.changes !== batch.length) {
        throw httpError(409, "任务状态已变更，请刷新后重试");
      }
      await db.exec("COMMIT");
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    assignedTaskIds.push(...batch.map((task) => task.id));
    const processed = start + batch.length;
    onProgress?.(processed, selectedTasks.length);
    if (processed < selectedTasks.length) await yieldToEventLoop();
  }

  invalidateTaskSummaryCaches(projectId);
  invalidateScorerQueryCaches();
  return {
    assignedCount: selectedTasks.length,
    taskIds: assignedTaskIds,
  };
}

async function rollbackGeneratedTasks(
  projectId: string,
  taskIds: string[],
  previousTaskStatus: string,
  assignedTaskIds: string[] = [],
) {
  try {
    for (let start = 0; start < assignedTaskIds.length; start += TASK_ASSIGN_BATCH_SIZE) {
      const batch = assignedTaskIds.slice(start, start + TASK_ASSIGN_BATCH_SIZE);
      await beginTaskWriteTransaction();
      try {
        const result = await db.prepare(
          `UPDATE rating_tasks
           SET status = 'pending',
               scorer = NULL,
               updatedAt = ?
           WHERE projectId = ?
             AND id IN (${placeholders(batch.length)})
             AND status = 'assigned'`,
        ).run(nowIso(), projectId, ...batch);
        if (result.changes !== batch.length) {
          throw httpError(409, "已有任务状态变化，停止自动回滚");
        }
        await db.exec("COMMIT");
      } catch (error) {
        try {
          await db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    }
    for (let start = 0; start < taskIds.length; start += TASK_WRITE_BATCH_SIZE) {
      const batch = taskIds.slice(start, start + TASK_WRITE_BATCH_SIZE);
      await beginTaskWriteTransaction();
      try {
        const result = await db.prepare(
          `DELETE FROM rating_tasks
           WHERE projectId = ?
             AND id IN (${placeholders(batch.length)})
             AND status IN ('pending', 'assigned')`,
        ).run(projectId, ...batch);
        if (result.changes !== batch.length) {
          throw httpError(409, "已有任务完成或状态变化，停止自动回滚");
        }
        await db.exec("COMMIT");
      } catch (error) {
        try {
          await db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    }
    await updateProjectTaskStatusStmt.run({
      id: projectId,
      taskStatus: previousTaskStatus,
      updatedAt: nowIso(),
    });
    invalidateTaskSummaryCaches(projectId);
    invalidateScorerQueryCaches();
    return true;
  } catch (cleanupError) {
    console.error(`Failed to roll back generated tasks for ${projectId}`, cleanupError);
    return false;
  }
}

  return { assignGeneratedTasks, rollbackGeneratedTasks };
}
