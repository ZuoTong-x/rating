import type { db as database } from "../postgres.ts";

type TaskRow = {
  id: string; taskType: string; status: string; scorer: string | null;
  isBacktest: boolean; backtestSourceId: string | null; createdAt: string;
};
type TaskItemRow = { taskId: string; imageId: string; position: number; role: string | null };
type TaskCursor = { id: string; taskType: string; createdAt: string };
type TaskQuery = Record<string, unknown>;

export function createAdminTaskListService({
    db, taskListImageSelectColumns, taskListImageDto, placeholders,
    parseTaskPagination, parseScorerName, taskVersion, taskCriteria,
    parseTaskCursor, getProjectTaskStats, includeTaskTotal,
    serializeTaskCursor,
}: {
  db: typeof database;
  taskListImageSelectColumns: string;
  taskListImageDto: (row: Record<string, unknown>) => unknown;
  placeholders: (length: number) => string;
  parseTaskPagination: (query: TaskQuery) => { page: number; pageSize: number };
  parseScorerName: (value: unknown) => string | null;
  taskVersion: string;
  taskCriteria: string[];
  parseTaskCursor: (value: unknown) => TaskCursor | null;
  getProjectTaskStats: (id: string) => Promise<{
    total: number; pending: number; assigned: number; completed: number;
    baseTotal: number | null; basePending: number | null;
  }>;
  includeTaskTotal: (query: TaskQuery) => boolean;
  serializeTaskCursor: (row: TaskCursor) => string;
}) {
async function hydrateTaskListRows<T extends { id: string }>(rows: T[]) {
  const taskIds = rows.map((row) => row.id);
  const itemsByTaskId = new Map<string, Array<{ position: number; role: string; image: unknown }>>();

  if (taskIds.length) {
    const taskIdPlaceholders = placeholders(taskIds.length);
    const itemRows = await db
      .prepare(
        `
      SELECT taskId, imageId, position, role
      FROM rating_task_items
      WHERE taskId IN (${taskIdPlaceholders})
      ORDER BY taskId ASC, position ASC
    `,
      )
      .all(...taskIds) as TaskItemRow[];
    const imageIds = [...new Set(itemRows.map((item) => item.imageId))];
    const imageById = new Map<string, unknown>();

    if (imageIds.length) {
      const imageRows = await db
        .prepare(
          `
        SELECT ${taskListImageSelectColumns}
        FROM images
        WHERE id IN (${placeholders(imageIds.length)})
      `,
        )
        .all(...imageIds) as Array<Record<string, unknown> & { _id: string }>;
      imageRows.forEach((image) =>
        imageById.set(image._id, taskListImageDto(image)),
      );
    }

    itemRows.forEach((item) => {
      const image = imageById.get(item.imageId);
      if (!image) return;
      const currentItems = itemsByTaskId.get(item.taskId) || [];
      currentItems.push({
        position: item.position,
        role: item.role || "target",
        image,
      });
      itemsByTaskId.set(item.taskId, currentItems);
    });
  }

  return rows.map((row) => ({
    ...row,
    items: itemsByTaskId.get(row.id) || [],
  }));
}

function buildSubjectTaskFilter(projectId: string, query: TaskQuery = {}) {
  const clauses = ["projectId = ?", "taskVersion = ?"];
  const params = [projectId, taskVersion];
  const status = String(query.status || "");
  const scorer = parseScorerName(query.scorer);
  const criterion = String(query.criterion || "");

  if (["pending", "assigned", "completed"].includes(status)) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (scorer) {
    clauses.push("scorer = ?");
    params.push(scorer);
  }
  if (taskCriteria.includes(criterion)) {
    const taskType = `dimension:${criterion}`;
    clauses.push("(taskType = ? OR taskType LIKE ?)");
    params.push(taskType, `${taskType}:%`);
  }

  return {
    where: `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

async function listSubjectTaskOptions(projectId: string) {
  const scorers = (await db
    .prepare(
      `SELECT scorer
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ? AND scorer IS NOT NULL AND scorer <> ''
       GROUP BY scorer
       ORDER BY LOWER(scorer) ASC, scorer ASC`,
    )
    .all(projectId, taskVersion))
    .map((row) => row.scorer);

  return { scorers };
}

async function listSubjectTasks(projectId: string, query: TaskQuery = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const filter = buildSubjectTaskFilter(projectId, query);
  const cursor = parseTaskCursor(query.cursor);
  const cursorWhere = cursor
    ? ` AND (
         taskType > ?
         OR (
           taskType = ?
           AND (
             createdAt > ?
             OR (createdAt = ? AND id > ?)
           )
         )
       )`
    : "";
  const requestedStatus = String(query.status || "");
  const statusKey = (["pending", "assigned", "completed"].includes(requestedStatus)
    ? requestedStatus
    : "total") as "pending" | "assigned" | "completed" | "total";
  const statsTotal =
    !query.scorer && !query.criterion
      ? (await getProjectTaskStats(projectId))[statusKey]
      : null;
  const total = statsTotal != null
    ? statsTotal
    : includeTaskTotal(query)
      ? (await db
        .prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${filter.where}`)
        .get(...filter.params)).total
      : null;
  const rows = await db
    .prepare(
      `SELECT id, taskType, status, scorer, isBacktest, backtestSourceId, createdAt
       FROM rating_tasks
       ${filter.where}
       ${cursorWhere}
       ORDER BY taskType ASC, createdAt ASC, id ASC
       LIMIT ?${cursor ? "" : " OFFSET ?"}`,
    )
    .all(...filter.params, ...(cursor
    ? [cursor.taskType, cursor.taskType, cursor.createdAt, cursor.createdAt, cursor.id]
    : []), pageSize + 1, ...(cursor ? [] : [(page - 1) * pageSize])) as TaskRow[];
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows[pageRows.length - 1];

  return {
    total,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && lastRow ? serializeTaskCursor(lastRow) : null,
    tasks: (await hydrateTaskListRows(pageRows)).map((row) => ({
      id: row.id,
      criterion: row.taskType.split(":")[1] || null,
      status: row.status,
      scorer: row.scorer,
      isBacktest: Boolean(row.isBacktest),
      backtestSourceTaskId: row.backtestSourceId || null,
      createdAt: row.createdAt,
      items: row.items,
    })),
  };
}

  return { hydrateTaskListRows, listSubjectTaskOptions, listSubjectTasks };
}
