import crypto from "node:crypto";
import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type ProjectRow = Record<string, unknown> & {
  _id: string;
  name: string;
  packageId?: string | null;
};
type ProjectInput = { name?: unknown; packageId?: unknown; packageIds?: unknown };
type ProjectUser = { role?: string; username?: string } | null | undefined;
type ProjectDependencies = {
  db: typeof database;
  httpError: (status: number, message: string) => Error;
  nowIso: () => string;
  taskVersion: string;
  projectSelectColumns: string;
  selectProjectByNameStmt: Statement;
  selectProjectPackagesStmt: Statement;
  selectSubjectByIdStmt: Statement;
  selectProjectByIdStmt: Statement;
  insertProjectStmt: Statement;
  insertProjectPackageStmt: Statement;
  selectProjectTaskCountStmt: Statement;
  updateProjectStmt: Statement;
  deleteProjectPackagesStmt: Statement;
  updateProjectTaskLockStmt: Statement;
  clearProjectTaskClaimsStmt: Statement;
  deleteUncompletedProjectTasksStmt: Statement;
  deleteProjectUserLinksStmt: Statement;
  deleteProjectScorerTaskStatsStmt: Statement;
  deleteProjectScorerScoringStatsStmt: Statement;
  deleteProjectTaskStatsStmt: Statement;
  deleteProjectTaskStatsEventsStmt: Statement;
  deleteProjectStmt: Statement;
  isUniqueConstraintError: (error: unknown) => boolean;
  projectDto: (row: Record<string, unknown> | undefined) => unknown | Promise<unknown>;
  listProjects: () => Promise<unknown>;
  listProjectsPage: (query: Record<string, unknown>) => Promise<unknown>;
  hasPaginationQuery: (query: Record<string, unknown>) => boolean;
  mapProjectRows: (rows: Record<string, unknown>[]) => unknown;
  invalidateScorerQueryCaches: () => void;
  invalidateTaskSummaryCaches: (projectId: string) => void;
  activeTaskGenerationBySubject: Map<string, string>;
  taskGenerationJobs: Map<string, { status: string }>;
};

