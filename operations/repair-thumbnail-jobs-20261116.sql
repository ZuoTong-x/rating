-- Production v52 incident: preserve the ready row for each of 12 duplicate image IDs.
-- Run only after reviewing current duplicate counts and while thumbnail-worker is stopped.
-- This transaction makes a recoverable copy before deleting the stale pending rows.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
LOCK TABLE thumbnail_jobs IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE thumbnail_jobs_repair_backup_20261116 AS
WITH duplicate_ids AS (
  SELECT imageid
  FROM thumbnail_jobs
  GROUP BY imageid
  HAVING count(*) > 1
)
SELECT jobs.ctid::text AS original_ctid, jobs.*
FROM thumbnail_jobs jobs
JOIN duplicate_ids duplicates ON duplicates.imageid = jobs.imageid;

DO $$
DECLARE
  total_rows integer;
  ready_rows integer;
  pending_rows integer;
  deleted_rows integer;
  remaining_duplicates integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE status = 'ready' AND completedat IS NOT NULL),
         count(*) FILTER (WHERE status = 'pending' AND attempts = 0 AND completedat IS NULL)
    INTO total_rows, ready_rows, pending_rows
  FROM thumbnail_jobs_repair_backup_20261116;
  IF total_rows <> 24 OR ready_rows <> 12 OR pending_rows <> 12 THEN
    RAISE EXCEPTION 'Unexpected duplicate shape: total %, ready %, pending %',
      total_rows, ready_rows, pending_rows;
  END IF;

  DELETE FROM thumbnail_jobs jobs
  USING thumbnail_jobs_repair_backup_20261116 backup
  WHERE jobs.ctid::text = backup.original_ctid
    AND jobs.imageid = backup.imageid
    AND jobs.status = 'pending'
    AND jobs.attempts = 0
    AND jobs.completedat IS NULL
    AND EXISTS (
      SELECT 1 FROM thumbnail_jobs_repair_backup_20261116 ready
      WHERE ready.imageid = jobs.imageid
        AND ready.status = 'ready'
        AND ready.completedat IS NOT NULL
    );
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows <> 12 THEN
    RAISE EXCEPTION 'Expected to delete 12 stale pending rows, deleted %', deleted_rows;
  END IF;

  SELECT count(*) INTO remaining_duplicates
  FROM (SELECT imageid FROM thumbnail_jobs GROUP BY imageid HAVING count(*) > 1) duplicates;
  IF remaining_duplicates <> 0 THEN
    RAISE EXCEPTION 'Duplicate image IDs remain: %', remaining_duplicates;
  END IF;
END $$;

COMMIT;

-- The failed concurrent attempt left an empty invalid index. Remove it after
-- the transaction commits, then rebuild the primary-key index from the heap.
DROP INDEX CONCURRENTLY IF EXISTS thumbnail_jobs_pkey_ccnew;
REINDEX INDEX CONCURRENTLY public.thumbnail_jobs_pkey;

-- The table is safe to read again only after the rebuilt index finds the
-- formerly invisible row and the duplicate count remains zero.
SELECT imageid, status
FROM thumbnail_jobs
WHERE imageid = '966cac01-3e13-4222-8c63-b6f97d3709c2';
SELECT count(*) AS duplicate_keys
FROM (SELECT imageid FROM thumbnail_jobs GROUP BY imageid HAVING count(*) > 1) duplicates;
