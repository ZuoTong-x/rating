import type { db as database } from "../postgres.ts";

type ImageInsert = {
  id: string;
  subjectId: string;
  filename: string;
  originalPath: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  category: string | null;
  directory: string;
  isInfographic: number;
  prompt: string | null;
  catalogData: string | null;
  importBatch: string | null;
  createdAt: string;
  updatedAt: string;
};
type TemplateInsert = {
  id: string;
  subjectId: string;
  sourceTaskId: string;
  round: number;
  criterion: string;
  imageKey: string;
  selectionKey: number;
  createdAt: string;
  items: Array<{ imageId: string; position: number; role: string }>;
};
type BatchProgress = (progress: { current: number; total: number }) => void | Promise<void>;

export function createImportWritesService({
  db, importDbBatchSize, importDbItemBatchSize, placeholders,
  archiveImportError, nowIso, upsertSubjectTaskTemplateStatsStmt,
  upsertAllSubjectTaskTemplateStatsStmt, backfillProjectTaskBaseStatsStmt,
  taskVersion,
}: {
  db: typeof database;
  importDbBatchSize: number;
  importDbItemBatchSize: number;
  placeholders: (count: number) => string;
  archiveImportError: (status: number, message: string) => Error;
  nowIso: () => string;
  upsertSubjectTaskTemplateStatsStmt: ReturnType<typeof database.prepare>;
  upsertAllSubjectTaskTemplateStatsStmt: ReturnType<typeof database.prepare>;
  backfillProjectTaskBaseStatsStmt: ReturnType<typeof database.prepare>;
  taskVersion: string;
}) {
async function bulkInsertImageRecords(imageRows: ImageInsert[], onBatch?: BatchProgress) {
  for (let start = 0; start < imageRows.length; start += importDbBatchSize) {
    const batch = imageRows.slice(start, start + importDbBatchSize);
    const sql = `
      INSERT INTO images (
        id, subjectId, filename, originalPath, storagePath, thumbnailPath, mimeType,
        category, directory, isInfographic, prompt, catalogData, importBatch,
        createdAt, updatedAt
      ) VALUES ${batch.map(() => `(${placeholders(15)})`).join(", ")}
      ON CONFLICT DO NOTHING
    `;
    const params: unknown[] = [];
    batch.forEach((row) => {
      params.push(
        row.id,
        row.subjectId,
        row.filename,
        row.originalPath,
        row.storagePath,
        row.thumbnailPath,
        row.mimeType,
        row.category,
        row.directory,
        row.isInfographic,
        row.prompt,
        row.catalogData,
        row.importBatch,
        row.createdAt,
        row.updatedAt,
      );
    });
    const result = await db.prepare(sql).run(...params);
    if (result.changes !== batch.length) {
      throw archiveImportError(409, "图片记录重复，无法导入");
    }
    await onBatch?.({
      current: Math.min(start + batch.length, imageRows.length),
      total: imageRows.length,
    });
  }
}

async function bulkInsertSubjectTaskTemplates(taskTemplates: TemplateInsert[], onBatch?: BatchProgress) {
  for (let start = 0; start < taskTemplates.length; start += importDbBatchSize) {
    const batch = taskTemplates.slice(start, start + importDbBatchSize);
    const sql = `
      INSERT INTO subject_task_templates (
        id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey, createdAt
      ) VALUES ${batch.map(() => `(${placeholders(8)})`).join(", ")}
    `;
    const params: unknown[] = [];
    batch.forEach((row) => {
      params.push(
        row.id,
        row.subjectId,
        row.sourceTaskId,
        row.round,
        row.criterion,
        row.imageKey,
        row.selectionKey,
        row.createdAt,
      );
    });
    await db.prepare(sql).run(...params);
    await onBatch?.({
      current: Math.min(start + batch.length, taskTemplates.length),
      total: taskTemplates.length,
    });
  }
}

async function refreshSubjectTaskTemplateStats(subjectId: string, updatedAt = nowIso()) {
  await upsertSubjectTaskTemplateStatsStmt.run(updatedAt, subjectId);
}

function queueSubjectTaskTemplateStatsBackfill() {
  setImmediate(async () => {
    try {
      await upsertAllSubjectTaskTemplateStatsStmt.run(nowIso());
    } catch (error) {
      console.error("Subject task template stats backfill failed", error);
    }
  });
}

function queueProjectTaskBaseStatsBackfill() {
  setImmediate(async () => {
    try {
      const updatedAt = nowIso();
      await backfillProjectTaskBaseStatsStmt.run(updatedAt, taskVersion);
    } catch (error) {
      console.error("Project base task stats backfill failed", error);
    }
  });
}

async function bulkInsertSubjectTaskTemplateItems(taskTemplates: TemplateInsert[], onBatch?: BatchProgress) {
  const itemRows = taskTemplates.flatMap((template) =>
    template.items.map((item) => ({
      templateId: template.id,
      ...item,
    })),
  );
  for (let start = 0; start < itemRows.length; start += importDbItemBatchSize) {
    const batch = itemRows.slice(start, start + importDbItemBatchSize);
    const sql = `
      INSERT INTO subject_task_template_items (templateId, imageId, position, role)
      VALUES ${batch.map(() => "(?, ?, ?, ?)").join(", ")}
    `;
    const params: unknown[] = [];
    batch.forEach((row) => {
      params.push(row.templateId, row.imageId, row.position, row.role);
    });
    await db.prepare(sql).run(...params);
    await onBatch?.({
      current: Math.min(start + batch.length, itemRows.length),
      total: itemRows.length,
    });
  }
}
  return {
    bulkInsertImageRecords, bulkInsertSubjectTaskTemplates,
    bulkInsertSubjectTaskTemplateItems, refreshSubjectTaskTemplateStats,
    queueSubjectTaskTemplateStatsBackfill, queueProjectTaskBaseStatsBackfill,
  };
}
