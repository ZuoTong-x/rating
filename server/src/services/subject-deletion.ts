import fs from "node:fs/promises";
import path from "node:path";

type Database = typeof import("../postgres.ts").db;
type Statement = ReturnType<Database["prepare"]>;

export function createSubjectDeletionService({
  db, uploadDir, runWithDatabaseContext, invalidateScorerQueryCaches,
  selectSubjectPendingDeletionStmt, selectSubjectStoragePathsStmt,
  deleteQueuedSubjectStmt, selectPackageProjectCountStmt, httpError,
}: {
  db: Database;
  uploadDir: string;
  runWithDatabaseContext: typeof import("../postgres.ts").runWithDatabaseContext;
  invalidateScorerQueryCaches: () => void;
  selectSubjectPendingDeletionStmt: Statement;
  selectSubjectStoragePathsStmt: Statement;
  deleteQueuedSubjectStmt: Statement;
  selectPackageProjectCountStmt: Statement;
  httpError: (status: number, message: string) => Error;
}) {
  const queuedSubjectDeletionIds = new Set<string>();

  function queueSubjectDeletion(subjectId: string) {
    if (queuedSubjectDeletionIds.has(subjectId)) return;
    queuedSubjectDeletionIds.add(subjectId);
    setImmediate(async () => {
      void (await runWithDatabaseContext(() => deleteQueuedSubject(subjectId)));
    });
  }

  async function deleteQueuedSubject(subjectId: string) {
    try {
      const subject = await selectSubjectPendingDeletionStmt.get(subjectId);
      if (!subject) return;
      const images = await selectSubjectStoragePathsStmt.all(subjectId);
      if (subject.storageRoot) {
        await fs.rm(path.join(uploadDir, subject.storageRoot as string), { recursive: true, force: true }).catch(() => {});
      } else {
        await Promise.all(images.map((row) =>
          fs.unlink(path.join(uploadDir, row.storagePath as string)).catch(() => {})));
      }
      await db.exec("BEGIN");
      try {
        await deleteQueuedSubjectStmt.run(subjectId);
        await db.exec("COMMIT");
        invalidateScorerQueryCaches();
      } catch (error) {
        try { await db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    } catch (error) {
      console.error(`Failed to delete queued subject ${subjectId}`, error);
    } finally {
      queuedSubjectDeletionIds.delete(subjectId);
    }
  }

  async function assertPackageCanBeDeleted(packageId: string) {
    const projectCount = (await selectPackageProjectCountStmt.get(packageId)).total;
    if (projectCount) throw httpError(409, "该图包已关联项目，无法删除；请先删除未开始的项目");
  }

  return { queueSubjectDeletion, assertPackageCanBeDeleted };
}