export function createProjectService({
  db, httpError, nowIso, taskVersion, projectSelectColumns,
  selectProjectByNameStmt, selectProjectPackagesStmt, selectSubjectByIdStmt,
  selectProjectByIdStmt, insertProjectStmt, insertProjectPackageStmt,
  selectProjectTaskCountStmt, updateProjectStmt, deleteProjectPackagesStmt,
  updateProjectTaskLockStmt, clearProjectTaskClaimsStmt,
  deleteUncompletedProjectTasksStmt, deleteProjectUserLinksStmt,
  deleteProjectScorerTaskStatsStmt, deleteProjectScorerScoringStatsStmt,
  deleteProjectTaskStatsStmt, deleteProjectTaskStatsEventsStmt, deleteProjectStmt,
  isUniqueConstraintError, projectDto, listProjects, listProjectsPage,
  hasPaginationQuery, mapProjectRows, invalidateScorerQueryCaches,
  invalidateTaskSummaryCaches, activeTaskGenerationBySubject, taskGenerationJobs,
}: ProjectDependencies) {
  function parseProjectName(value: unknown) {
    const name = String(value ?? "").trim();
    if (!name) throw httpError(400, "请输入项目名称");
    if (name.length > 120) throw httpError(400, "项目名称不能超过 120 字");
    return name;
  }

  async function assertProjectNameAvailable(name: string, excludeId: string | null = null) {
    const existing = await selectProjectByNameStmt.get(name);
    if (existing && existing.id !== excludeId) throw httpError(409, "项目名称已存在");
  }

  async function projectPackageIds(project: ProjectRow) {
    const packageRows = await selectProjectPackagesStmt.all(project._id);
    if (packageRows.length) return packageRows.map((row) => String(row._id));
    return project.packageId ? [project.packageId] : [];
  }

  async function normalizeProjectPackageIds(body: ProjectInput = {}, fallback: string[] = []) {
    const raw = Array.isArray(body.packageIds)
      ? body.packageIds
      : body.packageId != null ? [body.packageId] : fallback;
    const packageIds = [...new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean))];
    if (!packageIds.length) throw httpError(400, "请选择至少一个图包");
    if (packageIds.length > 100) throw httpError(400, "一个项目最多关联 100 个图包");

    const packageRows = await Promise.all(packageIds.map((id) => selectSubjectByIdStmt.get(id)));
    if (packageIds.some((_, index) => !packageRows[index])) {
      throw httpError(400, "存在不存在的图包，请刷新后重试");
    }
    const unavailable = packageRows.filter((row) => row?.status !== "imported");
    if (unavailable.length) {
      throw httpError(400, `以下图包尚未处理完成：${unavailable.map((row) => row?.name).join("、")}`);
    }
    return packageIds;
  }

  async function getProjectOrThrow(projectId: string): Promise<ProjectRow> {
    const project = await selectProjectByIdStmt.get(String(projectId)) as ProjectRow | undefined;
    if (!project) throw httpError(404, "项目不存在");
    const packageStatuses = await Promise.all((await projectPackageIds(project)).map(async (packageId) => {
      const packageRow = await selectSubjectByIdStmt.get(packageId);
      return !packageRow || packageRow.status !== "imported";
    }));
    if (packageStatuses.some(Boolean)) throw httpError(409, "关联图包尚未处理完成");
    return project;
  }

  async function createProject(body: ProjectInput = {}) {
    const name = parseProjectName(body.name);
    const icon = "archive";
    const packageIds = await normalizeProjectPackageIds(body);
    const packageId = packageIds[0];
    const now = nowIso();
    const id = crypto.randomUUID();
    await db.exec("BEGIN");
    try {
      await assertProjectNameAvailable(name);
      await insertProjectStmt.run({ id, name, icon, packageId, createdAt: now, updatedAt: now });
      await Promise.all(packageIds.map(async (linkedPackageId) => {
        await insertProjectPackageStmt.run({ projectId: id, packageId: linkedPackageId, createdAt: now });
      }));
      await db.exec("COMMIT");
    } catch (error) {
      try { await db.exec("ROLLBACK"); } catch {}
      if (isUniqueConstraintError(error)) throw httpError(409, "项目名称已存在");
      throw error;
    }
    return projectDto(await selectProjectByIdStmt.get(id));
  }

  async function updateProject(id: string, body: ProjectInput = {}) {
    const current = await getProjectOrThrow(id);
    const name = parseProjectName(body.name ?? current.name);
    const icon = "archive";
    const packageIds = await normalizeProjectPackageIds(body, await projectPackageIds(current));
    const packageId = packageIds[0];
    const currentPackageIds = await projectPackageIds(current);
    const packageChanged = packageIds.length !== currentPackageIds.length ||
      packageIds.some((item) => !currentPackageIds.includes(item));
    if (packageChanged && (await selectProjectTaskCountStmt.get(id)).total) {
      throw httpError(409, "项目已生成任务，不能更换关联图包");
    }
    const now = nowIso();
    await db.exec("BEGIN");
    try {
      await assertProjectNameAvailable(name, id);
      await updateProjectStmt.run({ id, name, icon, packageId, updatedAt: now });
      await deleteProjectPackagesStmt.run(id);
      await Promise.all(packageIds.map(async (linkedPackageId) => {
        await insertProjectPackageStmt.run({ projectId: id, packageId: linkedPackageId, createdAt: now });
      }));
      await db.exec("COMMIT");
    } catch (error) {
      try { await db.exec("ROLLBACK"); } catch {}
      if (isUniqueConstraintError(error)) throw httpError(409, "项目名称已存在");
      throw error;
    }
    invalidateScorerQueryCaches();
    return projectDto(await selectProjectByIdStmt.get(id));
  }

  async function updateProjectTaskLock(id: string, locked: unknown) {
    if (typeof locked !== "boolean") throw httpError(400, "任务锁定状态必须是布尔值");
    const project = await getProjectOrThrow(id);
    const now = nowIso();
    await db.exec("BEGIN");
    try {
      const result = await updateProjectTaskLockStmt.run({ id: project._id, tasksLocked: locked, updatedAt: now });
      if (result.changes !== 1) throw httpError(404, "项目不存在");
      if (locked) {
        await clearProjectTaskClaimsStmt.run({ projectId: project._id, taskVersion, updatedAt: now });
      }
      await db.exec("COMMIT");
    } catch (error) {
      try { await db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    invalidateScorerQueryCaches();
    return projectDto(await selectProjectByIdStmt.get(project._id));
  }

  async function listVisibleProjects(user: ProjectUser, query: Record<string, unknown> = {}) {
    if (user?.role === "admin") {
      return hasPaginationQuery(query) ? listProjectsPage(query) : listProjects();
    }
    const rows = await db.prepare(`
      SELECT DISTINCT ${projectSelectColumns}
      FROM projects
      JOIN subjects ON subjects.id = projects.packageId
      JOIN rating_tasks ON rating_tasks.projectId = projects.id
      WHERE projects.deletionRequestedAt IS NULL
        AND projects.tasksLocked = false
        AND rating_tasks.taskVersion = ?
        AND rating_tasks.scorer = ?
        AND rating_tasks.status IN ('assigned', 'completed')
      ORDER BY projects.createdAt DESC, projects.id ASC
    `).all(taskVersion, user?.username || "");
    return mapProjectRows(rows);
  }

  async function deleteProject(id: string) {
    const project = await getProjectOrThrow(id);
    const activeJobId = activeTaskGenerationBySubject.get(project._id);
    const activeJob = activeJobId ? taskGenerationJobs.get(activeJobId) : null;
    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      throw httpError(409, "任务正在生成，请等待生成完成后再删除项目");
    }
    await db.exec("BEGIN");
    try {
      const deletedTaskCount = (await deleteUncompletedProjectTasksStmt.run(project._id)).changes;
      await deleteProjectUserLinksStmt.run(project._id);
      await deleteProjectScorerTaskStatsStmt.run(project._id, taskVersion);
      await deleteProjectScorerScoringStatsStmt.run(project._id, taskVersion);
      await deleteProjectTaskStatsStmt.run(project._id, taskVersion);
      await deleteProjectTaskStatsEventsStmt.run(project._id, taskVersion);
      if (!(await deleteProjectStmt.run(project._id)).changes) throw httpError(404, "项目不存在");
      await db.exec("COMMIT");
      invalidateTaskSummaryCaches(project._id);
      invalidateScorerQueryCaches();
      return { deleted: true, deletedTaskCount };
    } catch (error) {
      try { await db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  return { projectPackageIds, getProjectOrThrow, createProject, updateProject,
    updateProjectTaskLock, listVisibleProjects, deleteProject };
}
