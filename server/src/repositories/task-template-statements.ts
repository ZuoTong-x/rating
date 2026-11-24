import type { db as database } from "../postgres.ts";

export function createTaskTemplateStatements(db: typeof database) {
const upsertSubjectTaskTemplateStatsStmt = db.prepare(`
  INSERT INTO subject_task_template_stats (
    subjectId, taskTemplateCount, criterionCount, updatedAt
  )
  SELECT
    subjectId,
    COUNT(*)::integer,
    COUNT(DISTINCT NULLIF(BTRIM(criterion), ''))::integer,
    ?
  FROM subject_task_templates
  WHERE subjectId = ?
  GROUP BY subjectId
  ON CONFLICT (subjectId) DO UPDATE SET
    taskTemplateCount = EXCLUDED.taskTemplateCount,
    criterionCount = EXCLUDED.criterionCount,
    updatedAt = EXCLUDED.updatedAt
`);
const upsertAllSubjectTaskTemplateStatsStmt = db.prepare(`
  INSERT INTO subject_task_template_stats (
    subjectId, taskTemplateCount, criterionCount, updatedAt
  )
  SELECT
    subjectId,
    COUNT(*)::integer,
    COUNT(DISTINCT NULLIF(BTRIM(criterion), ''))::integer,
    ?
  FROM subject_task_templates
  GROUP BY subjectId
  ON CONFLICT (subjectId) DO UPDATE SET
    taskTemplateCount = EXCLUDED.taskTemplateCount,
    criterionCount = EXCLUDED.criterionCount,
    updatedAt = EXCLUDED.updatedAt
`);
  return { upsertSubjectTaskTemplateStatsStmt, upsertAllSubjectTaskTemplateStatsStmt };
}
