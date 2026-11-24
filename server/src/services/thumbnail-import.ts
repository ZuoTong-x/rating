// Import only enqueues work. Image decoding belongs to the thumbnail worker.
type ThumbnailImageRow = { id: string };
type ThumbnailImportDependencies = {
  db: {
    prepare(sql: string): { run(...params: string[]): Promise<unknown> };
  };
  runWithDatabaseContext<T>(callback: () => Promise<T>): Promise<T>;
  operationalLogger: {
    error(
      event: { kind: string; message: string; code: string | null; metadata: { subjectId: string; imageCount: number } },
      error: unknown,
    ): void;
  };
  batchSize: number;
};

export function createThumbnailImportScheduler({
  db,
  runWithDatabaseContext,
  operationalLogger,
  batchSize,
}: ThumbnailImportDependencies) {
  async function bulkInsertThumbnailJobs(imageRows: ThumbnailImageRow[], createdAt: string) {
    for (let start = 0; start < imageRows.length; start += batchSize) {
      const batch = imageRows.slice(start, start + batchSize);
      const sql = `
        INSERT INTO thumbnail_jobs (
          imageId, status, attempts, workerId, lockedUntil, nextRetryAt, lastError,
          createdAt, updatedAt, completedAt
        ) VALUES ${batch.map(() => "(?, 'pending', 0, NULL, NULL, ?, NULL, ?, ?, NULL)").join(", ")}
        ON CONFLICT (imageId) DO NOTHING
      `;
      const params: string[] = [];
      for (const row of batch) params.push(row.id, createdAt, createdAt, createdAt);
      await db.prepare(sql).run(...params);
    }
  }

  return function scheduleImportedThumbnailJobs(imageRows: ThumbnailImageRow[], createdAt: string, subjectId: string) {
    setImmediate(async () => {
      try {
        await runWithDatabaseContext(() => bulkInsertThumbnailJobs(imageRows, createdAt));
      } catch (error) {
        const code = error instanceof Error && "code" in error && error.code
          ? String(error.code)
          : null;
        operationalLogger.error({
          kind: "thumbnail-import-queue",
          message: "导入完成，但缩略图任务批量入队失败，将由增量巡检补充",
          code,
          metadata: { subjectId, imageCount: imageRows.length },
        }, error);
      }
    });
  };
}
