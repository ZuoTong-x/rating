import type { db as database } from "../postgres.ts";

export function createStartupStatements(db: typeof database) {
  const selectQueuedSubjectsStmt = db.prepare(
    "SELECT id FROM subjects WHERE deletionRequestedAt IS NOT NULL",
  );
  const markInterruptedImportJobsStmt = db.prepare(`
    UPDATE import_jobs
    SET status = CASE
          WHEN metadata LIKE '%"pendingJson":true%' THEN 'awaiting_json'
          ELSE 'failed'
        END,
        stage = CASE
          WHEN metadata LIKE '%"pendingJson":true%' THEN '等待补充 JSON'
          ELSE '导入失败'
        END,
        message = CASE
          WHEN metadata LIKE '%"pendingJson":true%' THEN COALESCE(message, 'JSON 处理被服务端重启中断，请继续补充 JSON')
          ELSE '服务端在导入过程中重启，请重新上传'
        END,
        updatedAt = @updatedAt
    WHERE status IN ('queued', 'merging', 'importing')
  `);
  const selectCompletedProjectsStmt = db.prepare(
    "SELECT id FROM projects WHERE taskStatus = 'task_completed' AND deletionRequestedAt IS NULL",
  );
  return { selectQueuedSubjectsStmt, markInterruptedImportJobsStmt, selectCompletedProjectsStmt };
}
