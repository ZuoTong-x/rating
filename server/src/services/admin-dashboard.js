import { once } from "node:events";

function placeholders(length) {
  return Array.from({ length }, () => "?").join(",");
}

function reportCompletionRate(completed, total) {
  return total ? completed / total : 0;
}

async function writeResponseChunk(res, chunk) {
  if (!res.write(chunk)) await once(res, "drain");
}

function parseQueryList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseQueryList(item));
  }
  if (value == null) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createAdminDashboardService({
  db,
  taskVersion,
  httpError,
  nowIso,
  normalizeTeamIds,
  parseProjectId,
  parseTaskPagination,
  hydrateTaskRows,
  selectUserByIdStmt,
  selectScorerByUsernameStmt,
  selectTeamByIdStmt,
}) {
  const dashboardCache = new Map();
  const dashboardCacheTtlMs = 15 * 1000;

  async function cachedDashboardValue(key, producer) {
    const cached = dashboardCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return await cached.value;
    const value = producer();
    dashboardCache.set(key, {
      value,
      expiresAt: Date.now() + dashboardCacheTtlMs,
    });
    return value;
  }

  const selectAdminDashboardStatsStmt = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM projects WHERE deletionRequestedAt IS NULL) AS projectCount,
      (
        SELECT COUNT(*)
        FROM projects
        WHERE deletionRequestedAt IS NULL
          AND taskStatus = 'task_completed'
      ) AS completedProjectCount,
      (SELECT COUNT(*) FROM teams) AS teamCount,
      (
        SELECT COUNT(*)
        FROM users
        WHERE role = 'scorer'
          AND status = 'enabled'
          AND NOT EXISTS (
            SELECT 1
            FROM user_teams
            JOIN teams ON teams.id = user_teams.teamId
            WHERE user_teams.userId = users.id
              AND teams.status = 'disabled'
          )
      ) AS scorerCount,
      (SELECT COALESCE(SUM(total), 0)
       FROM project_task_stats
       WHERE taskVersion = ?) AS totalTaskCount,
      (SELECT COALESCE(SUM(pending), 0)
       FROM project_task_stats
       WHERE taskVersion = ?) AS unassignedTaskCount,
      (SELECT COALESCE(SUM(assigned), 0)
       FROM project_task_stats
       WHERE taskVersion = ?) AS assignedTaskCount,
      (SELECT COALESCE(SUM(pending + assigned), 0)
       FROM project_task_stats
       WHERE taskVersion = ?) AS pendingTaskCount,
      (SELECT COALESCE(SUM(completed), 0)
       FROM project_task_stats
       WHERE taskVersion = ?) AS completedTaskCount
  `);

  const selectAdminDashboardAverageDurationStmt = db.prepare(`
    SELECT AVG(durationMs) AS averageDurationMs
    FROM rating_tasks
    WHERE taskVersion = ?
      AND status = 'completed'
      AND durationMs >= 0
  `);

  async function parseDashboardProjectIds(query = {}) {
    const rawIds = parseQueryList(query.projectIds ?? query.projectId);
    const ids = [...new Set(rawIds)];
    if (ids.length > 100) throw httpError(400, "一次最多选择 100 个项目");
    await Promise.all(ids.map((id) => parseProjectId(id)));
    return ids;
  }

  async function parseDashboardTeamIds(query = {}) {
    return await normalizeTeamIds(parseQueryList(query.teamIds ?? query.teamId));
  }

  async function parseDashboardScorerIds(query = {}) {
    const rawIds = parseQueryList(query.scorerIds ?? query.scorerId ?? query.scorer);
    const ids = [...new Set(await Promise.all(rawIds.map(async value => {
      const user = (await selectUserByIdStmt.get(value)) || (await selectScorerByUsernameStmt.get(value));
      if (!user || user.role !== "scorer") throw httpError(400, "打分人不存在");
      return user.id;
    })))];
    if (!ids.length) throw httpError(400, "请选择需要导出的打分人");
    if (ids.length > 100) throw httpError(400, "一次最多选择 100 位打分人");
    return ids;
  }

  async function listDashboardScorerExportUsers(scorerIds) {
    return await Promise.all(scorerIds.map(async scorerId => {
      const user = await selectUserByIdStmt.get(scorerId);
      if (!user || user.role !== "scorer") throw httpError(400, "打分人不存在");
      return user;
    }));
  }

  async function parseTeamSummaryExportIds(query = {}) {
    const teamIds = await parseDashboardTeamIds(query);
    if (!teamIds.length) throw httpError(400, "请选择需要导出的团队");
    return teamIds;
  }

  async function defaultDashboardProjectId() {
    const row = await db
      .prepare(
        `SELECT id
         FROM projects
         WHERE deletionRequestedAt IS NULL
         ORDER BY updatedAt DESC, createdAt DESC, id ASC
         LIMIT 1`,
      )
      .get();
    return row?.id || null;
  }

  function completedTaskExportFilter({ projectIds = [], scorerNames = [] } = {}, alias = "rating_tasks") {
    const clauses = [];
    const params = [];
    if (projectIds.length) {
      clauses.push(`${alias}.projectId IN (${placeholders(projectIds.length)})`);
      params.push(...projectIds);
    }
    if (scorerNames.length) {
      clauses.push(`${alias}.scorer IN (${placeholders(scorerNames.length)})`);
      params.push(...scorerNames);
    }
    return {
      clause: clauses.length ? `AND ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  async function countCompletedTasks(filters = {}) {
    const filter = completedTaskExportFilter(filters);
    return Number(
      (await db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM rating_tasks
           WHERE taskVersion = ?
             AND status = 'completed'
             ${filter.clause}`,
        )
        .get(taskVersion, ...filter.params)).total || 0,
    );
  }

  async function listCompletedTaskRows(filters = {}, limit = 200, offset = 0) {
    const filter = completedTaskExportFilter(filters, "rating_tasks");
    return await db
      .prepare(
        `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId, rating_tasks.taskVersion,
                rating_tasks.taskType, rating_tasks.status, rating_tasks.scorer, rating_tasks.ranking, rating_tasks.excludedImageIds, rating_tasks.correctImageIds, rating_tasks.rankingRelations,
                rating_tasks.submissionMode, rating_tasks.rankingActionCount,
                rating_tasks.startedAt, rating_tasks.completedAt, rating_tasks.durationMs, rating_tasks.editedAt, rating_tasks.editCount,
                rating_tasks.rollbackCount, rating_tasks.lastRolledBackAt, rating_tasks.lastRolledBackBy,
                rating_tasks.imageKey, rating_tasks.createdAt, rating_tasks.updatedAt,
                projects.name AS subjectName
         FROM rating_tasks
         JOIN projects ON projects.id = rating_tasks.projectId
         WHERE rating_tasks.taskVersion = ?
           AND rating_tasks.status = 'completed'
           ${filter.clause}
         ORDER BY rating_tasks.completedAt DESC NULLS LAST, rating_tasks.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(taskVersion, ...filter.params, limit, offset);
  }

  async function listCompletedExportProjects(filters = {}) {
    const exportFilter = completedTaskExportFilter(filters, "rating_tasks");
    return (await db
      .prepare(
        `SELECT projects.id AS projectId,
                projects.name AS projectName,
                COUNT(rating_tasks.id) AS taskCount
         FROM rating_tasks
         JOIN projects ON projects.id = rating_tasks.projectId
         WHERE rating_tasks.taskVersion = ?
           AND rating_tasks.status = 'completed'
           AND projects.deletionRequestedAt IS NULL
           ${exportFilter.clause}
         GROUP BY projects.id, projects.name
         ORDER BY projects.createdAt DESC, projects.id ASC`,
      )
      .all(taskVersion, ...exportFilter.params))
      .map((row) => ({
        projectId: row.projectId,
        projectName: row.projectName,
        taskCount: Number(row.taskCount || 0),
      }));
  }

  async function listCompletedExportScorers(filters = {}) {
    const exportFilter = completedTaskExportFilter(filters, "rating_tasks");
    return (await db
      .prepare(
        `SELECT users.id AS scorerId,
                rating_tasks.scorer AS scorer,
                users.status,
                COUNT(rating_tasks.id) AS taskCount
         FROM rating_tasks
         LEFT JOIN users ON users.username = rating_tasks.scorer
          AND users.role = 'scorer'
         WHERE rating_tasks.taskVersion = ?
           AND rating_tasks.status = 'completed'
           AND rating_tasks.scorer IS NOT NULL
           AND TRIM(rating_tasks.scorer) <> ''
           ${exportFilter.clause}
         GROUP BY users.id, rating_tasks.scorer, users.status
         ORDER BY taskCount DESC, LOWER(rating_tasks.scorer) ASC, rating_tasks.scorer ASC`,
      )
      .all(taskVersion, ...exportFilter.params))
      .map((row) => ({
        scorerId: row.scorerId,
        scorer: row.scorer,
        status: row.status || null,
        taskCount: Number(row.taskCount || 0),
      }));
  }

  async function projectTaskStatusCounts(projectId) {
    const row = await db
      .prepare(
        `SELECT pending, assigned, completed
         FROM project_task_stats
         WHERE projectId = ? AND taskVersion = ?`,
      )
      .get(projectId, taskVersion);
    return {
      pending: Number(row?.pending || 0),
      assigned: Number(row?.assigned || 0),
      completed: Number(row?.completed || 0),
    };
  }

  async function getProjectOrThrow(projectId) {
    const project = await db
      .prepare(
        `SELECT projects.id,
                projects.name,
                projects.taskStatus,
                projects.packageId
         FROM projects
         WHERE projects.id = ?
           AND projects.deletionRequestedAt IS NULL`,
      )
      .get(projectId);
    if (!project) throw httpError(404, "项目不存在");
    return project;
  }

  async function listProjectPackages(projectId, fallbackPackageId) {
    const rows = await db
      .prepare(
        `SELECT subjects.id,
                subjects.name,
                subjects.imageCount,
                subjects.categoryCount,
                subjects.taskStatus,
                subjects.status,
                COUNT(subject_task_templates.id) AS taskTemplateCount
         FROM project_packages
         JOIN subjects ON subjects.id = project_packages.packageId
         LEFT JOIN subject_task_templates ON subject_task_templates.subjectId = subjects.id
         WHERE project_packages.projectId = ?
         GROUP BY subjects.id, subjects.name, subjects.imageCount, subjects.categoryCount, subjects.taskStatus, subjects.status
         ORDER BY project_packages.createdAt ASC, LOWER(subjects.name) ASC, subjects.name ASC`,
      )
      .all(projectId);
    if (rows.length || !fallbackPackageId) return rows;
    return await db
      .prepare(
        `SELECT subjects.id,
                subjects.name,
                subjects.imageCount,
                subjects.categoryCount,
                subjects.taskStatus,
                subjects.status,
                COUNT(subject_task_templates.id) AS taskTemplateCount
         FROM subjects
         LEFT JOIN subject_task_templates ON subject_task_templates.subjectId = subjects.id
         WHERE subjects.id = ?
         GROUP BY subjects.id, subjects.name, subjects.imageCount, subjects.categoryCount, subjects.taskStatus, subjects.status`,
      )
      .all(fallbackPackageId);
  }

  async function getDashboardProjectSummary(projectId) {
    if (!projectId) return null;
    const project = await getProjectOrThrow(projectId);
    const packageRows = await listProjectPackages(project.id, project.packageId);
    const statusCounts = await projectTaskStatusCounts(projectId);
    const totalTasks = statusCounts.pending + statusCounts.assigned + statusCounts.completed;
    const criterionRows = await db
      .prepare(
        `SELECT DISTINCT taskType
         FROM rating_tasks
         WHERE projectId = ? AND taskVersion = ?`,
      )
      .all(projectId, taskVersion);
    const scorerCount = Number(
      (await db
        .prepare(
          `SELECT COUNT(DISTINCT scorer) AS total
           FROM rating_tasks
           WHERE projectId = ?
             AND taskVersion = ?
             AND scorer IS NOT NULL
             AND TRIM(scorer) <> ''`,
        )
        .get(projectId, taskVersion)).total || 0,
    );
    const averageDurationMs = (await db
      .prepare(
        `SELECT AVG(durationMs) AS value
         FROM rating_tasks
         WHERE projectId = ?
           AND taskVersion = ?
           AND status = 'completed'
           AND durationMs >= 0`,
      )
      .get(projectId, taskVersion)).value;

    return {
      projectId: project.id,
      projectName: project.name,
      taskStatus: project.taskStatus || "task_pending",
      packageCount: packageRows.length || (project.packageId ? 1 : 0),
      imageCount: packageRows.reduce((total, item) => total + Number(item.imageCount || 0), 0),
      categoryCount: packageRows.reduce((total, item) => total + Number(item.categoryCount || 0), 0),
      taskTemplateCount: packageRows.reduce((total, item) => total + Number(item.taskTemplateCount || 0), 0),
      totalTasks,
      pendingTaskCount: statusCounts.pending + statusCounts.assigned,
      unassignedTaskCount: statusCounts.pending,
      assignedTaskCount: statusCounts.assigned,
      completedTaskCount: statusCounts.completed,
      completionRate: reportCompletionRate(statusCounts.completed, totalTasks),
      scorerCount,
      criterionCount: new Set(
        criterionRows.map((row) => String(row.taskType || "").split(":")[1] || "").filter(Boolean),
      ).size,
      averageDurationSeconds: averageDurationMs == null ? null : averageDurationMs / 1000,
    };
  }

  async function listDashboardPeakHours(projectId = null) {
    const rows = await db
      .prepare(
        `SELECT EXTRACT(HOUR FROM completedAt AT TIME ZONE 'Asia/Shanghai')::integer AS hour,
                COUNT(*) AS count
         FROM rating_tasks
         WHERE taskVersion = ?
           AND status = 'completed'
           AND completedAt IS NOT NULL
           AND (?::text IS NULL OR projectId = ?)
         GROUP BY EXTRACT(HOUR FROM completedAt AT TIME ZONE 'Asia/Shanghai')
         ORDER BY hour ASC`,
      )
      .all(taskVersion, projectId, projectId);
    const countByHour = new Map(rows.map((row) => [Number(row.hour || 0), Number(row.count || 0)]));
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: `${String(hour).padStart(2, "0")}:00`,
      count: countByHour.get(hour) || 0,
    }));
  }

  function progressSummaryDto(row) {
    const totalTaskCount = Number(row.totalTaskCount || 0);
    const completedTaskCount = Number(row.completedTaskCount || 0);
    return {
      id: row.id,
      name: row.name,
      status: row.status ?? null,
      totalTaskCount,
      pendingTaskCount: Number(row.pendingTaskCount || 0),
      completedTaskCount,
      completionRate: reportCompletionRate(completedTaskCount, totalTaskCount),
      averageDurationSeconds: row.averageDurationMs == null ? null : row.averageDurationMs / 1000,
    };
  }

  async function listDashboardScorerProgress(projectId = null) {
    return (await db
      .prepare(
        `SELECT users.id,
                users.username AS name,
                users.status,
                COUNT(rating_tasks.id) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount,
                SUM(CASE WHEN rating_tasks.status <> 'completed' THEN 1 ELSE 0 END) AS pendingTaskCount,
                AVG(CASE WHEN rating_tasks.status = 'completed' AND rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS averageDurationMs
         FROM rating_tasks
         JOIN users ON users.username = rating_tasks.scorer
          AND users.role = 'scorer'
         WHERE rating_tasks.taskVersion = ?
           AND rating_tasks.scorer IS NOT NULL
           AND TRIM(rating_tasks.scorer) <> ''
           AND (?::text IS NULL OR rating_tasks.projectId = ?)
         GROUP BY users.id, users.username, users.status
         ORDER BY completedTaskCount DESC, totalTaskCount DESC, LOWER(users.username) ASC, users.username ASC
         LIMIT 12`,
      )
      .all(taskVersion, projectId, projectId))
      .map(progressSummaryDto);
  }

  async function listDashboardTeamProgress(projectId = null) {
    return (await db
      .prepare(
        `SELECT teams.id,
                teams.name,
                teams.status,
                COUNT(rating_tasks.id) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount,
                SUM(CASE WHEN rating_tasks.status <> 'completed' THEN 1 ELSE 0 END) AS pendingTaskCount,
                AVG(CASE WHEN rating_tasks.status = 'completed' AND rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS averageDurationMs
         FROM rating_tasks
         JOIN users ON users.username = rating_tasks.scorer
          AND users.role = 'scorer'
         JOIN user_teams ON user_teams.userId = users.id
         JOIN teams ON teams.id = user_teams.teamId
         WHERE rating_tasks.taskVersion = ?
           AND rating_tasks.scorer IS NOT NULL
           AND TRIM(rating_tasks.scorer) <> ''
           AND (?::text IS NULL OR rating_tasks.projectId = ?)
         GROUP BY teams.id, teams.name, teams.status
         ORDER BY completedTaskCount DESC, totalTaskCount DESC, LOWER(teams.name) ASC, teams.name ASC
         LIMIT 12`,
      )
      .all(taskVersion, projectId, projectId))
      .map(progressSummaryDto);
  }

  async function getDashboardProgressSummary(projectId = null) {
    return cachedDashboardValue(`progress:${projectId || "none"}`, async () => ({
      scorers: await listDashboardScorerProgress(projectId),
      teams: await listDashboardTeamProgress(projectId)
    }));
  }

  async function getDashboardStats() {
    return cachedDashboardValue("stats", async () => {
      const stats = await selectAdminDashboardStatsStmt.get(taskVersion, taskVersion, taskVersion, taskVersion, taskVersion);
      return {
        projectCount: Number(stats.projectCount || 0),
        completedProjectCount: Number(stats.completedProjectCount || 0),
        teamCount: Number(stats.teamCount || 0),
        scorerCount: Number(stats.scorerCount || 0),
        totalTaskCount: Number(stats.totalTaskCount || 0),
        unassignedTaskCount: Number(stats.unassignedTaskCount || 0),
        assignedTaskCount: Number(stats.assignedTaskCount || 0),
        pendingTaskCount: Number(stats.pendingTaskCount || 0),
        completedTaskCount: Number(stats.completedTaskCount || 0),
      };
    });
  }

  async function getDashboardProjectSection(query = {}) {
    const projectId = query.projectId
      ? await parseProjectId(query.projectId)
      : await defaultDashboardProjectId();
    return cachedDashboardValue(`project:${projectId || "none"}`, async () => ({
      selectedProjectId: projectId,
      projectSummary: await getDashboardProjectSummary(projectId)
    }));
  }

  async function getDashboardCharts() {
    return cachedDashboardValue("charts", async () => {
      return {
        peakHours: await listDashboardPeakHours(),
      };
    });
  }

  async function getDashboardAverageDuration() {
    return cachedDashboardValue("average-duration", async () => {
      const duration = await selectAdminDashboardAverageDurationStmt.get(taskVersion);
      return {
        averageDurationSeconds:
          duration.averageDurationMs == null ? null : duration.averageDurationMs / 1000,
      };
    });
  }

  async function getDashboardWorkloadSection(query = {}) {
    const key = `workload:${String(query.scorerId || "")}:${String(query.teamId || "")}`;
    return cachedDashboardValue(key, async () => await getDashboardWorkloadSummary(query));
  }

  function dashboardSummaryMetrics(row) {
    const totalTaskCount = Number(row?.totalTaskCount || 0);
    const completedTaskCount = Number(row?.completedTaskCount || 0);
    const pendingTaskCount = Number(row?.pendingTaskCount || 0);
    return {
      projectCount: Number(row?.projectCount || 0),
      totalTaskCount,
      pendingTaskCount,
      completedTaskCount,
      completionRate: reportCompletionRate(completedTaskCount, totalTaskCount),
      averageDurationSeconds: row?.averageDurationMs == null ? null : row.averageDurationMs / 1000,
    };
  }

  async function listDashboardScorerOptions() {
    return (await db
      .prepare(
        `SELECT users.id,
                users.username AS name,
                users.status,
                COUNT(rating_tasks.id) AS totalTaskCount
         FROM users
         LEFT JOIN rating_tasks ON rating_tasks.scorer = users.username
          AND rating_tasks.taskVersion = ?
         WHERE users.role = 'scorer'
         GROUP BY users.id, users.username, users.status
         ORDER BY totalTaskCount DESC, LOWER(users.username) ASC, users.username ASC`,
      )
      .all(taskVersion))
      .map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        totalTaskCount: Number(row.totalTaskCount || 0),
      }));
  }

  async function listDashboardTeamOptions() {
    return (await db
      .prepare(
        `SELECT teams.id,
                teams.name,
                teams.status,
                COUNT(DISTINCT users.id) AS userCount,
                COUNT(rating_tasks.id) AS totalTaskCount
         FROM teams
         LEFT JOIN user_teams ON user_teams.teamId = teams.id
         LEFT JOIN users ON users.id = user_teams.userId
          AND users.role = 'scorer'
         LEFT JOIN rating_tasks ON rating_tasks.scorer = users.username
          AND rating_tasks.taskVersion = ?
         GROUP BY teams.id, teams.name, teams.status
         ORDER BY totalTaskCount DESC, LOWER(teams.name) ASC, teams.name ASC`,
      )
      .all(taskVersion))
      .map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        userCount: Number(row.userCount || 0),
        totalTaskCount: Number(row.totalTaskCount || 0),
      }));
  }

  async function resolveDashboardScorerId(query, scorerOptions) {
    const scorerId = String(query.scorerId ?? "").trim();
    if (scorerId) {
      const user = await selectUserByIdStmt.get(scorerId);
      if (!user || user.role !== "scorer") throw httpError(400, "打分人不存在");
      return user.id;
    }

    const scorerName = String(query.scorer ?? "").trim();
    if (scorerName) {
      const user = await selectScorerByUsernameStmt.get(scorerName);
      if (!user) throw httpError(400, "打分人不存在");
      return user.id;
    }

    return scorerOptions.find((item) => item.totalTaskCount > 0)?.id || scorerOptions[0]?.id || null;
  }

  async function resolveDashboardTeamId(query, teamOptions) {
    const teamId = String(query.teamId ?? "").trim();
    if (teamId) {
      const team = await selectTeamByIdStmt.get(teamId);
      if (!team) throw httpError(400, "团队不存在");
      return team.id;
    }
    return teamOptions.find((item) => item.totalTaskCount > 0)?.id || teamOptions[0]?.id || null;
  }

  async function getDashboardScorerSummary(scorerId) {
    if (!scorerId) return null;
    const user = await selectUserByIdStmt.get(scorerId);
    if (!user || user.role !== "scorer") return null;
    const totals = await db
      .prepare(
        `SELECT COUNT(DISTINCT rating_tasks.projectId) AS projectCount,
                COUNT(rating_tasks.id) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount,
                SUM(CASE WHEN rating_tasks.status <> 'completed' THEN 1 ELSE 0 END) AS pendingTaskCount,
                AVG(CASE WHEN rating_tasks.status = 'completed' AND rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS averageDurationMs
         FROM rating_tasks
         JOIN projects ON projects.id = rating_tasks.projectId
          AND projects.deletionRequestedAt IS NULL
         WHERE rating_tasks.taskVersion = ?
           AND rating_tasks.scorer = ?`,
      )
      .get(taskVersion, user.username);
    const projects = (await db
      .prepare(
        `SELECT projects.id AS projectId,
                projects.name AS projectName,
                projects.taskStatus,
                COUNT(rating_tasks.id) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount,
                SUM(CASE WHEN rating_tasks.status <> 'completed' THEN 1 ELSE 0 END) AS pendingTaskCount,
                AVG(CASE WHEN rating_tasks.status = 'completed' AND rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS averageDurationMs
         FROM rating_tasks
         JOIN projects ON projects.id = rating_tasks.projectId
          AND projects.deletionRequestedAt IS NULL
         WHERE rating_tasks.taskVersion = ?
           AND rating_tasks.scorer = ?
         GROUP BY projects.id, projects.name, projects.taskStatus
         ORDER BY completedTaskCount DESC, totalTaskCount DESC, LOWER(projects.name) ASC, projects.name ASC`,
      )
      .all(taskVersion, user.username))
      .map((row) => {
        const metrics = dashboardSummaryMetrics(row);
        return {
          projectId: row.projectId,
          projectName: row.projectName,
          taskStatus: row.taskStatus,
          totalTaskCount: metrics.totalTaskCount,
          pendingTaskCount: metrics.pendingTaskCount,
          completedTaskCount: metrics.completedTaskCount,
          completionRate: metrics.completionRate,
          averageDurationSeconds: metrics.averageDurationSeconds,
        };
      });
    return {
      id: user.id,
      name: user.username,
      status: user.status || "enabled",
      ...dashboardSummaryMetrics(totals),
      projects,
    };
  }

  async function getDashboardTeamSummary(teamId) {
    if (!teamId) return null;
    const team = await selectTeamByIdStmt.get(teamId);
    if (!team) return null;
    const totals = await db
      .prepare(
        `SELECT COUNT(DISTINCT rating_tasks.projectId) AS projectCount,
                COUNT(rating_tasks.id) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount,
                SUM(CASE WHEN rating_tasks.status <> 'completed' THEN 1 ELSE 0 END) AS pendingTaskCount,
                AVG(CASE WHEN rating_tasks.status = 'completed' AND rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS averageDurationMs,
                COUNT(DISTINCT users.id) AS userCount
         FROM user_teams
         JOIN users ON users.id = user_teams.userId
          AND users.role = 'scorer'
         LEFT JOIN rating_tasks ON rating_tasks.scorer = users.username
          AND rating_tasks.taskVersion = ?
         WHERE user_teams.teamId = ?`,
      )
      .get(taskVersion, team.id);
    const members = (await db
      .prepare(
        `SELECT users.id,
                users.username AS name,
                users.status,
                COUNT(DISTINCT rating_tasks.projectId) AS projectCount,
                COUNT(rating_tasks.id) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount,
                SUM(CASE WHEN rating_tasks.status <> 'completed' THEN 1 ELSE 0 END) AS pendingTaskCount,
                AVG(CASE WHEN rating_tasks.status = 'completed' AND rating_tasks.durationMs >= 0 THEN rating_tasks.durationMs END) AS averageDurationMs
         FROM user_teams
         JOIN users ON users.id = user_teams.userId
          AND users.role = 'scorer'
         LEFT JOIN rating_tasks ON rating_tasks.scorer = users.username
          AND rating_tasks.taskVersion = ?
         WHERE user_teams.teamId = ?
         GROUP BY users.id, users.username, users.status
         ORDER BY totalTaskCount DESC, completedTaskCount DESC, LOWER(users.username) ASC, users.username ASC`,
      )
      .all(taskVersion, team.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        ...dashboardSummaryMetrics(row),
      }));
    return {
      id: team.id,
      name: team.name,
      status: team.status,
      userCount: Number(totals?.userCount || 0),
      ...dashboardSummaryMetrics(totals),
      members,
    };
  }

  async function getDashboardWorkloadSummary(query = {}) {
    const scorers = await listDashboardScorerOptions();
    const teams = await listDashboardTeamOptions();
    const selectedScorerId = await resolveDashboardScorerId(query, scorers);
    const selectedTeamId = await resolveDashboardTeamId(query, teams);
    return {
      selectedScorerId,
      selectedTeamId,
      scorers,
      teams,
      scorer: await getDashboardScorerSummary(selectedScorerId),
      team: await getDashboardTeamSummary(selectedTeamId),
    };
  }

  async function listAdminDashboard(query = {}) {
    const { page, pageSize } = parseTaskPagination(query);
    const stats = await getDashboardStats();
    const projectSection = await getDashboardProjectSection(query);
    const charts = await getDashboardCharts();
    const averageDuration = await getDashboardAverageDuration();
    const workloadSummary = await getDashboardWorkloadSection(query);

    return {
      ...stats,
      ...projectSection,
      peakHours: charts.peakHours,
      averageDurationSeconds: averageDuration.averageDurationSeconds,
      progressSummary: await getDashboardProgressSummary(),
      workloadSummary,
      total: stats.completedTaskCount,
      page,
      pageSize,
      tasks: [],
    };
  }

  async function listTeamTaskSummaryRows(teamIds) {
    return (await db
      .prepare(
        `SELECT teams.id AS teamId,
                teams.name AS teamName,
                users.username AS scorer,
                COUNT(rating_tasks.id) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount,
                SUM(CASE WHEN rating_tasks.status <> 'completed' THEN 1 ELSE 0 END) AS uncompletedTaskCount
         FROM teams
         JOIN user_teams ON user_teams.teamId = teams.id
         JOIN users ON users.id = user_teams.userId
          AND users.role = 'scorer'
         LEFT JOIN rating_tasks ON rating_tasks.scorer = users.username
          AND rating_tasks.taskVersion = ?
          AND rating_tasks.projectId IN (
            SELECT id
            FROM projects
            WHERE deletionRequestedAt IS NULL
          )
         WHERE teams.id IN (${placeholders(teamIds.length)})
         GROUP BY teams.id, teams.name, users.id, users.username
         ORDER BY LOWER(teams.name) ASC, teams.name ASC, LOWER(users.username) ASC, users.username ASC`,
      )
      .all(taskVersion, ...teamIds))
      .map((row) => {
        const totalTaskCount = Number(row.totalTaskCount || 0);
        const completedTaskCount = Number(row.completedTaskCount || 0);
        const uncompletedTaskCount = Number(row.uncompletedTaskCount || 0);
        return {
          teamId: row.teamId,
          teamName: row.teamName,
          scorer: row.scorer,
          totalTaskCount,
          completedTaskCount,
          uncompletedTaskCount,
          completionRate: reportCompletionRate(completedTaskCount, totalTaskCount),
        };
      });
  }

  async function listTeamSummaryExportTeams(teamIds, rows) {
    const rowsByTeamId = new Map();
    rows.forEach((row) => {
      const items = rowsByTeamId.get(row.teamId) || [];
      items.push({
        scorer: row.scorer,
        totalTaskCount: row.totalTaskCount,
        completedTaskCount: row.completedTaskCount,
        uncompletedTaskCount: row.uncompletedTaskCount,
        completionRate: row.completionRate,
      });
      rowsByTeamId.set(row.teamId, items);
    });
    return (await db
      .prepare(
        `SELECT id AS teamId, name AS teamName
         FROM teams
         WHERE id IN (${placeholders(teamIds.length)})
         ORDER BY LOWER(name) ASC, name ASC`,
      )
      .all(...teamIds))
      .map((team) => ({
        teamId: team.teamId,
        teamName: team.teamName,
        scorers: rowsByTeamId.get(team.teamId) || [],
      }));
  }

  async function exportCompletedTasks(req, res) {
    const projectIds = await parseDashboardProjectIds(req.query);
    const filters = { projectIds };
    const taskCount = await countCompletedTasks(filters);
    const projects = await listCompletedExportProjects(filters);
    const jsonFilename = `completed-tasks-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${jsonFilename}"`,
    );
    res.flushHeaders();
    await writeResponseChunk(
      res,
      `{"exportedAt":${JSON.stringify(nowIso())},"projectIds":${JSON.stringify(projectIds)},"filters":{"projectIds":${JSON.stringify(projectIds)}},"projectCount":${projects.length},"taskCount":${taskCount},"projects":${JSON.stringify(projects)},"tasks":[`,
    );

    const batchSize = 200;
    let written = 0;
    for (let offset = 0; offset < taskCount; offset += batchSize) {
      const rows = await listCompletedTaskRows(filters, batchSize, offset);
      const tasks = await hydrateTaskRows(rows);
      for (const task of tasks) {
        await writeResponseChunk(
          res,
          `${written ? "," : ""}${JSON.stringify(task)}`,
        );
        written += 1;
      }
    }
    res.end("]}");
  }

  async function exportScorerTaskSummary(req, res) {
    const scorerIds = await parseDashboardScorerIds(req.query);
    const scorerUsers = await listDashboardScorerExportUsers(scorerIds);
    const scorerNames = scorerUsers.map((user) => user.username);
    const filters = { scorerNames };
    const taskCount = await countCompletedTasks(filters);
    const projects = await listCompletedExportProjects(filters);
    const scorers = await listCompletedExportScorers(filters);
    const jsonFilename = `scorer-completed-tasks-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${jsonFilename}"`,
    );
    res.flushHeaders();
    await writeResponseChunk(
      res,
      `{"exportedAt":${JSON.stringify(nowIso())},"scorerIds":${JSON.stringify(scorerIds)},"filters":{"scorerIds":${JSON.stringify(scorerIds)},"scorers":${JSON.stringify(scorerNames)}},"scorerCount":${scorers.length},"projectCount":${projects.length},"taskCount":${taskCount},"scorers":${JSON.stringify(scorers)},"projects":${JSON.stringify(projects)},"tasks":[`,
    );

    const batchSize = 200;
    let written = 0;
    for (let offset = 0; offset < taskCount; offset += batchSize) {
      const rows = await listCompletedTaskRows(filters, batchSize, offset);
      const tasks = await hydrateTaskRows(rows);
      for (const task of tasks) {
        await writeResponseChunk(
          res,
          `${written ? "," : ""}${JSON.stringify(task)}`,
        );
        written += 1;
      }
    }
    res.end("]}");
  }

  async function exportTeamTaskSummary(req, res) {
    const teamIds = await parseTeamSummaryExportIds(req.query);
    const rows = await listTeamTaskSummaryRows(teamIds);
    const teams = await listTeamSummaryExportTeams(teamIds, rows);
    const distinctScorers = new Set(rows.map((row) => row.scorer));
    const jsonFilename = `team-task-summary-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${jsonFilename}"`,
    );
    res.json({
      exportedAt: nowIso(),
      teamIds,
      teamCount: teams.length,
      scorerCount: distinctScorers.size,
      teams,
      rows,
    });
  }

  return {
    listAdminDashboard,
    getDashboardStats,
    getDashboardProjectSection,
    getDashboardCharts,
    getDashboardAverageDuration,
    getDashboardWorkloadSection,
    exportCompletedTasks,
    exportScorerTaskSummary,
    exportTeamTaskSummary,
  };
}
