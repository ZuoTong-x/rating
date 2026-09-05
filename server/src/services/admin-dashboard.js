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

async function endResponseStream(stream, chunk = "") {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off?.("finish", onFinish);
      reject(error);
    };
    const onFinish = () => {
      stream.off?.("error", onError);
      resolve();
    };
    stream.once?.("error", onError);
    stream.once?.("finish", onFinish);
    stream.end(chunk);
  });
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

function parseBooleanFlag(value) {
  if (Array.isArray(value)) return value.some((item) => parseBooleanFlag(item));
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
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
  let dashboardHourStatsInitialized = false;
  let dashboardHourStatsInitPromise = null;

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

  function parseOptionalExportDate(value, label) {
    if (Array.isArray(value)) return parseOptionalExportDate(value[0], label);
    const text = String(value ?? "").trim();
    if (!text) return null;
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw httpError(400, `${label}不正确`);
    return date.toISOString();
  }

  function parseCompletedTaskDateRange(query = {}) {
    const completedFrom = parseOptionalExportDate(query.completedFrom, "开始完成时间");
    const completedTo = parseOptionalExportDate(query.completedTo, "结束完成时间");
    if (completedFrom && completedTo && new Date(completedFrom).getTime() > new Date(completedTo).getTime()) {
      throw httpError(400, "完成时间范围不正确");
    }
    return { completedFrom, completedTo };
  }

  function completedTaskExportFilter({
    projectIds = [],
    scorerNames = [],
    completedFrom = null,
    completedTo = null,
  } = {}, alias = "rating_tasks") {
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
    if (completedFrom) {
      clauses.push(`${alias}.completedAt >= ?::timestamptz`);
      params.push(completedFrom);
    }
    if (completedTo) {
      clauses.push(`${alias}.completedAt <= ?::timestamptz`);
      params.push(completedTo);
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

  async function listCompletedTaskRowsAfter(filters = {}, limit = 1000, lastId = null) {
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
           AND (?::text IS NULL OR rating_tasks.id > ?)
         ORDER BY rating_tasks.id ASC
         LIMIT ?`,
      )
      .all(taskVersion, ...filter.params, lastId, lastId, limit);
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
         GROUP BY project_packages.createdAt,
                  subjects.id,
                  subjects.name,
                  subjects.imageCount,
                  subjects.categoryCount,
                  subjects.taskStatus,
                  subjects.status
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
    const taskSummary = await db
      .prepare(
        `SELECT COUNT(DISTINCT NULLIF(BTRIM(scorer), '')) AS scorerCount,
                COUNT(DISTINCT NULLIF(split_part(taskType, ':', 2), '')) AS criterionCount,
                AVG(CASE
                  WHEN status = 'completed' AND durationMs >= 0 THEN durationMs
                END) AS averageDurationMs
         FROM rating_tasks
         WHERE projectId = ? AND taskVersion = ?`,
      )
      .get(projectId, taskVersion);

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
      scorerCount: Number(taskSummary?.scorerCount || 0),
      criterionCount: Number(taskSummary?.criterionCount || 0),
      averageDurationSeconds: taskSummary?.averageDurationMs == null
        ? null
        : taskSummary.averageDurationMs / 1000,
    };
  }

  async function listDashboardPeakHours(projectId = null) {
    if (!projectId) {
      if (!dashboardHourStatsInitialized) {
        dashboardHourStatsInitPromise ||= (async () => {
          const existing = await db
            .prepare(
              `SELECT 1
               FROM dashboard_completion_hour_stats
               WHERE taskVersion = ?
               LIMIT 1`,
            )
            .get(taskVersion);
          if (!existing) {
            await db
              .prepare(
                `INSERT INTO dashboard_completion_hour_stats
                   (taskVersion, hour, completedTaskCount, updatedAt)
                 SELECT ?, EXTRACT(HOUR FROM completedAt AT TIME ZONE 'Asia/Shanghai')::integer,
                        COUNT(*), CURRENT_TIMESTAMP
                 FROM rating_tasks
                 WHERE taskVersion = ?
                   AND status = 'completed'
                   AND completedAt IS NOT NULL
                 GROUP BY EXTRACT(HOUR FROM completedAt AT TIME ZONE 'Asia/Shanghai')
                 ON CONFLICT (taskVersion, hour) DO UPDATE SET
                   completedTaskCount = EXCLUDED.completedTaskCount,
                   updatedAt = EXCLUDED.updatedAt`,
              )
              .run(taskVersion, taskVersion);
          }
          dashboardHourStatsInitialized = true;
        })().catch((error) => {
          dashboardHourStatsInitPromise = null;
          throw error;
        });
        await dashboardHourStatsInitPromise;
      }
    }
    const source = projectId
      ? await db
        .prepare(
          `SELECT EXTRACT(HOUR FROM completedAt AT TIME ZONE 'Asia/Shanghai')::integer AS hour,
                  COUNT(*) AS count
           FROM rating_tasks
           WHERE taskVersion = ?
             AND status = 'completed'
             AND completedAt IS NOT NULL
             AND projectId = ?
           GROUP BY EXTRACT(HOUR FROM completedAt AT TIME ZONE 'Asia/Shanghai')
           ORDER BY hour ASC`,
        )
        .all(taskVersion, projectId)
      : await db
        .prepare(
          `SELECT hour, completedTaskCount AS count
           FROM dashboard_completion_hour_stats
           WHERE taskVersion = ?
           ORDER BY hour ASC`,
        )
        .all(taskVersion);
    const countByHour = new Map(source.map((row) => [Number(row.hour || 0), Number(row.count || 0)]));
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
        `WITH durations AS (
           SELECT scorer, projectId,
                  SUM(CASE WHEN status = 'completed' AND durationMs >= 0 THEN durationMs ELSE 0 END) AS durationTotal,
                  COUNT(*) FILTER (WHERE status = 'completed' AND durationMs >= 0) AS durationCount
           FROM rating_tasks
           WHERE taskVersion = ?
           GROUP BY scorer, projectId
         )
         SELECT users.id,
                users.username AS name,
                users.status,
                COALESCE(SUM(scorer_task_stats.assigned + scorer_task_stats.completed), 0) AS totalTaskCount,
                COALESCE(SUM(scorer_task_stats.completed), 0) AS completedTaskCount,
                COALESCE(SUM(scorer_task_stats.assigned), 0) AS pendingTaskCount,
                CASE
                  WHEN COALESCE(SUM(durations.durationCount), 0) > 0
                  THEN SUM(durations.durationTotal) / SUM(durations.durationCount)
                END AS averageDurationMs
         FROM scorer_task_stats
         JOIN users ON users.username = scorer_task_stats.scorer
          AND users.role = 'scorer'
         LEFT JOIN durations
           ON durations.scorer = scorer_task_stats.scorer
          AND durations.projectId = scorer_task_stats.projectId
         WHERE scorer_task_stats.taskVersion = ?
           AND scorer_task_stats.projectId <> ''
           AND (?::text IS NULL OR scorer_task_stats.projectId = ?)
         GROUP BY users.id, users.username, users.status
         ORDER BY completedTaskCount DESC, totalTaskCount DESC, LOWER(users.username) ASC, users.username ASC
         LIMIT 12`,
      )
      .all(taskVersion, taskVersion, projectId, projectId))
      .map(progressSummaryDto);
  }

  async function listDashboardTeamProgress(projectId = null) {
    return (await db
      .prepare(
        `WITH durations AS (
           SELECT scorer, projectId,
                  SUM(CASE WHEN status = 'completed' AND durationMs >= 0 THEN durationMs ELSE 0 END) AS durationTotal,
                  COUNT(*) FILTER (WHERE status = 'completed' AND durationMs >= 0) AS durationCount
           FROM rating_tasks
           WHERE taskVersion = ?
           GROUP BY scorer, projectId
         )
         SELECT teams.id,
                teams.name,
                teams.status,
                COALESCE(SUM(scorer_task_stats.assigned + scorer_task_stats.completed), 0) AS totalTaskCount,
                COALESCE(SUM(scorer_task_stats.completed), 0) AS completedTaskCount,
                COALESCE(SUM(scorer_task_stats.assigned), 0) AS pendingTaskCount,
                CASE
                  WHEN COALESCE(SUM(durations.durationCount), 0) > 0
                  THEN SUM(durations.durationTotal) / SUM(durations.durationCount)
                END AS averageDurationMs
         FROM user_teams
         JOIN users ON users.id = user_teams.userId
          AND users.role = 'scorer'
         JOIN teams ON teams.id = user_teams.teamId
         LEFT JOIN scorer_task_stats
           ON scorer_task_stats.scorer = users.username
          AND scorer_task_stats.taskVersion = ?
          AND scorer_task_stats.projectId <> ''
          AND (?::text IS NULL OR scorer_task_stats.projectId = ?)
         LEFT JOIN durations
           ON durations.scorer = scorer_task_stats.scorer
          AND durations.projectId = scorer_task_stats.projectId
         GROUP BY teams.id, teams.name, teams.status
         ORDER BY completedTaskCount DESC, totalTaskCount DESC, LOWER(teams.name) ASC, teams.name ASC
         LIMIT 12`,
      )
      .all(taskVersion, taskVersion, projectId, projectId))
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
    const mode = query.mode === "team" || query.mode === "both" ? query.mode : "scorer";
    const key = `workload:${mode}:${String(query.scorerId || "")}:${String(query.teamId || "")}`;
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
                COALESCE(SUM(scorer_task_stats.assigned + scorer_task_stats.completed), 0) AS totalTaskCount
         FROM users
         LEFT JOIN scorer_task_stats ON scorer_task_stats.scorer = users.username
          AND scorer_task_stats.taskVersion = ?
          AND scorer_task_stats.projectId <> ''
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
                COALESCE(SUM(scorer_task_stats.assigned + scorer_task_stats.completed), 0) AS totalTaskCount
         FROM teams
         LEFT JOIN user_teams ON user_teams.teamId = teams.id
         LEFT JOIN users ON users.id = user_teams.userId
          AND users.role = 'scorer'
         LEFT JOIN scorer_task_stats ON scorer_task_stats.scorer = users.username
          AND scorer_task_stats.taskVersion = ?
          AND scorer_task_stats.projectId <> ''
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
    const projectRows = await db
      .prepare(
        `WITH durations AS (
           SELECT projectId,
                  SUM(CASE WHEN status = 'completed' AND durationMs >= 0 THEN durationMs ELSE 0 END) AS durationTotal,
                  COUNT(*) FILTER (WHERE status = 'completed' AND durationMs >= 0) AS durationCount
           FROM rating_tasks
           WHERE taskVersion = ? AND scorer = ?
           GROUP BY projectId
         )
         SELECT projects.id AS projectId,
                projects.name AS projectName,
                projects.taskStatus,
                COALESCE(scorer_task_stats.assigned + scorer_task_stats.completed, 0) AS totalTaskCount,
                COALESCE(scorer_task_stats.completed, 0) AS completedTaskCount,
                COALESCE(scorer_task_stats.assigned, 0) AS pendingTaskCount,
                COALESCE(durations.durationTotal, 0) AS durationTotal,
                COALESCE(durations.durationCount, 0) AS durationCount
         FROM scorer_task_stats
         JOIN projects ON projects.id = scorer_task_stats.projectId
          AND projects.deletionRequestedAt IS NULL
         LEFT JOIN durations ON durations.projectId = scorer_task_stats.projectId
         WHERE scorer_task_stats.taskVersion = ?
           AND scorer_task_stats.scorer = ?
           AND scorer_task_stats.projectId <> ''
         ORDER BY completedTaskCount DESC, totalTaskCount DESC, LOWER(projects.name) ASC, projects.name ASC`,
      )
      .all(taskVersion, user.username, taskVersion, user.username);
    const totals = projectRows.reduce((summary, row) => ({
      projectCount: summary.projectCount + 1,
      totalTaskCount: summary.totalTaskCount + Number(row.totalTaskCount || 0),
      pendingTaskCount: summary.pendingTaskCount + Number(row.pendingTaskCount || 0),
      completedTaskCount: summary.completedTaskCount + Number(row.completedTaskCount || 0),
      durationTotal: summary.durationTotal + Number(row.durationTotal || 0),
      durationCount: summary.durationCount + Number(row.durationCount || 0),
    }), {
      projectCount: 0,
      totalTaskCount: 0,
      pendingTaskCount: 0,
      completedTaskCount: 0,
      durationTotal: 0,
      durationCount: 0,
    });
    const projects = projectRows
      .map((row) => {
        const totalTaskCount = Number(row.totalTaskCount || 0);
        const completedTaskCount = Number(row.completedTaskCount || 0);
        return {
          projectId: row.projectId,
          projectName: row.projectName,
          taskStatus: row.taskStatus,
          totalTaskCount,
          pendingTaskCount: Number(row.pendingTaskCount || 0),
          completedTaskCount,
          completionRate: reportCompletionRate(completedTaskCount, totalTaskCount),
          averageDurationSeconds: Number(row.durationCount || 0)
            ? Number(row.durationTotal || 0) / Number(row.durationCount || 0) / 1000
            : null,
        };
      });
    return {
      id: user.id,
      name: user.username,
      status: user.status || "enabled",
      projectCount: totals.projectCount,
      totalTaskCount: totals.totalTaskCount,
      pendingTaskCount: totals.pendingTaskCount,
      completedTaskCount: totals.completedTaskCount,
      completionRate: reportCompletionRate(totals.completedTaskCount, totals.totalTaskCount),
      averageDurationSeconds: totals.durationCount
        ? totals.durationTotal / totals.durationCount / 1000
        : null,
      projects,
    };
  }

  async function getDashboardTeamSummary(teamId) {
    if (!teamId) return null;
    const team = await selectTeamByIdStmt.get(teamId);
    if (!team) return null;
    const totals = await db
      .prepare(
        `SELECT COUNT(DISTINCT scorer_task_stats.projectId) AS projectCount,
                COALESCE(SUM(scorer_task_stats.assigned + scorer_task_stats.completed), 0) AS totalTaskCount,
                COALESCE(SUM(scorer_task_stats.completed), 0) AS completedTaskCount,
                COALESCE(SUM(scorer_task_stats.assigned), 0) AS pendingTaskCount,
                COUNT(DISTINCT users.id) AS userCount
         FROM user_teams
         JOIN users ON users.id = user_teams.userId
          AND users.role = 'scorer'
         LEFT JOIN scorer_task_stats ON scorer_task_stats.scorer = users.username
          AND scorer_task_stats.taskVersion = ?
          AND scorer_task_stats.projectId <> ''
         WHERE user_teams.teamId = ?`,
      )
      .get(taskVersion, team.id);
    const memberRows = await db
      .prepare(
        `WITH durations AS (
           SELECT rating_tasks.scorer,
                  SUM(CASE
                    WHEN rating_tasks.status = 'completed' AND rating_tasks.durationMs >= 0
                    THEN rating_tasks.durationMs
                    ELSE 0
                  END) AS durationTotal,
                  COUNT(*) FILTER (
                    WHERE rating_tasks.status = 'completed' AND rating_tasks.durationMs >= 0
                  ) AS durationCount
           FROM rating_tasks
           JOIN users duration_users ON duration_users.username = rating_tasks.scorer
            AND duration_users.role = 'scorer'
           JOIN user_teams duration_members ON duration_members.userId = duration_users.id
           WHERE duration_members.teamId = ?
             AND rating_tasks.taskVersion = ?
           GROUP BY rating_tasks.scorer
         )
         SELECT users.id,
                users.username AS name,
                users.status,
                COUNT(DISTINCT scorer_task_stats.projectId) AS projectCount,
                COALESCE(SUM(scorer_task_stats.assigned + scorer_task_stats.completed), 0) AS totalTaskCount,
                COALESCE(SUM(scorer_task_stats.completed), 0) AS completedTaskCount,
                COALESCE(SUM(scorer_task_stats.assigned), 0) AS pendingTaskCount,
                COALESCE(durations.durationTotal, 0) AS durationTotal,
                COALESCE(durations.durationCount, 0) AS durationCount
         FROM user_teams
         JOIN users ON users.id = user_teams.userId
          AND users.role = 'scorer'
         LEFT JOIN scorer_task_stats ON scorer_task_stats.scorer = users.username
          AND scorer_task_stats.taskVersion = ?
          AND scorer_task_stats.projectId <> ''
         LEFT JOIN durations ON durations.scorer = users.username
         WHERE user_teams.teamId = ?
         GROUP BY users.id, users.username, users.status
         ORDER BY totalTaskCount DESC, completedTaskCount DESC, LOWER(users.username) ASC, users.username ASC`,
      )
      .all(team.id, taskVersion, taskVersion, team.id);
    const members = memberRows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        projectCount: Number(row.projectCount || 0),
        totalTaskCount: Number(row.totalTaskCount || 0),
        pendingTaskCount: Number(row.pendingTaskCount || 0),
        completedTaskCount: Number(row.completedTaskCount || 0),
        completionRate: reportCompletionRate(
          Number(row.completedTaskCount || 0),
          Number(row.totalTaskCount || 0),
        ),
        averageDurationSeconds: Number(row.durationCount || 0)
          ? Number(row.durationTotal || 0) / Number(row.durationCount || 0) / 1000
          : null,
      }));
    const teamDurationTotal = memberRows.reduce(
      (total, row) => total + Number(row.durationTotal || 0),
      0,
    );
    const teamDurationCount = memberRows.reduce(
      (total, row) => total + Number(row.durationCount || 0),
      0,
    );
    return {
      id: team.id,
      name: team.name,
      status: team.status,
      userCount: Number(totals?.userCount || 0),
      ...dashboardSummaryMetrics(totals),
      averageDurationSeconds: teamDurationCount
        ? teamDurationTotal / teamDurationCount / 1000
        : null,
      members,
    };
  }

  async function getDashboardWorkloadSummary(query = {}) {
    const mode = query.mode === "team" || query.mode === "both" ? query.mode : "scorer";
    const [scorers, teams] = await Promise.all([
      listDashboardScorerOptions(),
      listDashboardTeamOptions(),
    ]);
    const [selectedScorerId, selectedTeamId] = await Promise.all([
      resolveDashboardScorerId(query, scorers),
      resolveDashboardTeamId(query, teams),
    ]);
    const [scorer, team] = await Promise.all([
      mode === "team" ? Promise.resolve(null) : getDashboardScorerSummary(selectedScorerId),
      mode === "scorer" ? Promise.resolve(null) : getDashboardTeamSummary(selectedTeamId),
    ]);
    return {
      selectedScorerId,
      selectedTeamId,
      scorers,
      teams,
      scorer,
      team,
    };
  }

  async function listAdminDashboard(query = {}) {
    const { page, pageSize } = parseTaskPagination(query);
    const stats = await getDashboardStats();
    const projectSection = await getDashboardProjectSection(query);
    const charts = await getDashboardCharts();
    const averageDuration = await getDashboardAverageDuration();
    const workloadSummary = await getDashboardWorkloadSection({ ...query, mode: "both" });

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

  async function listTeamTaskSummaryRows(teamIds, options = {}) {
    const excludeInactiveScorers = Boolean(options.excludeInactiveScorers);
    const activeSince = options.activeSince || null;
    const activeClause = excludeInactiveScorers
      ? `AND EXISTS (
           SELECT 1
           FROM rating_tasks recent_tasks
           WHERE recent_tasks.scorer = users.username
             AND recent_tasks.taskVersion = ?
             AND recent_tasks.status = 'completed'
             AND recent_tasks.completedAt >= ?::timestamptz
         )`
      : "";
    const activeParams = excludeInactiveScorers ? [taskVersion, activeSince] : [];
    return (await db
      .prepare(
        `SELECT teams.id AS teamId,
                teams.name AS teamName,
                users.username AS scorer,
                COUNT(rating_tasks.id) AS totalTaskCount,
                SUM(CASE WHEN rating_tasks.status = 'completed' THEN 1 ELSE 0 END) AS completedTaskCount,
                SUM(CASE WHEN rating_tasks.status <> 'completed' THEN 1 ELSE 0 END) AS uncompletedTaskCount,
                MAX(CASE WHEN rating_tasks.status = 'completed' THEN rating_tasks.completedAt ELSE NULL END) AS lastCompletedAt
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
           ${activeClause}
         GROUP BY teams.id, teams.name, users.id, users.username
         ORDER BY LOWER(teams.name) ASC, teams.name ASC, LOWER(users.username) ASC, users.username ASC`,
      )
      .all(taskVersion, ...teamIds, ...activeParams))
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
          lastCompletedAt: row.lastCompletedAt ?? null,
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
        lastCompletedAt: row.lastCompletedAt ?? null,
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

  function exportProgress(onProgress, stage, progress) {
    onProgress?.({
      stage,
      progress: Math.max(0, Math.min(99, Math.round(progress))),
    });
  }

  async function writeCompletedTasksExport(stream, {
    filters,
    header,
    includeScorers = false,
  }, onProgress) {
    exportProgress(onProgress, "正在统计完成任务", 5);
    const taskCount = await countCompletedTasks(filters);
    exportProgress(onProgress, "正在准备导出摘要", 8);
    const projects = await listCompletedExportProjects(filters);
    const scorers = includeScorers ? await listCompletedExportScorers(filters) : null;
    const payload = {
      exportedAt: nowIso(),
      ...header,
      projectCount: projects.length,
      taskCount,
      ...(scorers ? { scorerCount: scorers.length, scorers } : {}),
      projects,
    };
    await writeResponseChunk(
      stream,
      `${JSON.stringify(payload).slice(0, -1)},"tasks":[`,
    );

    const batchSize = 1000;
    let written = 0;
    let lastId = null;
    while (true) {
      const rows = await listCompletedTaskRowsAfter(filters, batchSize, lastId);
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;
      const tasks = await hydrateTaskRows(rows);
      for (const task of tasks) {
        await writeResponseChunk(
          stream,
          `${written ? "," : ""}${JSON.stringify(task)}`,
        );
        written += 1;
      }
      exportProgress(
        onProgress,
        `已写入 ${written}/${taskCount} 个任务`,
        taskCount ? 10 + (written / taskCount) * 85 : 95,
      );
    }
    await endResponseStream(stream, "]}");
    return {
      taskCount,
      projectCount: projects.length,
      scorerCount: scorers?.length ?? null,
    };
  }

  async function writeProjectCompletedTasksExport(stream, query = {}, onProgress) {
    const projectIds = await parseDashboardProjectIds(query);
    const filters = { projectIds };
    return await writeCompletedTasksExport(stream, {
      filters,
      header: {
        projectIds,
        filters: { projectIds },
      },
    }, onProgress);
  }

  async function exportCompletedTasks(req, res) {
    const jsonFilename = `completed-tasks-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${jsonFilename}"`,
    );
    await writeProjectCompletedTasksExport(res, req.query);
  }

  async function writeScorerCompletedTasksExport(stream, query = {}, onProgress) {
    const scorerIds = await parseDashboardScorerIds(query);
    const scorerUsers = await listDashboardScorerExportUsers(scorerIds);
    const scorerNames = scorerUsers.map((user) => user.username);
    const completedRange = parseCompletedTaskDateRange(query);
    const filters = { scorerNames, ...completedRange };
    return await writeCompletedTasksExport(stream, {
      filters,
      includeScorers: true,
      header: {
        scorerIds,
        filters: {
          scorerIds,
          scorers: scorerNames,
          completedFrom: completedRange.completedFrom,
          completedTo: completedRange.completedTo,
        },
      },
    }, onProgress);
  }

  async function exportScorerTaskSummary(req, res) {
    const jsonFilename = `scorer-completed-tasks-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${jsonFilename}"`,
    );
    await writeScorerCompletedTasksExport(res, req.query);
  }

  async function writeTeamTaskSummaryExport(stream, query = {}, onProgress) {
    const teamIds = await parseTeamSummaryExportIds(query);
    const excludeInactiveScorers = parseBooleanFlag(query.excludeInactiveScorers);
    const inactiveWindowDays = 7;
    const activeSince = excludeInactiveScorers
      ? new Date(Date.now() - inactiveWindowDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    exportProgress(onProgress, "正在统计团队任务", 30);
    const rows = await listTeamTaskSummaryRows(teamIds, {
      excludeInactiveScorers,
      activeSince,
    });
    exportProgress(onProgress, "正在整理团队成员", 70);
    const teams = await listTeamSummaryExportTeams(teamIds, rows);
    const distinctScorers = new Set(rows.map((row) => row.scorer));
    await endResponseStream(stream, JSON.stringify({
      exportedAt: nowIso(),
      teamIds,
      filters: {
        teamIds,
        excludeInactiveScorers,
        activeSince,
        inactiveWindowDays: excludeInactiveScorers ? inactiveWindowDays : null,
      },
      teamCount: teams.length,
      scorerCount: distinctScorers.size,
      teams,
      rows,
    }));
    exportProgress(onProgress, "团队汇总已写入文件", 95);
    return {
      teamCount: teams.length,
      scorerCount: distinctScorers.size,
      rowCount: rows.length,
    };
  }

  async function exportTeamTaskSummary(req, res) {
    const jsonFilename = `team-task-summary-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${jsonFilename}"`,
    );
    await writeTeamTaskSummaryExport(res, req.query);
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
    writeProjectCompletedTasksExport,
    writeScorerCompletedTasksExport,
    writeTeamTaskSummaryExport,
  };
}
