import fs from "node:fs/promises";
import type { db as database } from "../postgres.ts";
import type { createTaskGenerationTemplatesService, GeneratedTask } from "./task-generation-templates.ts";
import type { createTaskGenerationPlanService } from "./task-generation-plan.ts";
import type { createTaskGenerationOperations } from "./task-generation-operations.ts";
import type { createProjectService } from "./projects.ts";

type TemplateFns = ReturnType<typeof createTaskGenerationTemplatesService>;
type PlanFns = ReturnType<typeof createTaskGenerationPlanService>;
type OperationFns = ReturnType<typeof createTaskGenerationOperations>;
type Project = Awaited<ReturnType<ReturnType<typeof createProjectService>["getProjectOrThrow"]>>;
type TaskStats = { total: number; pending: number; assigned: number; completed: number };
type BaseTask = Awaited<ReturnType<TemplateFns["loadTaskRecordsForBacktest"]>>[number];
export type Assignment = {
  mode?: string;
  allocations: Array<{ scorer: string; taskCount: number }>;
  backtestRatio?: unknown;
  teamIds: string[];
  exactAssignmentFile?: string;
  exactTaskCount?: number;
  fallbackScorer?: string | null;
  fallbackTaskCount?: number;
};
type Progress = (status: { stage: string; progress: number }) => void;
type AssignmentEntry = { sourceTaskId: string; scorer: string };
type PendingTask = { id: string; taskType: string; criterion?: string };
type ReconciliationError = Error & { needsReconciliation?: boolean };

