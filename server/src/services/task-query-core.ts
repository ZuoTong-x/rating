import type { db as database } from "../postgres.ts";

type Query = Record<string, unknown>;
type TaskRow = Record<string, unknown> & {
  id: string;
  taskType: string;
  subjectId: string;
  createdAt: string;
};
type CursorRow = { id: string; taskType: string; createdAt: string; assignmentKey?: unknown };
type TaskItemRow = { taskId: string; imageId: string; position: number; role: string };

export function createTaskQueryCore({
  httpError, db, taskImageSelectColumns, taskImageDto,
}: {
  httpError: (status: number, message: string) => Error;
  db: typeof database;
  taskImageSelectColumns: string;
  taskImageDto: (row: Record<string, unknown>) => unknown;
}) {
function parseTaskPagination(query: Query = {}) {
  const page = Math.max(Math.floor(Number(query.page) || 1), 1);
  const pageSize = Math.min(
    Math.max(Math.floor(Number(query.pageSize) || 10), 1),
    100,
  );
  return { page, pageSize };
}

function hasPaginationQuery(query: Query = {}) {
  return Object.hasOwn(query, "page") || Object.hasOwn(query, "pageSize");
}

function parseTaskCursor(value: unknown) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw httpError(400, "任务分页游标格式不正确");
  }
  const taskType = String(parsed?.taskType ?? "");
  const createdAt = String(parsed?.createdAt ?? "");
  const id = String(parsed?.id ?? "");
  const criterionOrder = Number(parsed?.criterionOrder);
  const assignmentKey = Number(parsed?.assignmentKey);
  if (!taskType || !createdAt || !id) {
    throw httpError(400, "任务分页游标格式不正确");
  }
  return {
    taskType,
    createdAt,
    id,
    criterionOrder: Number.isFinite(criterionOrder) ? criterionOrder : null,
    assignmentKey: Number.isFinite(assignmentKey) ? Math.floor(assignmentKey) : null,
  };
}

function serializeTaskCursor(row: CursorRow, criterionOrder: number | null = null) {
  return JSON.stringify({
    taskType: row.taskType,
    createdAt: row.createdAt,
    id: row.id,
    ...(criterionOrder == null ? {} : { criterionOrder }),
    ...(row.assignmentKey == null ? {} : { assignmentKey: Number(row.assignmentKey) }),
  });
}

function includeTaskTotal(query: Query = {}) {
  return ["1", "true", "yes"].includes(
    String(query.includeTotal ?? "").toLowerCase(),
  );
}

function escapeSqlLike(value: unknown) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

function parseOptionalDateFilter(value: unknown, label: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw httpError(400, `${label}不正确`);
  return date.toISOString();
}

function parseQueryList(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item ?? "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function placeholders(length: number) {
  return Array.from({ length }, () => "?").join(", ");
}

