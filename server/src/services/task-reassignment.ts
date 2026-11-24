import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type Allocation = { scorer: string; taskCount: number };
type ReassignmentTask = { id: string; taskType?: string };
type ReassignmentBody = {
  source?: unknown;
  scorers?: unknown;
  taskCount?: unknown;
  allocations?: unknown;
  sourceScorers?: unknown;
};

export function createTaskReassignmentService({
    getProjectOrThrow, getProjectTaskStats, selectAvailableSubjectScorersStmt,
    userDto, selectSubjectAssignedScorerCountsStmt, taskVersion,
    parseTaskAssignees, selectSubjectScorerNamesStmt, httpError,
    normalizeUsername, selectReassignableTaskIdsStmt,
    selectReassignableTaskIdsByScorerStmt, buildDimensionAwareAssignmentPlan,
    nowIso, beginTaskWriteTransaction, TASK_ASSIGN_BATCH_SIZE, db,
    placeholders, refreshProjectTaskStats, invalidateTaskSummaryCaches,
    invalidateScorerQueryCaches,
}: {
  getProjectOrThrow: (id: string) => Promise<unknown>;
  getProjectTaskStats: (id: string) => Promise<{ pending: number; assigned: number }>;
  selectAvailableSubjectScorersStmt: Statement;
  userDto: (row: Record<string, unknown>) => Promise<unknown>;
  selectSubjectAssignedScorerCountsStmt: Statement;
  taskVersion: string;
  parseTaskAssignees: (value: unknown) => Promise<{ names: string[] }>;
  selectSubjectScorerNamesStmt: Statement;
  httpError: (status: number, message: string) => Error;
  normalizeUsername: (value: unknown) => string;
  selectReassignableTaskIdsStmt: Statement;
  selectReassignableTaskIdsByScorerStmt: Statement;
  buildDimensionAwareAssignmentPlan: (tasks: ReassignmentTask[], allocations: Allocation[]) => string[];
  nowIso: () => string;
  beginTaskWriteTransaction: () => Promise<void>;
  TASK_ASSIGN_BATCH_SIZE: number;
  db: typeof database;
  placeholders: (length: number) => string;
  refreshProjectTaskStats: (id: string) => Promise<unknown>;
  invalidateTaskSummaryCaches: (id: string) => void;
  invalidateScorerQueryCaches: () => void;
}) {
async function getTaskReassignmentOptions(subjectId: string) {
  await getProjectOrThrow(subjectId);
  const stats = await getProjectTaskStats(subjectId);

  return {
    users: await Promise.all(
      (await selectAvailableSubjectScorersStmt.all(subjectId)).map(userDto),
    ),
    availableTaskCount: stats.pending,
    sourceScorers: (await selectSubjectAssignedScorerCountsStmt
      .all(subjectId, taskVersion))
      .map((row) => ({ username: row.scorer, taskCount: row.taskCount })),
  };
}

async function reassignSubjectTasks(subjectId: string, body: ReassignmentBody = {}) {
  await getProjectOrThrow(subjectId);

  const source = String(body.source || "");
  if (source !== "assigned_uncompleted" && source !== "selected_scorers") {
    throw httpError(400, "任务来源不正确");
  }

  const assignees = await parseTaskAssignees(body.scorers);
  const existingScorers = new Set(
    (await selectSubjectScorerNamesStmt.all(subjectId)).map((row) => String(row.scorer)),
  );
  const existingAssignees = assignees.names.filter((name) =>
    existingScorers.has(name),
  );
  if (existingAssignees.length) {
    throw httpError(
      400,
      `以下账号已属于当前项目：${existingAssignees.join("、")}`,
    );
  }

  let taskCount = Number(body.taskCount);
  if (!Number.isInteger(taskCount) || taskCount < 1) {
    throw httpError(400, "任务数量必须为正整数");
  }
  if (source === "assigned_uncompleted" && taskCount < assignees.names.length) {
    throw httpError(400, "任务数量不能少于所选打分人数");
  }

  const availableTaskCount = source === "assigned_uncompleted"
    ? (await getProjectTaskStats(subjectId)).pending
    : (await getProjectTaskStats(subjectId)).assigned;
  let targetAllocations = null;
  if (source === "assigned_uncompleted") {
    if (!Array.isArray(body.allocations)) {
      throw httpError(400, "请按打分人分别设置任务数量");
    }
    const allocationMap = new Map<string, number>();
    body.allocations.forEach((item) => {
      const scorer = normalizeUsername(item?.scorer);
      const count = Number(item?.taskCount);
      if (!assignees.names.includes(scorer)) {
        throw httpError(400, `打分人 ${scorer} 不在本次新增账号列表中`);
      }
      if (allocationMap.has(scorer)) {
        throw httpError(400, `打分人 ${scorer} 重复设置`);
      }
      if (!Number.isInteger(count) || count < 0) {
        throw httpError(400, `打分人 ${scorer} 的任务数量必须是非负整数`);
      }
      allocationMap.set(scorer, count);
    });
    const allocations = assignees.names.map((scorer) => ({
      scorer,
      taskCount: allocationMap.get(scorer) ?? 0,
    }));
    taskCount = allocations.reduce(
      (total, allocation) => total + allocation.taskCount,
      0,
    );
    if (!taskCount) {
      throw httpError(400, "请至少为一名打分人设置任务数量");
    }
    targetAllocations = allocations;
  }
  let selectedTasks;
  if (source === "assigned_uncompleted") {
    const candidates = await selectReassignableTaskIdsStmt.all(subjectId, taskVersion, taskCount);
    if (taskCount > candidates.length) {
      throw httpError(400, `任务数量不能超过 ${candidates.length}`);
    }

    selectedTasks = candidates as ReassignmentTask[];
  } else {
    const sourceScorers = [
      ...new Set(
        (Array.isArray(body.sourceScorers)
          ? body.sourceScorers
          : String(body.sourceScorers || "").split(",")
        )
          .filter(Boolean)
          .map(normalizeUsername),
      ),
    ];
    if (!sourceScorers.length) {
      throw httpError(400, "请选择已分配打分人");
    }

    const sourceCounts = new Map<string, number>(
      (await selectSubjectAssignedScorerCountsStmt
        .all(subjectId, taskVersion))
        .map((row) => [String(row.scorer), Number(row.taskCount)]),
    );
    const invalidScorers = sourceScorers.filter(
      (scorer) => !sourceCounts.has(scorer),
    );
    if (invalidScorers.length) {
      throw httpError(
        400,
        `以下打分人没有可领取的未完成任务：${invalidScorers.join("、")}`,
      );
    }

    selectedTasks = (await Promise.all(sourceScorers.map(async scorer => {
      const candidates = await selectReassignableTaskIdsByScorerStmt.all(subjectId, taskVersion, scorer, taskCount);
      if (taskCount > candidates.length) {
        throw httpError(
          400,
          `打分人 ${scorer} 的未完成任务不足 ${taskCount} 个`,
        );
      }
      return candidates as ReassignmentTask[];
    }))).flat();
  }

  if (selectedTasks.length < assignees.names.length) {
    throw httpError(400, "任务数量不能少于所选打分人数");
  }
  if (!targetAllocations) {
    const baseCount = Math.floor(selectedTasks.length / assignees.names.length);
    const remainder = selectedTasks.length % assignees.names.length;
    targetAllocations = assignees.names.map((scorer, index) => ({
      scorer,
      taskCount: baseCount + (index < remainder ? 1 : 0),
    }));
  }
  const assignmentPlan = buildDimensionAwareAssignmentPlan(
    selectedTasks,
    targetAllocations,
  );
  const updatedAt = nowIso();
  const distribution: Record<string, number> = Object.fromEntries(
    assignees.names.map((name) => [name, 0]),
  );

  await beginTaskWriteTransaction();
  try {
    for (let start = 0; start < selectedTasks.length; start += TASK_ASSIGN_BATCH_SIZE) {
      const batch = selectedTasks.slice(start, start + TASK_ASSIGN_BATCH_SIZE);
      const whenClauses = batch.map(() => "WHEN ? THEN ?");
      const taskIds = batch.map((task) => task.id);
      const assignmentParams: string[] = [];
      batch.forEach((task, index) => {
        assignmentParams.push(task.id, assignmentPlan[start + index]);
      });
      assignmentParams.push(updatedAt, subjectId, taskVersion, ...taskIds);
      const result = await db.prepare(
        `UPDATE rating_tasks
         SET scorer = CASE id ${whenClauses.join(" ")} ELSE scorer END,
             status = ${source === "assigned_uncompleted" ? "'assigned'" : "status"},
             updatedAt = ?
         WHERE projectId = ?
           AND taskVersion = ?
           AND status = ${source === "assigned_uncompleted" ? "'pending'" : "'assigned'"}
           AND id IN (${placeholders(batch.length)})`,
      ).run(...assignmentParams);
      if (result.changes !== batch.length) {
        throw httpError(409, "任务状态已变更，请刷新后重试");
      }
      batch.forEach((_task, index) => {
        distribution[assignmentPlan[start + index]]++;
      });
    }
    await refreshProjectTaskStats(subjectId);
    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTaskSummaryCaches(subjectId);
  invalidateScorerQueryCaches();
  return {
    reassignedCount: selectedTasks.length,
    remainingTaskCount: availableTaskCount - selectedTasks.length,
    distribution,
  };
}

  return { getTaskReassignmentOptions, reassignSubjectTasks };
}
