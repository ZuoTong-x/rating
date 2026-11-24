import type { db as database } from "../postgres.ts";

export function createAssetStatements({ db, imageSelectColumns }: { db: typeof database; imageSelectColumns: string }) {
const selectImageByIdStmt = db.prepare(
  `SELECT ${imageSelectColumns} FROM images WHERE id = ?`,
);
const selectAssignedTaskForImageStmt = db.prepare(`
  SELECT 1
  FROM rating_task_items
  JOIN rating_tasks ON rating_tasks.id = rating_task_items.taskId
  JOIN images ON images.id = rating_task_items.imageId
  WHERE rating_tasks.scorer = ?
    AND rating_tasks.status IN ('assigned', 'completed')
    AND (images.storagePath = ? OR images.thumbnailPath = ?)
  LIMIT 1
`);
const markSubjectForDeletionStmt = db.prepare(`
  UPDATE subjects
  SET deletionRequestedAt = @deletionRequestedAt,
      updatedAt = @updatedAt
  WHERE id = @id AND deletionRequestedAt IS NULL
`);
const selectSubjectStoragePathsStmt = db.prepare(
  "SELECT storagePath FROM images WHERE subjectId = ?",
);
const deleteQueuedSubjectStmt = db.prepare(
  "DELETE FROM subjects WHERE id = ? AND deletionRequestedAt IS NOT NULL",
);
const updateImageScoreStmt = db.prepare(`
  UPDATE images
  SET overall = @overall,
      scorer = @scorer,
      creativity = @creativity,
      mood = @mood,
      composition = @composition,
      color = @color,
      lighting = @lighting,
      realism = @realism,
      detail = @detail,
      discomfort = @discomfort,
      promptAlignment = @promptAlignment,
      promptAlignmentState = @promptAlignmentState,
      textCorrectness = @textCorrectness,
      textCorrectnessState = @textCorrectnessState,
      anatomyNormality = @anatomyNormality,
      anatomyNormalityState = @anatomyNormalityState,
      informationClarity = @informationClarity,
      informationClarityState = @informationClarityState,
      designQuality = @designQuality,
      designQualityState = @designQualityState,
      typography = @typography,
      typographyState = @typographyState,
      comment = @comment,
      ratedAt = @ratedAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);
  return { selectImageByIdStmt, selectAssignedTaskForImageStmt, markSubjectForDeletionStmt, selectSubjectStoragePathsStmt, deleteQueuedSubjectStmt, updateImageScoreStmt };
}