export function createTaskGenerationExecutionService({
  httpError, TASK_WRITE_BATCH_SIZE, db, placeholders,
  getProjectOrThrow, prepareTaskGeneration,
  loadProjectTaskTemplatesBySourceTaskIds, buildGeneratedTaskRecord,
  TASK_WRITE_TRANSACTION_SIZE, writeGeneratedTaskGroup, yieldToEventLoop,
  assignGeneratedTasks, syncProjectTeams, nowIso, updateSubjectTaskStatusStmt,
  refreshGeneratedProjectTaskStats, invalidateTaskSummaryCaches,
  invalidateScorerQueryCaches, selectProjectByIdStmt, getProjectTaskStats,
  projectDto, taskVersion, rollbackGeneratedTasks,
  selectPendingProjectTaskIdsStmt, loadUnmaterializedProjectTaskTemplates,
  buildDimensionAwareAssignmentPlan, loadTaskRecordsForBacktest,
  buildBacktestTaskRows,
}: {
  httpError: (status: number, message: string) => Error;
  TASK_WRITE_BATCH_SIZE: number;
  db: typeof database;
  placeholders: (count: number) => string;
  getProjectOrThrow: (id: string) => Promise<Project>;
  prepareTaskGeneration: PlanFns["prepareTaskGeneration"];
  loadProjectTaskTemplatesBySourceTaskIds: TemplateFns["loadProjectTaskTemplatesBySourceTaskIds"];
  buildGeneratedTaskRecord: TemplateFns["buildGeneratedTaskRecord"];
  TASK_WRITE_TRANSACTION_SIZE: number;
  writeGeneratedTaskGroup: TemplateFns["writeGeneratedTaskGroup"];
  yieldToEventLoop: () => Promise<void>;
  assignGeneratedTasks: OperationFns["assignGeneratedTasks"];
  syncProjectTeams: (id: string, teamIds: string[], now: string) => Promise<void>;
  nowIso: () => string;
  updateSubjectTaskStatusStmt: ReturnType<typeof database.prepare>;
  refreshGeneratedProjectTaskStats: (id: string) => Promise<void>;
  invalidateTaskSummaryCaches: (id: string) => void;
  invalidateScorerQueryCaches: () => void;
  selectProjectByIdStmt: ReturnType<typeof database.prepare>;
  getProjectTaskStats: (id: string) => Promise<TaskStats>;
  projectDto: (row: Record<string, unknown> | undefined, stats: TaskStats) => Promise<unknown>;
  taskVersion: string;
  rollbackGeneratedTasks: OperationFns["rollbackGeneratedTasks"];
  selectPendingProjectTaskIdsStmt: ReturnType<typeof database.prepare>;
  loadUnmaterializedProjectTaskTemplates: TemplateFns["loadUnmaterializedProjectTaskTemplates"];
  buildDimensionAwareAssignmentPlan: TemplateFns["buildDimensionAwareAssignmentPlan"];
  loadTaskRecordsForBacktest: TemplateFns["loadTaskRecordsForBacktest"];
  buildBacktestTaskRows: TemplateFns["buildBacktestTaskRows"];
}) {
  async function loadExactTaskAssignmentEntries(assignment: Assignment): Promise<AssignmentEntry[]> {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(assignment.exactAssignmentFile || "", "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw httpError(409, "精确分配清单已过期，请重新上传");
      throw error;
    }
    const entries = parsed?.tasks;
    if (!Array.isArray(entries) || entries.length !== assignment.exactTaskCount) {
      throw httpError(409, "精确分配清单内容已变化，请重新上传");
    }
    return entries as AssignmentEntry[];
  }

  async function loadExistingTaskAssignmentRows(taskIds: string[]) {
    const rows: Array<{ id: string; status: string; scorer: string | null }> = [];
    for (let start = 0; start < taskIds.length; start += TASK_WRITE_BATCH_SIZE) {
      const batch = taskIds.slice(start, start + TASK_WRITE_BATCH_SIZE);
      rows.push(...(await db.prepare(`
        SELECT id, status, scorer
        FROM rating_tasks
        WHERE id IN (${placeholders(batch.length)})
      `).all(...batch) as Array<{ id: string; status: string; scorer: string | null }>));
    }
    return rows;
  }

  async function generateExactSubjectTasks(projectId: string, assignment: Assignment, onProgress?: Progress) {
    const project = await getProjectOrThrow(projectId);
    const { requestedBaseTaskCount } = await prepareTaskGeneration(projectId, assignment, project);
    const previousTaskStatus = project.taskStatus as string;
    const generatedTaskIds: string[] = [];
    const assignedTaskIds: string[] = [];
    let finalizationStarted = false;

    try {
      onProgress?.({ stage: "正在读取精确分配清单", progress: 1 });
      const entries = await loadExactTaskAssignmentEntries(assignment);
      onProgress?.({ stage: "正在匹配图包任务模板", progress: 3 });
      const templates = await loadProjectTaskTemplatesBySourceTaskIds(
        projectId,
        entries.map((entry) => entry.sourceTaskId),
      );
      const taskRows = templates.map((template, index) =>
        buildGeneratedTaskRecord(projectId, template, entries[index].scorer),
      );

      const taskIdSources = new Map<string, string>();
      const duplicateTaskSources: string[] = [];
      taskRows.forEach((task, index) => {
        const previousSource = taskIdSources.get(task.id);
        if (previousSource) {
          duplicateTaskSources.push(`${previousSource} / ${entries[index].sourceTaskId}`);
        } else {
          taskIdSources.set(task.id, entries[index].sourceTaskId);
        }
      });
      if (duplicateTaskSources.length) {
        throw httpError(
          400,
          `清单中有 ${duplicateTaskSources.length} 组任务的维度和图片完全相同，示例：${duplicateTaskSources.slice(0, 3).join("；")}`,
        );
      }

      onProgress?.({ stage: "正在校验已有任务", progress: 12 });
      const existingRows = await loadExistingTaskAssignmentRows(taskRows.map((task) => task.id));
      const existingById = new Map(existingRows.map((row) => [row.id, row]));
      const occupiedRows = existingRows.filter(
        (row) => row.status !== "pending" || row.scorer,
      );
      if (occupiedRows.length) {
        throw httpError(
          409,
          `清单中有 ${occupiedRows.length} 条任务已经分配或完成，未对现有数据做修改`,
        );
      }

      const taskRowsToCreate = taskRows.filter((task) => !existingById.has(task.id));
      const pendingTaskRows = taskRows.filter((task) => existingById.has(task.id));
      let createdCount = 0;
      onProgress?.({ stage: "正在按清单创建并分配任务", progress: 15 });
      for (let start = 0; start < taskRowsToCreate.length; start += TASK_WRITE_TRANSACTION_SIZE) {
        const batch = taskRowsToCreate.slice(start, start + TASK_WRITE_TRANSACTION_SIZE);
        const result = await writeGeneratedTaskGroup(
          projectId, "exact", batch, Math.floor(start / TASK_WRITE_TRANSACTION_SIZE) + 1,
        );
        createdCount += result;
        generatedTaskIds.push(...batch.map((task) => task.id));
        const processed = start + batch.length;
        onProgress?.({
          stage: "正在按清单创建并分配任务",
          progress: 15 + Math.round((processed / Math.max(taskRowsToCreate.length, 1)) * 65),
        });
        if (processed < taskRowsToCreate.length) await yieldToEventLoop();
      }

      if (pendingTaskRows.length) {
        onProgress?.({ stage: "正在分配已有未分配任务", progress: 82 });
        const pendingResult = await assignGeneratedTasks(
          projectId,
          pendingTaskRows,
          pendingTaskRows.map((task) => task.scorer!),
          (current, total) => onProgress?.({
            stage: "正在分配已有未分配任务",
            progress: 82 + (total ? Math.round((current / total) * 10) : 0),
          }),
        );
        assignedTaskIds.push(...pendingResult.taskIds);
      }

      onProgress?.({ stage: "正在更新项目统计", progress: 94 });
      finalizationStarted = true;
      await syncProjectTeams(projectId, assignment.teamIds, nowIso());
      await updateSubjectTaskStatusStmt.run({
        id: projectId,
        taskStatus: "scoring",
        updatedAt: nowIso(),
      });
      await refreshGeneratedProjectTaskStats(projectId);
      invalidateTaskSummaryCaches(projectId);
      invalidateScorerQueryCaches();
      const updatedProject = await selectProjectByIdStmt.get(projectId);
      const taskStats = await getProjectTaskStats(projectId);
      onProgress?.({ stage: "精确任务分配完成", progress: 100 });
      return {
        project: await projectDto(updatedProject, taskStats),
        taskCount: taskStats.total,
        createdCount,
        assignedCount: requestedBaseTaskCount,
        baseAssignedCount: requestedBaseTaskCount,
        backtestCount: 0,
        backtestRatio: 0,
        fallbackScorer: assignment.fallbackScorer,
        fallbackTaskCount: assignment.fallbackTaskCount,
        unassignedCount: taskStats.pending,
        taskVersion,
      };
    } catch (caught) {
      const error = caught as ReconciliationError;
      if (finalizationStarted) {
        error.needsReconciliation = true;
        error.message = `任务已下发，收尾失败；请核对实际任务和统计后再处理：${error.message}`;
      } else {
        const rolledBack = await rollbackGeneratedTasks(
          projectId, generatedTaskIds, previousTaskStatus, assignedTaskIds,
        );
        if (!rolledBack) {
          error.needsReconciliation = true;
          error.message = `任务生成中断且自动回滚未完成；请核对实际任务后再处理：${error.message}`;
        }
      }
      throw error;
    }
  }

  async function generateSubjectTasks(projectId: string, assignment: Assignment, onProgress?: Progress) {
    if (assignment.mode === "exact") {
      return generateExactSubjectTasks(projectId, assignment, onProgress);
    }
    const project = await getProjectOrThrow(projectId);
    const {
      backtestRatio,
      backtestAllocations,
      baseAllocations,
      requestedBaseTaskCount,
      requestedBacktestTaskCount,
      materializedBaseCount,
    } = await prepareTaskGeneration(projectId, assignment, project);
    const previousTaskStatus = project.taskStatus as string;
    const generatedTaskIds: string[] = [];
    const assignedTaskIds: string[] = [];
    let finalizationStarted = false;

    try {
      let createdCount = 0;
      let assignedCount = 0;
      onProgress?.({ stage: "正在校验任务池", progress: 1 });
      const pendingBefore = (await getProjectTaskStats(projectId)).pending;
      const pendingTasks: PendingTask[] = pendingBefore
        ? await selectPendingProjectTaskIdsStmt.all(
          projectId,
          taskVersion,
          Math.min(requestedBaseTaskCount, pendingBefore),
        ) as PendingTask[]
        : [];
      const templatesNeeded = Math.max(0, requestedBaseTaskCount - pendingTasks.length);
      if (templatesNeeded) {
        onProgress?.({ stage: "正在加载任务模板", progress: 3 });
      }
      const templates = templatesNeeded
        ? await loadUnmaterializedProjectTaskTemplates(projectId, templatesNeeded, { materializedBaseCount })
        : [];

      if (pendingTasks.length + templates.length < requestedBaseTaskCount) {
        const availableTaskCount = pendingTasks.length + templates.length;
        throw httpError(400, `本次最多还能占用 ${availableTaskCount} 个任务池任务`);
      }

      const assigneePlan = buildDimensionAwareAssignmentPlan(
        [...templates, ...pendingTasks],
        baseAllocations,
      );
      const createdAssigneePlan = assigneePlan.slice(0, templates.length);
      const pendingAssigneePlan = assigneePlan.slice(templates.length);
      const baseTasksByScorer = new Map<string, BaseTask[]>();
      const rememberBaseTask = (task: BaseTask | GeneratedTask, scorer: string | null | undefined) => {
        if (!scorer) return;
        const tasks = baseTasksByScorer.get(scorer) || [];
        tasks.push(task);
        baseTasksByScorer.set(scorer, tasks);
      };
      const pendingTaskRecords = pendingTasks.length
        ? await loadTaskRecordsForBacktest(pendingTasks.map((task) => task.id))
        : [];
      pendingTaskRecords.forEach((task, index) => {
        rememberBaseTask(task, pendingAssigneePlan[index]);
      });

      onProgress?.({
        stage: templates.length ? "正在生成并分配基础任务" : "正在分配已有基础任务",
        progress: templates.length ? 5 : 70,
      });

      for (let start = 0; start < templates.length; start += TASK_WRITE_TRANSACTION_SIZE) {
        const batch = templates.slice(start, start + TASK_WRITE_TRANSACTION_SIZE);
        const taskRows = batch.map((template, index) =>
          buildGeneratedTaskRecord(
            projectId,
            template,
            createdAssigneePlan[start + index] || null,
          ),
        );
        taskRows.forEach((task) => rememberBaseTask(task, task.scorer));
        const result = await writeGeneratedTaskGroup(
          projectId, "base", taskRows, Math.floor(start / TASK_WRITE_TRANSACTION_SIZE) + 1,
        );
        createdCount += result;
        generatedTaskIds.push(...taskRows.map((task) => task.id));

        onProgress?.({
          stage: "正在生成并分配基础任务",
          progress: 5 + Math.round((Math.min(start + batch.length, templates.length) / templates.length) * 65),
        });
        if (start + batch.length < templates.length) await yieldToEventLoop();
      }

      if (pendingAssigneePlan.length) {
        onProgress?.({ stage: "正在分配已有基础任务", progress: templates.length ? 75 : 70 });
        const assignedResult = await assignGeneratedTasks(
          projectId,
          pendingTasks,
          pendingAssigneePlan,
          (current, total) => onProgress?.({
            stage: "正在分配已有基础任务",
            progress: (templates.length ? 75 : 70) + (total ? Math.round((current / total) * 20) : 0),
          }),
        );
        assignedCount = createdCount + assignedResult.assignedCount;
        assignedTaskIds.push(...assignedResult.taskIds);
      } else {
        assignedCount = createdCount;
      }

      let backtestCreatedCount = 0;
      if (requestedBacktestTaskCount) {
        onProgress?.({ stage: "正在生成回测任务", progress: 92 });
        const backtestTaskRows = buildBacktestTaskRows(
          backtestAllocations,
          baseTasksByScorer,
          projectId,
        );
        for (let start = 0; start < backtestTaskRows.length; start += TASK_WRITE_TRANSACTION_SIZE) {
          const batch = backtestTaskRows.slice(start, start + TASK_WRITE_TRANSACTION_SIZE);
          const result = await writeGeneratedTaskGroup(
            projectId, "backtest", batch, Math.floor(start / TASK_WRITE_TRANSACTION_SIZE) + 1,
          );
          backtestCreatedCount += result;
          generatedTaskIds.push(...batch.map((task) => task.id));

          const processed = start + batch.length;
          onProgress?.({
            stage: "正在生成回测任务",
            progress: 92 + Math.round((processed / backtestTaskRows.length) * 5),
          });
          if (processed < backtestTaskRows.length) await yieldToEventLoop();
        }
        createdCount += backtestCreatedCount;
        assignedCount += backtestCreatedCount;
      }

      finalizationStarted = true;
      onProgress?.({ stage: "正在更新项目统计", progress: 98 });
      await syncProjectTeams(projectId, assignment.teamIds, nowIso());
      await updateSubjectTaskStatusStmt.run({
        id: projectId,
        taskStatus: "scoring",
        updatedAt: nowIso(),
      });
      await refreshGeneratedProjectTaskStats(projectId);
      invalidateTaskSummaryCaches(projectId);
      const updatedProject = await selectProjectByIdStmt.get(projectId);
      const taskStats = await getProjectTaskStats(projectId);
      const taskCount = taskStats.total;
      const unassignedCount = taskStats.pending;
      onProgress?.({ stage: "任务生成完成", progress: 100 });

      return {
        project: await projectDto(updatedProject, taskStats),
        taskCount,
        createdCount,
        assignedCount,
        baseAssignedCount: requestedBaseTaskCount,
        backtestCount: backtestCreatedCount,
        backtestRatio,
        unassignedCount,
        taskVersion,
      };
    } catch (caught) {
      const error = caught as ReconciliationError;
      if (finalizationStarted) {
        error.needsReconciliation = true;
        error.message = `任务已下发，收尾失败；请核对实际任务和统计后再处理：${error.message}`;
      } else {
        const rolledBack = await rollbackGeneratedTasks(
          projectId, generatedTaskIds, previousTaskStatus, assignedTaskIds,
        );
        if (!rolledBack) {
          error.needsReconciliation = true;
          error.message = `任务生成中断且自动回滚未完成；请核对实际任务后再处理：${error.message}`;
        }
      }
      throw error;
    }
  }

  return { generateSubjectTasks };
}
