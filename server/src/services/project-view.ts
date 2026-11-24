import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type ProjectStats = {
  total: number;
  pending: number;
  assigned: number;
  completed: number;
  baseTotal: number | null;
  basePending: number | null;
};
type ProjectRow = Record<string, unknown> & {
  _id: string;
  name: string;
  packageId?: string | null;
  packageName?: string;
  packageFilename?: string;
  packageStatus?: string;
  createdAt?: string;
  updatedAt?: string;
};
type PackageRow = Record<string, unknown> & {
  _id: string;
  name: string;
  originalFilename?: string;
  status?: string;
};
type TeamRow = Record<string, unknown> & { _projectId: string };
type RelatedRows = { packageRows: PackageRow[]; teamRows: TeamRow[] };

export function createProjectViewService({
  db, taskVersion, placeholders, selectProjectTaskStatsStmt,
  selectProjectPackagesStmt, selectProjectTeamsStmt,
  getProjectTaskStats, teamDto, selectProjectsStmt,
  parseTaskPagination, projectSelectColumns,
}: {
  db: typeof database;
  taskVersion: string;
  placeholders: (length: number) => string;
  selectProjectTaskStatsStmt: Statement;
  selectProjectPackagesStmt: Statement;
  selectProjectTeamsStmt: Statement;
  getProjectTaskStats: (id: string) => Promise<ProjectStats>;
  teamDto: (row: Record<string, unknown>) => unknown;
  selectProjectsStmt: Statement;
  parseTaskPagination: (query: Record<string, unknown>) => { page: number; pageSize: number };
  projectSelectColumns: string;
}) {
async function projectStatsByIds(projectIds: string[], version = taskVersion) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!ids.length) return new Map<string, ProjectStats>();
  const statsByProjectId = new Map<string, ProjectStats>(ids.map((id) => [id, {
    total: 0,
    pending: 0,
    assigned: 0,
    completed: 0,
    baseTotal: null,
    basePending: null,
  }]));
  const statRows = await db
    .prepare(
      `SELECT projectId, total, pending, assigned, completed, baseTotal, basePending
       FROM project_task_stats
       WHERE taskVersion = ?
         AND projectId IN (${placeholders(ids.length)})`,
    )
    .all(version, ...ids) as Array<Record<string, unknown> & { projectId: string }>;
  statRows.forEach((row) => {
    statsByProjectId.set(row.projectId, {
      ...(statsByProjectId.get(row.projectId) || {}),
      total: Number(row.total || 0),
      pending: Number(row.pending || 0),
      assigned: Number(row.assigned || 0),
      completed: Number(row.completed || 0),
      baseTotal: row.baseTotal == null ? null : Number(row.baseTotal || 0),
      basePending: row.basePending == null ? null : Number(row.basePending || 0),
    });
  });
  return statsByProjectId;
}

async function getProjectMaterializedTaskStats(projectId: string, version = taskVersion) {
  const row = await selectProjectTaskStatsStmt.get(projectId, version);
  return {
    materializedTotal: row?.baseTotal == null
      ? Number(row?.total || 0)
      : Number(row.baseTotal || 0),
    materializedPending: row?.basePending == null
      ? Number(row?.pending || 0)
      : Number(row.basePending || 0),
  };
}

async function projectRelatedRowsByIds(projectIds: string[]) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!ids.length) return new Map<string, RelatedRows>();

  const packageRows = await db
    .prepare(
      `WITH package_links AS (
         SELECT project_packages.projectId,
                project_packages.packageId,
                project_packages.createdAt
         FROM project_packages
         WHERE project_packages.projectId IN (${placeholders(ids.length)})
       ), template_counts AS (
         SELECT missing_packages.packageId AS subjectId,
                COUNT(subject_task_templates.id) AS taskTemplateCount
         FROM (
           SELECT DISTINCT package_links.packageId
           FROM package_links
           LEFT JOIN subject_task_template_stats template_stats
             ON template_stats.subjectId = package_links.packageId
           WHERE template_stats.subjectId IS NULL
         ) missing_packages
         LEFT JOIN subject_task_templates
           ON subject_task_templates.subjectId = missing_packages.packageId
         GROUP BY missing_packages.packageId
       )
       SELECT package_links.projectId AS "_projectId",
              subjects.id AS _id,
              subjects.name,
              subjects.originalFilename,
              subjects.imageCount,
              subjects.categoryCount,
              subjects.status,
              subjects.createdAt,
              subjects.updatedAt,
              COALESCE(template_stats.taskTemplateCount, template_counts.taskTemplateCount, 0) AS taskTemplateCount
       FROM package_links
       JOIN subjects ON subjects.id = package_links.packageId
       LEFT JOIN subject_task_template_stats template_stats
         ON template_stats.subjectId = subjects.id
       LEFT JOIN template_counts ON template_counts.subjectId = subjects.id
       WHERE subjects.deletionRequestedAt IS NULL
       ORDER BY package_links.projectId ASC,
                package_links.createdAt ASC,
                subjects.createdAt ASC,
                subjects.id ASC`,
    )
    .all(...ids) as Array<PackageRow & { _projectId: string }>;
  const teamRows = await db
    .prepare(
      `SELECT project_teams.projectId AS "_projectId",
              teams.id,
              teams.name,
              teams.status
       FROM project_teams
       JOIN teams ON teams.id = project_teams.teamId
       WHERE project_teams.projectId IN (${placeholders(ids.length)})
       ORDER BY project_teams.projectId ASC, LOWER(teams.name) ASC, teams.name ASC`,
    )
    .all(...ids) as TeamRow[];
  const relatedByProjectId = new Map<string, RelatedRows>();
  ids.forEach((id) => {
    relatedByProjectId.set(id, { packageRows: [], teamRows: [] });
  });
  packageRows.forEach((row) => {
    relatedByProjectId.get(row._projectId)?.packageRows.push(row);
  });
  teamRows.forEach((row) => {
    relatedByProjectId.get(row._projectId)?.teamRows.push(row);
  });
  return relatedByProjectId;
}