function parseStoredTaskImageIds(value: unknown) {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.map((item) => String(item ?? "").trim()).filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

function parseStoredTaskRankingRelations(value: unknown) {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => ![">", "="].includes(item))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function completedTaskResultDto(row: TaskRow) {
  return {
    id: row.id,
    subjectId: row.subjectId,
    projectId: row.projectId || row.subjectId,
    taskVersion: row.taskVersion,
    taskType: row.taskType,
    criterion: row.taskType.split(":")[1] || null,
    status: row.status,
    scorer: row.scorer,
    ranking: row.ranking ? JSON.parse(String(row.ranking)) : null,
    excludedImageIds: parseStoredTaskImageIds(row.excludedImageIds),
    correctImageIds: parseStoredTaskImageIds(row.correctImageIds),
    rankingRelations: parseStoredTaskRankingRelations(row.rankingRelations),
    submissionMode: row.submissionMode || null,
    rankingActionCount: Number(row.rankingActionCount || 0),
    dragActionCount: Number(row.dragActionCount || 0),
    orderChanged: Boolean(row.orderChanged),
    largeImageOpened: Boolean(row.largeImageOpened),
    largeImageOpenCount: Number(row.largeImageOpenCount || 0),
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    durationMs: row.durationMs ?? null,
    firstActionMs: row.firstActionMs ?? null,
    pageBlurCount: Number(row.pageBlurCount || 0),
    behaviorTracked: Boolean(row.behaviorTracked),
    riskScore: Number(row.riskScore || 0),
    riskFlags: parseStoredTaskImageIds(row.riskFlags),
    editedAt: row.editedAt ?? null,
    editCount: Number(row.editCount || 0),
    claimToken: null,
    rollbackCount: Number(row.rollbackCount || 0),
    lastRolledBackAt: row.lastRolledBackAt ?? null,
    lastRolledBackBy: row.lastRolledBackBy ?? null,
    imageKey: row.imageKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: [],
  };
}

async function hydrateTaskRows(rows: TaskRow[], options: { includeAdminFields?: boolean } = {}) {
  const includeAdminFields = Boolean(options.includeAdminFields);
  const taskIds = rows.map((row) => row.id);
  const itemsByTaskId = new Map<string, Array<{ imageId: string; position: number; role: string; image: unknown }>>();

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
        SELECT ${taskImageSelectColumns}
        FROM images
        WHERE id IN (${placeholders(imageIds.length)})
      `,
      )
      .all(...imageIds) as Array<Record<string, unknown> & { _id: string }>;
      imageRows.forEach((image) =>
        imageById.set(image._id, taskImageDto(image)),
      );
    }

    itemRows.forEach((item) => {
      const image = imageById.get(item.imageId);
      if (!image) return;
      const currentItems = itemsByTaskId.get(item.taskId) || [];
      currentItems.push({
        imageId: item.imageId,
        position: item.position,
        role: item.role,
        image,
      });
      itemsByTaskId.set(item.taskId, currentItems);
    });
  }

  return rows.map((row) => {
    const task: Record<string, unknown> = {
      id: row.id,
      subjectId: row.subjectId,
      projectId: row.projectId || row.subjectId,
      subjectName: row.subjectName ?? null,
      taskVersion: row.taskVersion,
      taskType: row.taskType,
      criterion: row.taskType.split(":")[1] || null,
      status: row.status,
      scorer: row.scorer,
      ranking: row.ranking ? JSON.parse(String(row.ranking)) : null,
      excludedImageIds: parseStoredTaskImageIds(row.excludedImageIds),
      correctImageIds: parseStoredTaskImageIds(row.correctImageIds),
      rankingRelations: parseStoredTaskRankingRelations(row.rankingRelations),
      submissionMode: row.submissionMode || null,
      rankingActionCount: Number(row.rankingActionCount || 0),
      dragActionCount: Number(row.dragActionCount || 0),
      orderChanged: Boolean(row.orderChanged),
      largeImageOpened: Boolean(row.largeImageOpened),
      largeImageOpenCount: Number(row.largeImageOpenCount || 0),
      startedAt: row.startedAt ?? null,
      completedAt: row.completedAt ?? null,
      durationMs: row.durationMs ?? null,
      firstActionMs: row.firstActionMs ?? null,
      pageBlurCount: Number(row.pageBlurCount || 0),
      behaviorTracked: Boolean(row.behaviorTracked),
      riskScore: Number(row.riskScore || 0),
      riskFlags: parseStoredTaskImageIds(row.riskFlags),
      editedAt: row.editedAt ?? null,
      editCount: Number(row.editCount || 0),
      claimToken: includeAdminFields ? null : row.claimToken ?? null,
      rollbackCount: Number(row.rollbackCount || 0),
      lastRolledBackAt: row.lastRolledBackAt ?? null,
      lastRolledBackBy: row.lastRolledBackBy ?? null,
      imageKey: row.imageKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      items: itemsByTaskId.get(row.id) || [],
    };
    if (includeAdminFields) {
      task.isBacktest = Boolean(row.isBacktest);
      task.backtestSourceTaskId = row.backtestSourceId || null;
    }
    return task;
  });
}

  return { parseTaskPagination, hasPaginationQuery, parseTaskCursor,
  serializeTaskCursor, includeTaskTotal, escapeSqlLike, parseOptionalDateFilter,
  parseQueryList, placeholders, parseStoredTaskImageIds,
  parseStoredTaskRankingRelations, completedTaskResultDto, hydrateTaskRows };
}
