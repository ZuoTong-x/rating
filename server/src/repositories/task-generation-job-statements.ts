import type { db as database } from "../postgres.ts";

export function createTaskGenerationJobStatements(db: typeof database) {
const selectTaskGenerationJobStmt = db.prepare(`
  SELECT jobId, subjectId, status, stage, progress, message, requestJson, stageEventsJson, resultJson, createdAt, updatedAt, expiresAt
  FROM task_generation_jobs
  WHERE jobId = ?
`);
const selectActiveTaskGenerationJobBySubjectStmt = db.prepare(`
  SELECT jobId, subjectId, status, stage, progress, message, requestJson, stageEventsJson, resultJson, createdAt, updatedAt, expiresAt
  FROM task_generation_jobs
  WHERE subjectId = ?
    AND status IN ('queued', 'running')
  ORDER BY updatedAt DESC, createdAt DESC
  LIMIT 1
`);
const selectActiveTaskGenerationJobStmt = db.prepare(`
  SELECT jobId, subjectId, status, stage, progress, message, requestJson, stageEventsJson, resultJson, createdAt, updatedAt, expiresAt
  FROM task_generation_jobs
  WHERE status IN ('queued', 'running')
  ORDER BY updatedAt DESC, createdAt DESC
  LIMIT 1
`);
const selectActiveTaskGenerationSubjectsStmt = db.prepare(`
  SELECT DISTINCT subjectId
  FROM task_generation_jobs
  WHERE status IN ('queued', 'running')
`);
const upsertTaskGenerationJobStmt = db.prepare(`
  INSERT INTO task_generation_jobs (
    jobId, subjectId, status, stage, progress, message, requestJson, stageEventsJson, resultJson,
    createdAt, updatedAt, expiresAt
  ) VALUES (
    @jobId, @subjectId, @status, @stage, @progress, @message, @requestJson, @stageEventsJson, @resultJson,
    @createdAt, @updatedAt, @expiresAt
  )
  ON CONFLICT (jobId) DO UPDATE SET
    subjectId = excluded.subjectId,
    status = excluded.status,
    stage = excluded.stage,
    progress = excluded.progress,
    message = excluded.message,
    requestJson = excluded.requestJson,
    stageEventsJson = excluded.stageEventsJson,
    resultJson = excluded.resultJson,
    updatedAt = excluded.updatedAt,
    expiresAt = excluded.expiresAt
`);
const deleteTaskGenerationJobStmt = db.prepare(
  "DELETE FROM task_generation_jobs WHERE jobId = ?",
);
const deleteExpiredTaskGenerationJobsStmt = db.prepare(
  "DELETE FROM task_generation_jobs WHERE expiresAt <= ?",
);
const failInterruptedTaskGenerationJobsStmt = db.prepare(`
  UPDATE task_generation_jobs
  SET status = 'failed',
      stage = '任务生成被服务端重启中断',
      message = '任务生成被服务端重启中断，请重新发起',
      updatedAt = @updatedAt
  WHERE status IN ('queued', 'running')
`);
  return { selectTaskGenerationJobStmt, selectActiveTaskGenerationJobBySubjectStmt, selectActiveTaskGenerationJobStmt, selectActiveTaskGenerationSubjectsStmt, upsertTaskGenerationJobStmt, deleteTaskGenerationJobStmt, deleteExpiredTaskGenerationJobsStmt, failInterruptedTaskGenerationJobsStmt };
}
