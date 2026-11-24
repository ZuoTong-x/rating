import type { db as database } from "../postgres.ts";

type Allocation = { scorer: string; taskCount: number };
type BacktestAllocation = Allocation & { baseTaskCount: number; backtestTaskCount: number };
type Assignment = {
  allocations: Allocation[];
  backtestRatio?: unknown;
  mode?: string;
  teamIds?: string[];
  teamMatchMode?: string;
  exactTaskCount?: number;
  fallbackScorer?: string | null;
  fallbackTaskCount?: number;
  exactAssignmentFilename?: string;
};
type Project = { _id: string; packageId?: string | null };
type PlanDependencies = {
  parseBacktestRatio: (value: unknown) => number;
  expandBacktestAllocations: (allocations: Allocation[], ratio: number) => BacktestAllocation[];
  getProjectOrThrow: (id: string) => Promise<Project>;
  projectPackageIds: (project: Project) => Promise<string[]>;
  db: typeof database;
  placeholders: (length: number) => string;
  taskVersion: string;
  httpError: (status: number, message: string) => Error;
};

export function createTaskGenerationPlanService({
  parseBacktestRatio, expandBacktestAllocations, getProjectOrThrow,
  projectPackageIds, db, placeholders, taskVersion, httpError,
}: PlanDependencies) {
  function taskGenerationPlan(assignment: Assignment) {
    const requestedTaskCount = assignment.allocations.reduce(
      (total, allocation) => total + allocation.taskCount,
      0,
    );
    const backtestRatio = parseBacktestRatio(assignment.backtestRatio);
    const backtestAllocations = expandBacktestAllocations(
      assignment.allocations,
      backtestRatio,
    );
    const baseAllocations = backtestAllocations
      .filter((allocation) => allocation.baseTaskCount > 0)
      .map((allocation) => ({
        scorer: allocation.scorer,
        taskCount: allocation.baseTaskCount,
      }));
    return {
      requestedTaskCount,
      backtestRatio,
      backtestAllocations,
      baseAllocations,
      requestedBaseTaskCount: baseAllocations.reduce(
        (total, allocation) => total + allocation.taskCount,
        0,
      ),
      requestedBacktestTaskCount: backtestAllocations.reduce(
        (total, allocation) => total + allocation.backtestTaskCount,
        0,
      ),
    };
  }

  async function getTaskGenerationCapacity(projectId: string, project: Project | null = null) {
    const currentProject = project || await getProjectOrThrow(projectId);
    const packageIds = await projectPackageIds(currentProject);
    if (!packageIds.length) {
      return {
        templateCount: 0,
        materializedBaseCount: 0,
        pendingBaseCount: 0,
        availableTaskCount: 0,
      };
    }

    const [templateRow, materializedRow] = await Promise.all([
      db.prepare(`
        SELECT COUNT(*)::integer AS "templateCount"
        FROM subject_task_templates
        WHERE subjectId IN (${placeholders(packageIds.length)})
      `).get(...packageIds),
      db.prepare(`
        SELECT
          COUNT(*) FILTER (WHERE NOT isBacktest)::integer AS "materializedBaseCount",
          COUNT(*) FILTER (
            WHERE NOT isBacktest
              AND status = 'pending'
              AND scorer IS NULL
          )::integer AS "pendingBaseCount"
        FROM rating_tasks
        WHERE projectId = ?
          AND taskVersion = ?
      `).get(projectId, taskVersion),
    ]);
    const templateCount = Number(templateRow?.templateCount || 0);
    const materializedBaseCount = Number(materializedRow?.materializedBaseCount || 0);
    const pendingBaseCount = Number(materializedRow?.pendingBaseCount || 0);
    return {
      templateCount,
      materializedBaseCount,
      pendingBaseCount,
      availableTaskCount: pendingBaseCount + Math.max(templateCount - materializedBaseCount, 0),
    };
  }

  async function prepareTaskGeneration(projectId: string, assignment: Assignment, project: Project | null = null) {
    const plan = taskGenerationPlan(assignment);
    if (!plan.requestedTaskCount) {
      throw httpError(400, "请至少为一名打分人分配任务");
    }
    const capacity = await getTaskGenerationCapacity(projectId, project);
    if (plan.requestedBaseTaskCount > capacity.availableTaskCount) {
      throw httpError(
        400,
        `本次最多还能占用 ${capacity.availableTaskCount} 个任务池任务，当前请求需要 ${plan.requestedBaseTaskCount} 个基础任务`,
      );
    }
    return { ...plan, ...capacity };
  }

  function taskGenerationRequestSummary(assignment: Assignment, prepared: Awaited<ReturnType<typeof prepareTaskGeneration>>) {
    const splitByScorer = new Map(
      prepared.backtestAllocations.map((allocation) => [allocation.scorer, allocation]),
    );
    return {
      mode: assignment.mode || "random",
      teamIds: assignment.teamIds,
      teamMatchMode: assignment.teamMatchMode,
      backtestRatio: prepared.backtestRatio,
      scorerCount: prepared.backtestAllocations.length,
      requestedTaskCount: prepared.requestedTaskCount,
      requestedBaseTaskCount: prepared.requestedBaseTaskCount,
      requestedBacktestTaskCount: prepared.requestedBacktestTaskCount,
      availableTaskCount: prepared.availableTaskCount,
      templateCount: prepared.templateCount,
      materializedBaseCount: prepared.materializedBaseCount,
      pendingBaseCount: prepared.pendingBaseCount,
      ...(assignment.mode === "exact" ? {
        exactTaskCount: assignment.exactTaskCount,
        fallbackScorer: assignment.fallbackScorer,
        fallbackTaskCount: assignment.fallbackTaskCount,
        filename: assignment.exactAssignmentFilename,
      } : {}),
      allocations: assignment.allocations.map((allocation) => {
        const split = splitByScorer.get(allocation.scorer);
        return {
          scorer: allocation.scorer,
          taskCount: allocation.taskCount,
          baseTaskCount: split?.baseTaskCount ?? allocation.taskCount,
          backtestTaskCount: split?.backtestTaskCount ?? 0,
        };
      }),
    };
  }

  return { getTaskGenerationCapacity, prepareTaskGeneration, taskGenerationRequestSummary };
}
