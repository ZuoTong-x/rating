import type { db as database } from "../postgres.ts";

export function createImportStatements(db: typeof database) {
const insertImportJobStmt = db.prepare(`
  INSERT INTO import_jobs (
    uploadId, originalFilename, totalChunks, protocol, uploadLength, uploadOffset,
    metadata, status, stage, progress, message, resultJson, createdAt, updatedAt, expiresAt
  ) VALUES (
    @uploadId, @originalFilename, @totalChunks, @protocol, @uploadLength, @uploadOffset,
    @metadata, @status, @stage, @progress, @message, @resultJson, @createdAt, @updatedAt, @expiresAt
  )
`);
const updateImportJobStmt = db.prepare(`
  UPDATE import_jobs
  SET status = @status,
      stage = @stage,
      progress = @progress,
      message = @message,
      resultJson = @resultJson,
      protocol = @protocol,
      uploadLength = @uploadLength,
      uploadOffset = @uploadOffset,
      metadata = @metadata,
      updatedAt = @updatedAt,
      expiresAt = @expiresAt
  WHERE uploadId = @uploadId
`);
const selectImportJobStmt = db.prepare(
  "SELECT * FROM import_jobs WHERE uploadId = ?",
);
const deleteImportJobStmt = db.prepare(
  "DELETE FROM import_jobs WHERE uploadId = ?",
);
const deleteExpiredImportJobsStmt = db.prepare(
  "DELETE FROM import_jobs WHERE expiresAt <= ?",
);
const selectPendingImportJobsStmt = db.prepare(
  "SELECT * FROM import_jobs WHERE status = 'awaiting_json' AND expiresAt > ? ORDER BY createdAt DESC",
);
  return { insertImportJobStmt, updateImportJobStmt, selectImportJobStmt, deleteImportJobStmt, deleteExpiredImportJobsStmt, selectPendingImportJobsStmt };
}
