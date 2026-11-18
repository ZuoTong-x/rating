import { pool } from "./postgres.js";

const pauseMs = 1000;
const idleMs = 30000;

async function rebuildSubject(subjectId) {
  const client = await pool.connect();
  const lockKey = `thumbnail-stats:${subjectId}`;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
    await client.query(`
      INSERT INTO thumbnail_subject_stats (subjectId) VALUES ($1)
      ON CONFLICT (subjectId) DO NOTHING
    `, [subjectId]);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '600000'");
    const baseline = (await client.query(`
      SELECT pending, processing, ready, failed, total, invalidations, initialized
      FROM thumbnail_subject_stats WHERE subjectId = $1
    `, [subjectId])).rows[0];
    if (baseline.initialized) {
      await client.query("COMMIT");
      return;
    }
    const counts = (await client.query(`
      SELECT COUNT(*) FILTER (WHERE jobs.status = 'pending') AS pending,
             COUNT(*) FILTER (WHERE jobs.status = 'processing') AS processing,
             COUNT(*) FILTER (WHERE jobs.status = 'ready') AS ready,
             COUNT(*) FILTER (WHERE jobs.status = 'failed') AS failed,
             COUNT(*) AS total
      FROM images
      JOIN thumbnail_jobs jobs ON jobs.imageId = images.id
      WHERE images.subjectId = $1
    `, [subjectId])).rows[0];
    await client.query("COMMIT");
    // Keep trigger deltas committed after the snapshot while replacing the historical baseline.
    const result = await client.query(`
      UPDATE thumbnail_subject_stats
      SET pending = $2::bigint + pending - $7::bigint,
          processing = $3::bigint + processing - $8::bigint,
          ready = $4::bigint + ready - $9::bigint,
          failed = $5::bigint + failed - $10::bigint,
          total = $6::bigint + total - $11::bigint,
          initialized = (invalidations = $12::bigint),
          updatedAt = now()
      WHERE subjectId = $1
      RETURNING initialized
    `, [
      subjectId,
      counts.pending, counts.processing, counts.ready, counts.failed, counts.total,
      baseline.pending, baseline.processing, baseline.ready, baseline.failed, baseline.total,
      baseline.invalidations,
    ]);
    if (result.rows[0]?.initialized) console.info("Thumbnail stats initialized", { subjectId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => {});
    client.release();
  }
}

export function startThumbnailStatsBackfill() {
  const retryAfter = new Map();
  async function cycle() {
    let delay = pauseMs;
    let subjectId = null;
    try {
      const result = await pool.query(`
        SELECT subjects.id
        FROM subjects
        LEFT JOIN thumbnail_subject_stats stats ON stats.subjectId = subjects.id
        WHERE subjects.deletionRequestedAt IS NULL AND subjects.imageCount > 0
          AND COALESCE(stats.initialized, false) = false
        ORDER BY subjects.createdAt DESC, subjects.id ASC
      `);
      subjectId = result.rows.find((row) => (retryAfter.get(row.id) || 0) <= Date.now())?.id || null;
      if (subjectId) {
        await rebuildSubject(subjectId);
        retryAfter.delete(subjectId);
      }
      else delay = idleMs;
    } catch (error) {
      console.error("Thumbnail stats backfill failed", error);
      if (subjectId) retryAfter.set(subjectId, Date.now() + 5 * 60_000);
      delay = idleMs;
    }
    const timer = setTimeout(cycle, delay);
    timer.unref();
  }
  void cycle();
}
