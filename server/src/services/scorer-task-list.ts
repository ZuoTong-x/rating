import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type Query = Record<string, unknown>;
type ScorerFilter = {
  where: string;
  params: string[];
  scorer: string;
  projectId: string | null;
  status: string | null;
  criterion: string;
  activeGenerationProjectIds: string[];
};
type TaskListRow = {
  id: string;
  subjectId: string;
  projectId: string;
  taskType: string;
  status: string;
  assignmentKey: number;
  createdAt: string;
  subjectName: string | null;
};
type DetailRow = TaskListRow & { taskVersion: string; scorer: string };
type HydratedTaskListRow = TaskListRow & { items: unknown[] };
type TaskListResponse = {
  total: number | null;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  tasks: Array<{ id: string; subjectId: string; projectId: string; subjectName: string | null; criterion: string | null; status: string; items: unknown[] }>;
};
type DashboardResponse = { pendingTasks: number; completedTasks: number; totalTasks: number; projectCount: unknown; progress: number };

export function createScorerTaskListService({
    taskCriteria, selectScorerTaskListTotalStmt, taskVersion,
    assignedTaskCountCache, assignedTaskCountCacheTtlMs, db,
    selectScorerByUsernameStmt, httpError, hasActiveTaskGeneration,
    assignedTaskListCache, assignedTaskListCacheTtlMs,
    getAssignedTaskCacheVersion, buildScorerTaskFilter,
    parseTaskPagination, parseTaskCursor, includeTaskTotal,
    serializeTaskCursor, hydrateTaskListRows, selectTaskByIdStmt,
    assertProjectTasksUnlocked, claimTaskForScorer, parseTaskClaimToken,
    hydrateTaskRows, parseScorerName, parseProjectId,
    selectScorerTaskStatsStmt, selectScorerProjectCountStmt,
    scorerDashboardCache, scorerDashboardCacheTtlMs,
}: {
  taskCriteria: string[];
  selectScorerTaskListTotalStmt: Statement;
  taskVersion: string;
  assignedTaskCountCache: Map<string, { value: number; expiresAt: number }>;
  assignedTaskCountCacheTtlMs: number;
  db: typeof database;
  selectScorerByUsernameStmt: Statement;
  httpError: (status: number, message: string) => Error;
  hasActiveTaskGeneration: (id: string) => boolean;
  assignedTaskListCache: Map<string, { value: TaskListResponse; expiresAt: number }>;
  assignedTaskListCacheTtlMs: number;
  getAssignedTaskCacheVersion: () => number;
  buildScorerTaskFilter: (query: Query) => Promise<ScorerFilter>;
  parseTaskPagination: (query: Query) => { page: number; pageSize: number };
  parseTaskCursor: (value: unknown) => { assignmentKey: number | null; id: string } | null;
  includeTaskTotal: (query: Query) => boolean;
  serializeTaskCursor: (row: TaskListRow) => string;
  hydrateTaskListRows: (rows: TaskListRow[]) => Promise<HydratedTaskListRow[]>;
  selectTaskByIdStmt: Statement;
  assertProjectTasksUnlocked: (id: string) => Promise<unknown>;
  claimTaskForScorer: (id: string, scorer: string, token: string | null) => Promise<Record<string, unknown>>;
  parseTaskClaimToken: (value: unknown) => string | null;
  hydrateTaskRows: (rows: DetailRow[], options: { includeAdminFields: boolean }) => Promise<unknown[]>;
  parseScorerName: (value: unknown) => string | null;
  parseProjectId: (value: unknown) => Promise<string>;
  selectScorerTaskStatsStmt: Statement;
  selectScorerProjectCountStmt: Statement;
  scorerDashboardCache: Map<string, { value: DashboardResponse; expiresAt: number }>;
  scorerDashboardCacheTtlMs: number;
}) {
async function getAssignedTaskListTotal(query: Query, filter: ScorerFilter) {
  const hasCriterion = taskCriteria.includes(filter.criterion);
  const hasAvailabilityFilter = ["1", "true", "yes"].includes(
    String(query.availableOnly ?? "").toLowerCase(),
  );
  const hasExcludedTask = Boolean(String(query.excludeTaskId || "").trim());

  if (
    !hasCriterion &&
    !hasAvailabilityFilter &&
    !hasExcludedTask &&
    !filter.activeGenerationProjectIds?.length
  ) {
    const row = await selectScorerTaskListTotalStmt.get(
      filter.status,
      filter.status,
      taskVersion,
      filter.scorer,
      filter.projectId,
      filter.projectId,
    );
    return Number(row?.total || 0);
  }

  const cacheKey = JSON.stringify({
    scorer: filter.scorer,
    projectId: filter.projectId,
    status: filter.status,
    criterion: filter.criterion,
    availableOnly: hasAvailabilityFilter,
    excludeTaskId: query.excludeTaskId || null,
  });
  const cached = assignedTaskCountCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = Number(
    (await db.prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${filter.where}`)
      .get(...filter.params))?.total || 0,
  );
  if (assignedTaskCountCache.size >= 256) {
    const oldestKey = assignedTaskCountCache.keys().next().value;
    if (oldestKey) assignedTaskCountCache.delete(oldestKey);
  }
  assignedTaskCountCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + assignedTaskCountCacheTtlMs,
  });
  return value;
}

async function assignedTaskOptions(query: Query = {}) {
  const scorer = String(query.scorer || "").trim();
  if (!scorer) throw httpError(400, "缺少打分人");
  if (!(await selectScorerByUsernameStmt.get(scorer))) {
    throw httpError(404, "打分账号不存在");
  }
  const rows = await db.prepare(`
    SELECT projects.id AS _id, projects.name
    FROM scorer_task_stats
    JOIN projects ON projects.id = scorer_task_stats.projectId
    WHERE scorer_task_stats.taskVersion = ?
      AND scorer_task_stats.scorer = ?
      AND scorer_task_stats.projectId <> ''
      AND (scorer_task_stats.assigned + scorer_task_stats.completed) > 0
      AND projects.deletionRequestedAt IS NULL
      AND projects.tasksLocked = false
    ORDER BY projects.createdAt DESC, projects.id ASC
  `).all(taskVersion, scorer);
  return {
    projects: rows
      .filter(({ _id }) => !hasActiveTaskGeneration(String(_id)))
      .map(({ _id, name }) => ({ _id, name })),
  };
}

async function listAssignedTasks(query: Query = {}) {
  const cacheVersion = getAssignedTaskCacheVersion();
  const cacheKey = JSON.stringify({
    scorer: query.scorer || null,
    projectId: query.projectId || null,
    page: query.page || 1,
    pageSize: query.pageSize || 10,
    cursor: query.cursor || null,
    status: query.status || null,
    criterion: query.criterion || null,
    excludeTaskId: query.excludeTaskId || null,
    summaryOnly: query.summaryOnly || null,
    availableOnly: query.availableOnly || null,
    includeTotal: includeTaskTotal(query),
  });
  const cached = assignedTaskListCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const filter = await buildScorerTaskFilter(query);
  const { page, pageSize } = parseTaskPagination(query);
  const cursor = parseTaskCursor(query.cursor);
  const cursorAssignmentKey = cursor?.assignmentKey;
  const useCursor = Boolean(cursor && cursorAssignmentKey != null);
  const cursorWhere = useCursor
    ? ` AND (
         rating_tasks.assignmentKey > ?
         OR (rating_tasks.assignmentKey = ? AND rating_tasks.id > ?)
       )`
    : "";
  const total = includeTaskTotal(query)
    ? await getAssignedTaskListTotal(query, filter)
    : null;
  const rows = await db
    .prepare(
      `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
              rating_tasks.taskType, rating_tasks.status,
              rating_tasks.assignmentKey, rating_tasks.createdAt,
              projects.name AS subjectName
       FROM rating_tasks
       JOIN projects ON projects.id = rating_tasks.projectId
       ${filter.where}
       ${cursorWhere}
       ORDER BY rating_tasks.assignmentKey ASC,
                rating_tasks.id ASC
       LIMIT ?${useCursor ? "" : " OFFSET ?"}`,
    )
    .all(...filter.params, ...(!useCursor
    ? []
    : [cursorAssignmentKey, cursorAssignmentKey, cursor!.id]), pageSize + 1, ...(useCursor ? [] : [(page - 1) * pageSize])) as TaskListRow[];
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows[pageRows.length - 1];
  const summaryOnly = ["1", "true", "yes"].includes(
    String(query.summaryOnly ?? "").toLowerCase(),
  );
  const hydratedRows = summaryOnly
    ? pageRows.map((row) => ({ ...row, items: [] }))
    : await hydrateTaskListRows(pageRows);

  const value = {
    total,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && lastRow
      ? serializeTaskCursor(lastRow)
      : null,
    tasks: hydratedRows.map((row) => ({
      id: row.id,
      subjectId: row.projectId || row.subjectId,
      projectId: row.projectId || row.subjectId,
      subjectName: row.subjectName ?? null,
      criterion: row.taskType.split(":")[1] || null,
      status: row.status,
      items: row.items,
    })),
  };
  if (cacheVersion === getAssignedTaskCacheVersion()) {
    if (assignedTaskListCache.size >= 256) {
      const oldestKey = assignedTaskListCache.keys().next().value;
      if (oldestKey) assignedTaskListCache.delete(oldestKey);
    }
    assignedTaskListCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + assignedTaskListCacheTtlMs,
    });
  }
  return value;
}

async function getTaskDetail(
  taskId: string,
  { projectId = null, scorer = null, claimToken = null, includeAdminFields = false }: {
    projectId?: string | null;
    scorer?: string | null;
    claimToken?: unknown;
    includeAdminFields?: boolean;
  } = {},
) {
  let task = await selectTaskByIdStmt.get(taskId) as DetailRow | undefined;
  if (!task || task.taskVersion !== taskVersion) {
    throw httpError(404, "任务不存在");
  }
  if (projectId && (task.projectId || task.subjectId) !== projectId) {
    throw httpError(404, "任务不存在");
  }
  if (scorer && task.scorer !== scorer) {
    throw httpError(403, "无权查看该任务");
  }
  if (scorer) await assertProjectTasksUnlocked(task.projectId || task.subjectId);
  if (scorer && !["assigned", "completed"].includes(task.status)) {
    throw httpError(403, "当前任务不可查看");
  }
  if (scorer && task.status === "assigned") {
    task = await claimTaskForScorer(
      taskId,
      scorer,
      parseTaskClaimToken(claimToken),
    ) as DetailRow;
  }
  return (await hydrateTaskRows([task], { includeAdminFields }))[0];
}

async function getScorerDashboard(query: Query = {}) {
  const scorer = parseScorerName(query.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const projectId = query.projectId ? await parseProjectId(query.projectId) : null;
  if (!(await selectScorerByUsernameStmt.get(scorer)))
    throw httpError(404, "打分账号不存在");

  const cacheKey = `${scorer}:${projectId || "all"}`;
  const cached = scorerDashboardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const stats = await selectScorerTaskStatsStmt.get(taskVersion, scorer, projectId, projectId);
  const pendingTasks = Number(stats.pendingTasks || 0);
  const completedTasks = Number(stats.completedTasks || 0);
  const totalTasks = pendingTasks + completedTasks;

  const value = {
    pendingTasks,
    completedTasks,
    totalTasks,
    projectCount: (await selectScorerProjectCountStmt.get(taskVersion, scorer)).total,
    progress: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
  };
  scorerDashboardCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + scorerDashboardCacheTtlMs,
  });
  return value;
}

  return { assignedTaskOptions, listAssignedTasks, getTaskDetail, getScorerDashboard };
}
