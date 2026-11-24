import crypto from "node:crypto";
import type { db as database } from "../postgres.ts";

type TemplateItem = { imageId: string; position: number; role: string };
type TemplateItemRow = TemplateItem & { templateId: string };
type TemplateRow = {
  id: string;
  subjectId: string;
  sourceTaskId: string;
  round: number;
  criterion: string;
  imageKey: string;
  selectionKey?: number;
};
type TaskTemplate = TemplateRow & { items: TemplateItem[]; packageId: string };
type GeneratedTaskItem = { taskId: string; imageId: string; position: number; role: string };
export type GeneratedTask = {
  id: string;
  subjectId: string;
  projectId: string;
  taskVersion: string;
  round: number;
  taskType: string;
  status: string;
  scorer: string | null;
  ranking: null;
  assignmentKey: number;
  imageKey: string;
  isBacktest: boolean;
  backtestSourceId: string | null;
  createdAt: string;
  updatedAt: string;
  items: GeneratedTaskItem[];
};
type BacktestSource = {
  id: string;
  subjectId: string;
  round: number;
  taskType: string;
  imageKey: string;
  items: Array<{ imageId: string; position: number; role: string }>;
};
type Allocation = { scorer: string; taskCount: number };
type BacktestAllocation = Allocation & { baseTaskCount: number; backtestTaskCount: number };
type AssignmentCandidate = { criterion?: string; taskType?: string };
type GeneratedTaskOptions = { taskType?: string; id?: string; isBacktest?: boolean; backtestSourceId?: string };

