import type { db as database } from "../postgres.ts";

export function createProjectStatements({ db, subjectSelectColumns, projectSelectColumns }: {
  db: typeof database;
  subjectSelectColumns: string;
  projectSelectColumns: string;
}) {
const insertSubjectStmt = db.prepare(`
  INSERT INTO subjects (id, name, originalFilename, importBatch, storageRoot, sourceZipPath, imageCount, categoryCount, status, createdAt, updatedAt)
  VALUES (@id, @name, @originalFilename, @importBatch, @storageRoot, @sourceZipPath, 0, 0, 'importing', @createdAt, @updatedAt)
`);

const updateSubjectCountsStmt = db.prepare(`
  UPDATE subjects
  SET imageCount = @imageCount,
      categoryCount = @categoryCount,
      status = @status,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const markSubjectImportFailedStmt = db.prepare(`
  UPDATE subjects
  SET status = 'failed',
      updatedAt = @updatedAt
  WHERE id = @id
    AND status = 'importing'
`);

const selectSubjectByIdStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE id = ? AND deletionRequestedAt IS NULL`,
);
const selectSubjectPendingDeletionStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE id = ? AND deletionRequestedAt IS NOT NULL`,
);
const selectSubjectsStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE deletionRequestedAt IS NULL
     AND status = 'imported'
   ORDER BY createdAt DESC`,
);
const selectProjectByIdStmt = db.prepare(`
  SELECT ${projectSelectColumns}
  FROM projects
  JOIN subjects ON subjects.id = projects.packageId
  WHERE projects.id = ?
    AND projects.deletionRequestedAt IS NULL
`);
const selectProjectByNameStmt = db.prepare(`
  SELECT id
  FROM projects
  WHERE deletionRequestedAt IS NULL
    AND LOWER(TRIM(name)) = LOWER(?)
  LIMIT 1
`);
const selectProjectsStmt = db.prepare(`
  SELECT ${projectSelectColumns}
  FROM projects
  JOIN subjects ON subjects.id = projects.packageId
  WHERE projects.deletionRequestedAt IS NULL
  ORDER BY projects.createdAt DESC, projects.id ASC
`);
const selectProjectPackagesStmt = db.prepare(`
  SELECT subjects.id AS _id,
         subjects.name,
         subjects.originalFilename,
         subjects.imageCount,
         subjects.categoryCount,
         subjects.status,
         subjects.createdAt,
         subjects.updatedAt,
         COALESCE(template_stats.taskTemplateCount, template_counts.taskTemplateCount, 0) AS taskTemplateCount
  FROM project_packages
  JOIN subjects ON subjects.id = project_packages.packageId
  LEFT JOIN subject_task_template_stats template_stats
    ON template_stats.subjectId = subjects.id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS taskTemplateCount
    FROM subject_task_templates
    WHERE template_stats.subjectId IS NULL
      AND subject_task_templates.subjectId = subjects.id
  ) template_counts ON TRUE
  WHERE project_packages.projectId = ?
    AND subjects.deletionRequestedAt IS NULL
  ORDER BY project_packages.createdAt ASC, subjects.createdAt ASC, subjects.id ASC
`);
const insertProjectStmt = db.prepare(`
  INSERT INTO projects (
    id, name, icon, packageId, taskStatus, tasksLocked, createdAt, updatedAt
  ) VALUES (
    @id, @name, @icon, @packageId, 'task_pending', true, @createdAt, @updatedAt
  )
`);
const insertProjectPackageStmt = db.prepare(`
  INSERT INTO project_packages (projectId, packageId, createdAt)
  VALUES (@projectId, @packageId, @createdAt)
  ON CONFLICT DO NOTHING
`);
const deleteProjectPackagesStmt = db.prepare(
  "DELETE FROM project_packages WHERE projectId = ?",
);
const updateProjectStmt = db.prepare(`
  UPDATE projects
  SET name = @name,
      icon = @icon,
      packageId = @packageId,
      updatedAt = @updatedAt
  WHERE id = @id
    AND deletionRequestedAt IS NULL
`);
const updateProjectTaskStatusStmt = db.prepare(`
  UPDATE projects
  SET taskStatus = @taskStatus,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const updateProjectTaskLockStmt = db.prepare(`
  UPDATE projects
  SET tasksLocked = @tasksLocked,
      updatedAt = @updatedAt
  WHERE id = @id
    AND deletionRequestedAt IS NULL
`);
const clearProjectTaskClaimsStmt = db.prepare(`
  UPDATE rating_tasks
  SET claimToken = NULL,
      claimedAt = NULL,
      claimExpiresAt = NULL,
      updatedAt = @updatedAt
  WHERE projectId = @projectId
    AND taskVersion = @taskVersion
    AND status = 'assigned'
    AND claimToken IS NOT NULL
`);
const selectProjectTaskCountStmt = db.prepare(
  "SELECT COUNT(*) AS total FROM rating_tasks WHERE projectId = ?",
);
const deleteUncompletedProjectTasksStmt = db.prepare(
  "DELETE FROM rating_tasks WHERE projectId = ? AND status <> 'completed'",
);
const deleteProjectUserLinksStmt = db.prepare(
  "DELETE FROM user_projects WHERE projectId = ?",
);
const deleteProjectScorerTaskStatsStmt = db.prepare(
  "DELETE FROM scorer_task_stats WHERE projectId = ? AND taskVersion = ?",
);
const deleteProjectScorerScoringStatsStmt = db.prepare(
  "DELETE FROM scorer_scoring_stats WHERE projectId = ? AND taskVersion = ?",
);
const deleteProjectStmt = db.prepare(
  "DELETE FROM projects WHERE id = ? AND deletionRequestedAt IS NULL",
);
const selectPackageProjectCountStmt = db.prepare(
  `SELECT COUNT(*) AS total
   FROM project_packages
   JOIN projects ON projects.id = project_packages.projectId
   WHERE project_packages.packageId = ?
     AND projects.deletionRequestedAt IS NULL`,
);
const selectProjectScorerAccessStmt = db.prepare(`
  SELECT 1 FROM rating_tasks
  WHERE projectId = ? AND scorer = ? AND status IN ('assigned', 'completed')
  LIMIT 1
`);
  return {
    insertSubjectStmt, updateSubjectCountsStmt, markSubjectImportFailedStmt,
  selectSubjectByIdStmt, selectSubjectPendingDeletionStmt, selectSubjectsStmt,
  selectProjectByIdStmt, selectProjectByNameStmt, selectProjectsStmt,
  selectProjectPackagesStmt, insertProjectStmt, insertProjectPackageStmt,
  deleteProjectPackagesStmt, updateProjectStmt, updateProjectTaskStatusStmt,
  updateProjectTaskLockStmt, clearProjectTaskClaimsStmt, selectProjectTaskCountStmt,
  deleteUncompletedProjectTasksStmt, deleteProjectUserLinksStmt,
  deleteProjectScorerTaskStatsStmt, deleteProjectScorerScoringStatsStmt,
  deleteProjectStmt, selectPackageProjectCountStmt, selectProjectScorerAccessStmt,
  };
}