async function mapProjectRows(rows: ProjectRow[]) {
  const statsByProjectId = await projectStatsByIds(rows.map((row) => row._id));
  const relatedByProjectId = await projectRelatedRowsByIds(rows.map((row) => row._id));
  return await Promise.all(rows.map(
    async row => await projectDto(row, statsByProjectId.get(row._id), relatedByProjectId.get(row._id))
  ));
}

async function projectDto(row: ProjectRow | null | undefined, taskStats: ProjectStats | null = null, related: RelatedRows | null = null) {
  if (!row) return null;
  const packageRows = related?.packageRows?.length
    ? related.packageRows
    : await selectProjectPackagesStmt.all(row._id) as PackageRow[];
  const fallbackPackage = row.packageId
    ? [{
        _id: row.packageId,
        name: row.packageName,
        originalFilename: row.packageFilename,
        imageCount: Number(row.imageCount || 0),
        categoryCount: Number(row.categoryCount || 0),
        status: row.packageStatus,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        taskTemplateCount: Number(row.taskTemplateCount || 0),
      }]
    : [];
  const packages = packageRows.length ? packageRows : fallbackPackage;
  const primaryPackage =
    packages.find((item) => item._id === row.packageId) || packages[0] || null;
  const taskTemplateCount = packages.reduce(
    (total, item) => total + Number(item.taskTemplateCount || 0),
    0,
  );
  const stats = taskStats || (await getProjectTaskStats(row._id));
  const materializedStats = {
    materializedTotal: stats.baseTotal == null ? stats.total : stats.baseTotal,
    materializedPending: stats.basePending == null ? stats.pending : stats.basePending,
  };
  const generatedTaskCount = Math.min(materializedStats.materializedTotal, taskTemplateCount);
  const pendingTaskCount = materializedStats.materializedPending;
  const remainingTemplateCount = Math.max(taskTemplateCount - generatedTaskCount, 0);
  const availableTaskCount = pendingTaskCount + remainingTemplateCount;
  const taskStatus = stats.total === 0
    ? "task_pending"
    : stats.pending + stats.assigned > 0 || availableTaskCount > 0
      ? "scoring"
      : "task_completed";
  return {
    _id: row._id,
    name: row.name,
    packageId: primaryPackage?._id || row.packageId,
    packageIds: packages.map((item) => item._id),
    packages,
    packageName: primaryPackage?.name || row.packageName,
    packageNames: packages.map((item) => item.name),
    packageFilename: primaryPackage?.originalFilename || row.packageFilename,
    packageStatus: packages.every((item) => item.status === "imported")
      ? "imported"
      : packages.some((item) => item.status === "failed")
        ? "failed"
        : "importing",
    imageCount: packages.reduce(
      (total, item) => total + Number(item.imageCount || 0),
      0,
    ),
    categoryCount: packages.reduce(
      (total, item) => total + Number(item.categoryCount || 0),
      0,
    ),
    taskTemplateCount,
    generatedTaskCount,
    totalTaskCount: stats.total,
    completedTaskCount: stats.completed,
    assignedTaskCount: stats.assigned,
    pendingTaskCount,
    remainingTemplateCount,
    availableTaskCount,
    taskStatus,
    tasksLocked: Boolean(row.tasksLocked),
    deletionRequestedAt: row.deletionRequestedAt ?? null,
    teams: (related?.teamRows || (await selectProjectTeamsStmt.all(row._id))).map(teamDto),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function projectSubjectDto(project: ProjectRow, projectView: Awaited<ReturnType<typeof projectDto>> = null) {
  const view = projectView || (await projectDto(project));
  if (!view) return null;
  return {
    _id: view._id,
    name: view.name,
    originalFilename: view.packageNames.join("、"),
    importBatch: view.packageIds.join(","),
    imageCount: view.imageCount,
    categoryCount: view.categoryCount,
    taskTemplateCount: view.taskTemplateCount,
    status: view.packageStatus,
    taskStatus: view.taskStatus,
    deletionRequestedAt: view.deletionRequestedAt,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

async function listProjects() {
  return await mapProjectRows(await selectProjectsStmt.all() as ProjectRow[]);
}

async function listProjectsPage(query: Record<string, unknown> = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const total = (await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM projects
       JOIN subjects ON subjects.id = projects.packageId
       WHERE projects.deletionRequestedAt IS NULL`,
    )
    .get()).total;
  const projectRows = await db
    .prepare(
      `SELECT ${projectSelectColumns}
       FROM projects
       JOIN subjects ON subjects.id = projects.packageId
       WHERE projects.deletionRequestedAt IS NULL
       ORDER BY projects.createdAt DESC, projects.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(pageSize, (page - 1) * pageSize) as ProjectRow[];
  const projects = await mapProjectRows(projectRows);
  return { total, page, pageSize, projects };
}
  return {
    projectStatsByIds, getProjectMaterializedTaskStats,
    projectRelatedRowsByIds, mapProjectRows, projectDto,
    projectSubjectDto, listProjects, listProjectsPage,
  };
}