export function createTaskGenerationTemplatesService({
    TASK_WRITE_BATCH_SIZE, beginTaskWriteTransaction, db, httpError,
    nowIso, placeholders, projectPackageIds, selectProjectByIdStmt,
    selectSubjectTaskTemplatesStmt, taskVersion, yieldToEventLoop,
}: {
  TASK_WRITE_BATCH_SIZE: number;
  beginTaskWriteTransaction: () => Promise<void>;
  db: typeof database;
  httpError: (status: number, message: string) => Error;
  nowIso: () => string;
  placeholders: (count: number) => string;
  projectPackageIds: (project: Record<string, unknown>) => Promise<string[]>;
  selectProjectByIdStmt: ReturnType<typeof database.prepare>;
  selectSubjectTaskTemplatesStmt: ReturnType<typeof database.prepare>;
  taskVersion: string;
  yieldToEventLoop: () => Promise<void>;
}) {
function deterministicTaskId(projectId: string, taskType: string, imageIds: string[]) {
  const imageKey = [...imageIds].sort().join("|");
  return crypto
    .createHash("sha256")
    .update(`${projectId}|${taskVersion}|${taskType}|${imageKey}`)
    .digest("hex");
}

function seededShuffle<T>(items: T[], seedText: string) {
  const output = [...items];
  const seedBytes = crypto.createHash("sha256").update(seedText).digest();
  let state = seedBytes.readUInt32BE(0) || 1;

  const nextRandom = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  for (let index = output.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function dimensionTaskType(projectId: string, packageId: string, criterion: string) {
  const baseType = `dimension:${criterion}`;
  // Legacy projects use the original key. New projects can safely share a
  // package because the legacy unique index also sees the project suffix.
  return projectId === packageId ? baseType : `${baseType}:project:${projectId}`;
}

async function hydrateSubjectTaskTemplates(templates: TemplateRow[]): Promise<Array<TemplateRow & { items: TemplateItem[] }>> {
  if (!templates.length) return [];

  const templateIds = templates.map((template) => template.id);
  // Keep large imports bounded by loading template items in batches.
  const itemRows: TemplateItemRow[] = [];
  const itemRowsStmtCache = new Map<number, ReturnType<typeof database.prepare>>();
  for (let start = 0; start < templateIds.length; start += 500) {
    const batch = templateIds.slice(start, start + 500);
    let stmt = itemRowsStmtCache.get(batch.length);
    if (!stmt) {
      stmt = db.prepare(
        `SELECT templateId, imageId, position, role
         FROM subject_task_template_items
         WHERE templateId IN (${placeholders(batch.length)})
         ORDER BY templateId ASC, position ASC, imageId ASC`,
      );
      itemRowsStmtCache.set(batch.length, stmt);
    }
    itemRows.push(...(await stmt.all(...batch) as TemplateItemRow[]));
    if (start + batch.length < templateIds.length) {
      await yieldToEventLoop();
    }
  }
  const itemsByTemplateId = new Map<string, TemplateItem[]>();
  itemRows.forEach((item) => {
    const items = itemsByTemplateId.get(item.templateId) || [];
    items.push(item);
    itemsByTemplateId.set(item.templateId, items);
  });

  return templates.map((template) => ({
    ...template,
    items: itemsByTemplateId.get(template.id) || [],
  }));
}

async function loadSubjectTaskTemplates(subjectId: string, limit: number | null = null) {
  const templates = limit == null
    ? await selectSubjectTaskTemplatesStmt.all(subjectId)
    : await db.prepare(`
        SELECT id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey
        FROM subject_task_templates
        WHERE subjectId = ?
        ORDER BY selectionKey ASC, id ASC
        LIMIT ?
      `).all(subjectId, limit);
  return hydrateSubjectTaskTemplates(templates as TemplateRow[]);
}

async function loadProjectTaskTemplates(projectId: string): Promise<TaskTemplate[]> {
  const project = await selectProjectByIdStmt.get(projectId);
  if (!project) throw httpError(404, "项目不存在");
  const packageIds = await projectPackageIds(project);
  if (!packageIds.length) return [];

  const templates = [];
  for (const packageId of packageIds) {
    const packageTemplates = await loadSubjectTaskTemplates(packageId);
    templates.push(...packageTemplates.map((template) => ({
      ...template,
      packageId,
    })));
    await yieldToEventLoop();
  }
  return templates;
}

async function loadUnmaterializedProjectTaskTemplates(projectId: string, limit: number, options: { materializedBaseCount?: number } = {}): Promise<TaskTemplate[]> {
  const requestedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!requestedLimit) return [];

  const project = await selectProjectByIdStmt.get(projectId);
  if (!project) throw httpError(404, "项目不存在");
  const packageIds = await projectPackageIds(project);
  if (!packageIds.length) return [];

  const directTemplateSql = `
    SELECT
      subject_task_templates.id,
      subject_task_templates.subjectId,
      subject_task_templates.sourceTaskId,
      subject_task_templates.round,
      subject_task_templates.criterion,
      subject_task_templates.imageKey
    FROM subject_task_templates
  `;
  const templates = options.materializedBaseCount === 0
    ? await db.prepare(`
      ${directTemplateSql}
      WHERE subject_task_templates.subjectId IN (${placeholders(packageIds.length)})
      ORDER BY subject_task_templates.selectionKey ASC,
               subject_task_templates.id ASC
      LIMIT ?
    `).all(...packageIds, requestedLimit)
    : await db.prepare(`
    ${directTemplateSql}
    LEFT JOIN rating_tasks
      ON rating_tasks.projectId = ?
     AND rating_tasks.taskVersion = ?
     AND rating_tasks.subjectId = subject_task_templates.subjectId
     AND rating_tasks.round = subject_task_templates.round
     AND rating_tasks.taskType = CASE
       WHEN subject_task_templates.subjectId = ?
         THEN 'dimension:' || subject_task_templates.criterion
       ELSE 'dimension:' || subject_task_templates.criterion || ':project:' || ?
     END
     AND rating_tasks.imageKey = subject_task_templates.imageKey
    WHERE subject_task_templates.subjectId IN (${placeholders(packageIds.length)})
      AND rating_tasks.id IS NULL
    ORDER BY subject_task_templates.selectionKey ASC,
             subject_task_templates.id ASC
    LIMIT ?
  `).all(
    projectId,
    taskVersion,
    projectId,
    projectId,
    ...packageIds,
    requestedLimit
  );

  return (await hydrateSubjectTaskTemplates(templates as TemplateRow[])).map((template) => ({
    ...template,
    packageId: template.subjectId,
  }));
}

async function loadProjectTaskTemplatesBySourceTaskIds(projectId: string, sourceTaskIds: string[]): Promise<TaskTemplate[]> {
  if (!sourceTaskIds.length) return [];

  const project = await selectProjectByIdStmt.get(projectId);
  if (!project) throw httpError(404, "项目不存在");
  const packageIds = await projectPackageIds(project);
  if (!packageIds.length) return [];

  const templateRows: TemplateRow[] = [];
  for (let start = 0; start < sourceTaskIds.length; start += 500) {
    const batch = sourceTaskIds.slice(start, start + 500);
    templateRows.push(...(await db.prepare(`
      SELECT id, subjectId, sourceTaskId, round, criterion, imageKey
      FROM subject_task_templates
      WHERE subjectId IN (${placeholders(packageIds.length)})
        AND sourceTaskId IN (${placeholders(batch.length)})
    `).all(...packageIds, ...batch) as TemplateRow[]));
    if (start + batch.length < sourceTaskIds.length) await yieldToEventLoop();
  }

  const rowsBySourceTaskId = new Map<string, TemplateRow[]>();
  templateRows.forEach((row) => {
    const rows = rowsBySourceTaskId.get(row.sourceTaskId) || [];
    rows.push(row);
    rowsBySourceTaskId.set(row.sourceTaskId, rows);
  });
  const missing = sourceTaskIds.filter((sourceTaskId) => !rowsBySourceTaskId.has(sourceTaskId));
  if (missing.length) {
    throw httpError(
      400,
      `清单中有 ${missing.length} 个 sourceTaskId 不属于当前项目图包，示例：${missing.slice(0, 5).join("、")}`,
    );
  }
  const ambiguous = sourceTaskIds.filter(
    (sourceTaskId) => rowsBySourceTaskId.get(sourceTaskId)!.length !== 1,
  );
  if (ambiguous.length) {
    throw httpError(
      400,
      `清单中有 ${ambiguous.length} 个 sourceTaskId 在关联图包中不唯一，示例：${ambiguous.slice(0, 5).join("、")}`,
    );
  }

  const orderedRows = sourceTaskIds.map((sourceTaskId) => rowsBySourceTaskId.get(sourceTaskId)![0]);
  return (await hydrateSubjectTaskTemplates(orderedRows)).map((template) => ({
    ...template,
    packageId: template.subjectId,
  }));
}

function buildGeneratedTaskRecord(projectId: string, template: TaskTemplate, scorer: string | null, options: GeneratedTaskOptions = {}): GeneratedTask {
  const imageIds = template.items.map((item) => item.imageId);
  const taskType = options.taskType || dimensionTaskType(projectId, template.packageId, template.criterion);
  const id = options.id || deterministicTaskId(projectId, taskType, imageIds);
  const now = nowIso();
  return {
    id,
    subjectId: template.packageId,
    projectId,
    taskVersion,
    round: Number(template.round || 1),
    taskType,
    status: scorer ? "assigned" : "pending",
    scorer: scorer || null,
    ranking: null,
    assignmentKey: crypto.randomInt(1, 2147483647),
    imageKey: template.imageKey,
    isBacktest: Boolean(options.isBacktest),
    backtestSourceId: options.backtestSourceId || null,
    createdAt: now,
    updatedAt: now,
    items: template.items.map((item) => ({
      taskId: id,
      imageId: item.imageId,
      position: item.position,
      role: item.role,
    })),
  };
}

async function bulkInsertRatingTasks(taskRows: GeneratedTask[]) {
  if (!taskRows.length) return 0;
  const sql = `
    INSERT INTO rating_tasks (
      id, subjectId, projectId, taskVersion, round, taskType, status, scorer, ranking, assignmentKey, imageKey, isBacktest, backtestSourceId, createdAt, updatedAt
    ) VALUES ${taskRows.map(() => `(${placeholders(15)})`).join(", ")}
    ON CONFLICT DO NOTHING
  `;
  const params: unknown[] = [];
  taskRows.forEach((row) => {
    params.push(
      row.id,
      row.subjectId,
      row.projectId,
      row.taskVersion,
      row.round,
      row.taskType,
      row.status,
      row.scorer,
      row.ranking,
      row.assignmentKey,
      row.imageKey,
      Boolean(row.isBacktest),
      row.backtestSourceId || null,
      row.createdAt,
      row.updatedAt,
    );
  });
  return (await db.prepare(sql).run(...params)).changes;
}

async function bulkInsertRatingTaskItems(itemRows: GeneratedTaskItem[]) {
  if (!itemRows.length) return 0;
  const sql = `
    INSERT INTO rating_task_items (taskId, imageId, position, role)
    VALUES ${itemRows.map(() => "(?, ?, ?, ?)").join(", ")}
    ON CONFLICT DO NOTHING
  `;
  const params: unknown[] = [];
  itemRows.forEach((row) => {
    params.push(row.taskId, row.imageId, row.position, row.role);
  });
  return (await db.prepare(sql).run(...params)).changes;
}

async function writeGeneratedTaskGroup(projectId: string, phase: string, taskRows: GeneratedTask[], groupNumber: number) {
  const startedAt = performance.now();
  try {
    await beginTaskWriteTransaction();
    const transactionStartedAt = performance.now();
    let inserted = 0;
    let itemCount = 0;
    let taskInsertMs = 0;
    let itemInsertMs = 0;
    let statementCount = 0;
    for (let start = 0; start < taskRows.length; start += TASK_WRITE_BATCH_SIZE) {
      const batch = taskRows.slice(start, start + TASK_WRITE_BATCH_SIZE);
      const itemRows = batch.flatMap((task) => task.items);
      const taskStartedAt = performance.now();
      const result = await bulkInsertRatingTasks(batch);
      taskInsertMs += performance.now() - taskStartedAt;
      if (result !== batch.length) {
        throw httpError(409, "任务在生成过程中发生变化，请核对实际任务后重试");
      }
      const itemsStartedAt = performance.now();
      await bulkInsertRatingTaskItems(itemRows);
      itemInsertMs += performance.now() - itemsStartedAt;
      inserted += result || 0;
      itemCount += itemRows.length;
      statementCount += 1;
    }
    const commitStartedAt = performance.now();
    await db.exec("COMMIT");
    const committedAt = performance.now();
    console.info(JSON.stringify({
      event: "task_generation_write_group",
      projectId,
      phase,
      groupNumber,
      tasks: taskRows.length,
      items: itemCount,
      statements: statementCount,
      transactionMs: Math.round(transactionStartedAt - startedAt),
      taskInsertMs: Math.round(taskInsertMs),
      itemInsertMs: Math.round(itemInsertMs),
      commitMs: Math.round(committedAt - commitStartedAt),
      totalMs: Math.round(committedAt - startedAt),
    }));
    return inserted;
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

async function loadTaskRecordsForBacktest(taskIds: string[]): Promise<BacktestSource[]> {
  if (!taskIds.length) return [];
  const taskRows: Array<Omit<BacktestSource, "items">> = [];
  const itemRows: Array<GeneratedTaskItem> = [];
  for (let start = 0; start < taskIds.length; start += TASK_WRITE_BATCH_SIZE) {
    const batch = taskIds.slice(start, start + TASK_WRITE_BATCH_SIZE);
    taskRows.push(
      ...(await db
        .prepare(
          `SELECT id, subjectId, projectId, taskVersion, round, taskType, status,
                  scorer, assignmentKey, imageKey, isBacktest, backtestSourceId,
                  createdAt, updatedAt
           FROM rating_tasks
           WHERE id IN (${placeholders(batch.length)})`,
        )
        .all(...batch) as Array<Omit<BacktestSource, "items">>),
    );
    itemRows.push(
      ...(await db
        .prepare(
          `SELECT taskId, imageId, position, role
           FROM rating_task_items
           WHERE taskId IN (${placeholders(batch.length)})
           ORDER BY taskId ASC, position ASC, imageId ASC`,
        )
        .all(...batch) as GeneratedTaskItem[]),
    );
  }

  const itemsByTaskId = new Map<string, TemplateItem[]>();
  itemRows.forEach((item) => {
    const currentItems = itemsByTaskId.get(item.taskId) || [];
    currentItems.push({
      imageId: item.imageId,
      position: item.position,
      role: item.role || "target",
    });
    itemsByTaskId.set(item.taskId, currentItems);
  });
  const taskById = new Map<string, BacktestSource>(taskRows.map((row) => [row.id, {
    ...row,
    items: itemsByTaskId.get(row.id) || [],
  }]));
  return taskIds.map((id) => taskById.get(id)).filter((task): task is BacktestSource => Boolean(task));
}

function taskDimensionKey(candidate: AssignmentCandidate) {
  if (candidate?.criterion) return String(candidate.criterion);
  const taskType = String(candidate?.taskType || "");
  const parts = taskType.split(":");
  return parts[0] === "dimension" && parts[1] ? parts[1] : taskType || "unknown";
}

function parseBacktestRatio(value: unknown) {
  if (value === undefined || value === null || value === "") return 0;
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 50) {
    throw httpError(400, "回测比例必须在 0 到 50 之间");
  }
  return Math.round(ratio * 100) / 100;
}

function backtestCountForAllocation(taskCount: number, backtestRatio: number) {
  if (!backtestRatio || taskCount <= 1) return 0;
  const requested = Math.floor((taskCount * backtestRatio) / 100);
  return Math.max(0, Math.min(requested, taskCount - 1));
}

function expandBacktestAllocations(allocations: Allocation[], backtestRatio: number): BacktestAllocation[] {
  return allocations.map((allocation) => {
    const backtestTaskCount = backtestCountForAllocation(
      allocation.taskCount,
      backtestRatio,
    );
    return {
      ...allocation,
      baseTaskCount: allocation.taskCount - backtestTaskCount,
      backtestTaskCount,
    };
  });
}

function randomShuffle<T>(items: T[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const selectedIndex = crypto.randomInt(0, index + 1);
    [shuffled[index], shuffled[selectedIndex]] = [shuffled[selectedIndex], shuffled[index]];
  }
  return shuffled;
}

function buildBacktestTaskRecord(projectId: string, sourceTask: BacktestSource, scorer: string): GeneratedTask {
  const id = crypto.randomUUID();
  const now = nowIso();
  return {
    id,
    subjectId: sourceTask.subjectId,
    projectId,
    taskVersion,
    round: Number(sourceTask.round || 1),
    taskType: `${sourceTask.taskType}:backtest:${id}`,
    status: "assigned",
    scorer,
    ranking: null,
    assignmentKey: crypto.randomInt(1, 2147483647),
    imageKey: sourceTask.imageKey,
    isBacktest: true,
    backtestSourceId: sourceTask.id,
    createdAt: now,
    updatedAt: now,
    items: (sourceTask.items || []).map((item) => ({
      taskId: id,
      imageId: item.imageId,
      position: item.position,
      role: item.role || "target",
    })),
  };
}

function buildBacktestTaskRows(backtestAllocations: BacktestAllocation[], baseTasksByScorer: Map<string, BacktestSource[]>, projectId: string): GeneratedTask[] {
  const rows: GeneratedTask[] = [];
  for (const allocation of backtestAllocations) {
    if (!allocation.backtestTaskCount) continue;
    const sourceTasks = baseTasksByScorer.get(allocation.scorer) || [];
    if (sourceTasks.length < allocation.backtestTaskCount) {
      throw httpError(409, `打分人 ${allocation.scorer} 的基础任务不足，无法生成回测任务`);
    }
    randomShuffle(sourceTasks)
      .slice(0, allocation.backtestTaskCount)
      .forEach((sourceTask) => {
        if (!sourceTask.items?.length) {
          throw httpError(409, `任务 ${sourceTask.id} 缺少图片项，无法生成回测任务`);
        }
        rows.push(buildBacktestTaskRecord(projectId, sourceTask, allocation.scorer));
      });
  }
  return rows;
}

function buildDimensionAwareAssignmentPlan(candidates: AssignmentCandidate[], allocations: Allocation[]): string[] {
  const scorerNames: string[] = [];
  const targetCounts = new Map<string, number>();
  allocations.forEach((allocation) => {
    const taskCount = Math.max(0, Math.floor(Number(allocation.taskCount) || 0));
    if (!allocation.scorer || taskCount <= 0) return;
    if (!targetCounts.has(allocation.scorer)) scorerNames.push(allocation.scorer);
    targetCounts.set(
      allocation.scorer,
      (targetCounts.get(allocation.scorer) || 0) + taskCount,
    );
  });
  const totalTaskCount = scorerNames.reduce(
    (total, scorer) => total + (targetCounts.get(scorer) ?? 0),
    0,
  );
  if (candidates.length !== totalTaskCount) {
    throw httpError(409, "任务候选数量与分配数量不一致，请刷新后重试");
  }
  if (!totalTaskCount) return [];

  const groups = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const dimension = taskDimensionKey(candidate);
    const group = groups.get(dimension) || [];
    group.push(index);
    groups.set(dimension, group);
  });

  const assignedCounts = new Map<string, number>(scorerNames.map((scorer) => [scorer, 0]));
  const groupPlans: Array<{
    indexes: number[];
    quotas: Map<string, number>;
    remainders: Array<{ scorer: string; remainder: number }>;
    remaining: number;
  }> = [];

  for (const indexes of groups.values()) {
    const quotas = new Map<string, number>(scorerNames.map((scorer) => [scorer, 0]));
    const remainders: Array<{ scorer: string; remainder: number }> = [];
    let assignedInGroup = 0;

    for (const scorer of scorerNames) {
      const ideal = (indexes.length * (targetCounts.get(scorer) ?? 0)) / totalTaskCount;
      const base = Math.floor(ideal);
      quotas.set(scorer, base);
      assignedCounts.set(scorer, (assignedCounts.get(scorer) ?? 0) + base);
      assignedInGroup += base;
      remainders.push({ scorer, remainder: ideal - base });
    }

    groupPlans.push({
      indexes,
      quotas,
      remainders,
      remaining: indexes.length - assignedInGroup,
    });
  }

  const remainingCapacity = new Map<string, number>(scorerNames.map((scorer) => [
    scorer,
    (targetCounts.get(scorer) ?? 0) - (assignedCounts.get(scorer) ?? 0),
  ]));
  const remainderChoices: Array<{ groupIndex: number; scorer: string; remainder: number }> = [];
  groupPlans.forEach((groupPlan, groupIndex) => {
    if (groupPlan.remaining <= 0) return;
    groupPlan.remainders.forEach((item) => {
      remainderChoices.push({ groupIndex, ...item });
    });
  });

  remainderChoices.sort((left, right) => {
    const remainderDifference = right.remainder - left.remainder;
    if (Math.abs(remainderDifference) > Number.EPSILON) {
      return remainderDifference;
    }
    const capacityDifference =
      (remainingCapacity.get(right.scorer) || 0) -
      (remainingCapacity.get(left.scorer) || 0);
    if (capacityDifference) return capacityDifference;
    const targetDifference =
      (targetCounts.get(right.scorer) || 0) -
      (targetCounts.get(left.scorer) || 0);
    if (targetDifference) return targetDifference;
    const groupDifference = left.groupIndex - right.groupIndex;
    if (groupDifference) return groupDifference;
    return scorerNames.indexOf(left.scorer) - scorerNames.indexOf(right.scorer);
  });

  for (const choice of remainderChoices) {
    const groupPlan = groupPlans[choice.groupIndex];
    if (groupPlan.remaining <= 0) continue;
    const capacity = remainingCapacity.get(choice.scorer) || 0;
    if (capacity <= 0) continue;
    groupPlan.quotas.set(choice.scorer, (groupPlan.quotas.get(choice.scorer) ?? 0) + 1);
    groupPlan.remaining -= 1;
    remainingCapacity.set(choice.scorer, capacity - 1);
    assignedCounts.set(choice.scorer, (assignedCounts.get(choice.scorer) ?? 0) + 1);
  }

  for (const groupPlan of groupPlans) {
    while (groupPlan.remaining > 0) {
      const scorer = [...scorerNames]
        .filter((name) => (remainingCapacity.get(name) || 0) > 0)
        .sort((left, right) => {
          const capacityDifference =
            (remainingCapacity.get(right) || 0) -
            (remainingCapacity.get(left) || 0);
          if (capacityDifference) return capacityDifference;
          const targetDifference =
            (targetCounts.get(right) || 0) -
            (targetCounts.get(left) || 0);
          if (targetDifference) return targetDifference;
          return scorerNames.indexOf(left) - scorerNames.indexOf(right);
        })[0];
      if (!scorer) throw httpError(409, "维度任务分配失败，请刷新后重试");
      groupPlan.quotas.set(scorer, (groupPlan.quotas.get(scorer) ?? 0) + 1);
      groupPlan.remaining -= 1;
      remainingCapacity.set(scorer, (remainingCapacity.get(scorer) ?? 0) - 1);
      assignedCounts.set(scorer, (assignedCounts.get(scorer) ?? 0) + 1);
    }
  }

  const plan = Array<string>(candidates.length).fill("");
  for (const groupPlan of groupPlans) {
    const remainingQuotas = new Map(groupPlan.quotas);
    let nextScorerIndex = 0;
    for (const candidateIndex of groupPlan.indexes) {
      let selectedScorer = null;
      for (let offset = 0; offset < scorerNames.length; offset += 1) {
        const scorerIndex = (nextScorerIndex + offset) % scorerNames.length;
        const scorer = scorerNames[scorerIndex];
        if ((remainingQuotas.get(scorer) ?? 0) > 0) {
          selectedScorer = scorer;
          nextScorerIndex = (scorerIndex + 1) % scorerNames.length;
          break;
        }
      }
      if (!selectedScorer) throw httpError(409, "维度任务分配失败，请刷新后重试");
      plan[candidateIndex] = selectedScorer;
      remainingQuotas.set(selectedScorer, (remainingQuotas.get(selectedScorer) ?? 0) - 1);
    }
  }

  for (const scorer of scorerNames) {
    if (assignedCounts.get(scorer) !== targetCounts.get(scorer)) {
      throw httpError(409, "维度任务分配数量不一致，请刷新后重试");
    }
  }
  return plan;
}

  return { deterministicTaskId, seededShuffle, dimensionTaskType,
    hydrateSubjectTaskTemplates, loadSubjectTaskTemplates,
    loadProjectTaskTemplates, loadUnmaterializedProjectTaskTemplates,
    loadProjectTaskTemplatesBySourceTaskIds, buildGeneratedTaskRecord,
    bulkInsertRatingTasks, bulkInsertRatingTaskItems, writeGeneratedTaskGroup,
    loadTaskRecordsForBacktest, taskDimensionKey, parseBacktestRatio,
    backtestCountForAllocation, expandBacktestAllocations, randomShuffle,
    buildBacktestTaskRecord, buildBacktestTaskRows,
    buildDimensionAwareAssignmentPlan };
}
