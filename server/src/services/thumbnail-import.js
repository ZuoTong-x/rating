// The import path only enqueues work. Image decoding belongs to thumbnail-worker.js.
export function createThumbnailImportScheduler({ db, runWithDatabaseContext, operationalLogger, batchSize }) {
  async function bulkInsertThumbnailJobs(imageRows, createdAt) {
    for (let start = 0; start < imageRows.length; start += batchSize) {
      const batch = imageRows.slice(start, start + batchSize);
      const sql = `
        INSERT INTO thumbnail_jobs (
          imageId, status, attempts, workerId, lockedUntil, nextRetryAt, lastError,
          createdAt, updatedAt, completedAt
        ) VALUES ${batch.map(() => "(?, 'pending', 0, NULL, NULL, ?, NULL, ?, ?, NULL)").join(", ")}
        ON CONFLICT (imageId) DO NOTHING
      `;
      const params = [];
      for (const row of batch) params.push(row.id, createdAt, createdAt, createdAt);
      await db.prepare(sql).run(...params);
    }
  }

  return function scheduleImportedThumbnailJobs(imageRows, createdAt, subjectId) {
    setImmediate(async () => {
      try {
        await runWithDatabaseContext(() => bulkInsertThumbnailJobs(imageRows, createdAt));
      } catch (error) {
        operationalLogger.error({
          kind: "thumbnail-import-queue",
          message: "导入完成，但缩略图任务批量入队失败，将由增量巡检补充",
          code: error?.code || null,
          metadata: { subjectId, imageCount: imageRows.length },
        }, error);
      }
    });
  };
}
