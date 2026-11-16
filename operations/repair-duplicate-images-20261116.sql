-- Follow-up to the v52 thumbnail incident. Do not run without approval.
-- The two old rows have no thumbnailPath; the two newer rows have verified files.
-- Keep the thumbnail worker stopped until both unique indexes are rebuilt.

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
LOCK TABLE images IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE images_repair_backup_20261116 AS
SELECT images.ctid::text AS original_ctid, images.*
FROM images
WHERE images.id IN (
  '2817fcfa-fc6a-43d1-a2bd-52db9559d526',
  '78cc4ba0-62eb-4a71-8339-17b312a105e9'
);

DO $$
DECLARE bad_groups integer;
BEGIN
  SELECT count(*) INTO bad_groups
  FROM (
    SELECT id
    FROM images_repair_backup_20261116
    GROUP BY id
    HAVING count(*) <> 2
       OR count(*) FILTER (WHERE thumbnailpath IS NULL OR btrim(thumbnailpath) = '') <> 1
       OR count(*) FILTER (WHERE thumbnailpath IS NOT NULL AND btrim(thumbnailpath) <> '') <> 1
       OR count(DISTINCT (to_jsonb(images_repair_backup_20261116)
           - 'original_ctid' - 'thumbnailpath' - 'updatedat')) <> 1
  ) unexpected;
  IF (SELECT count(*) FROM images_repair_backup_20261116) <> 4 OR bad_groups <> 0 THEN
    RAISE EXCEPTION 'Image duplicate shape changed; expected four rows in two identical pairs';
  END IF;
END $$;

SET LOCAL enable_indexscan = on;
SET LOCAL enable_bitmapscan = on;
CREATE TEMP TABLE image_repair_refs_before ON COMMIT DROP AS
SELECT 'rating_task_items' AS source, count(*) AS n FROM rating_task_items WHERE imageid IN (SELECT id FROM images_repair_backup_20261116)
UNION ALL SELECT 'subject_task_template_items', count(*) FROM subject_task_template_items WHERE imageid IN (SELECT id FROM images_repair_backup_20261116)
UNION ALL SELECT 'thumbnail_jobs', count(*) FROM thumbnail_jobs WHERE imageid IN (SELECT id FROM images_repair_backup_20261116)
UNION ALL SELECT 'image_pair_edges', count(*) FROM image_pair_edges WHERE imagea IN (SELECT id FROM images_repair_backup_20261116) OR imageb IN (SELECT id FROM images_repair_backup_20261116);

-- Ordinary DELETE would cascade to task items by image ID even though the
-- newer parent row survives. Disable FK triggers only in this transaction.
SET LOCAL session_replication_role = replica;
SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
DO $$
DECLARE deleted_rows integer;
BEGIN
  DELETE FROM images
  USING images_repair_backup_20261116 old
  WHERE images.ctid::text = old.original_ctid
    AND images.id = old.id
    AND (images.thumbnailpath IS NULL OR btrim(images.thumbnailpath) = '')
    AND EXISTS (
      SELECT 1 FROM images_repair_backup_20261116 newer
      WHERE newer.id = images.id
        AND newer.thumbnailpath IS NOT NULL
        AND btrim(newer.thumbnailpath) <> ''
    );
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  IF deleted_rows <> 2 THEN
    RAISE EXCEPTION 'Expected to remove two stale image rows, removed %', deleted_rows;
  END IF;
END $$;
SET LOCAL session_replication_role = origin;

SET LOCAL enable_indexscan = on;
SET LOCAL enable_bitmapscan = on;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM image_repair_refs_before before
    WHERE before.n <> CASE before.source
      WHEN 'rating_task_items' THEN (SELECT count(*) FROM rating_task_items WHERE imageid IN (SELECT id FROM images_repair_backup_20261116))
      WHEN 'subject_task_template_items' THEN (SELECT count(*) FROM subject_task_template_items WHERE imageid IN (SELECT id FROM images_repair_backup_20261116))
      WHEN 'thumbnail_jobs' THEN (SELECT count(*) FROM thumbnail_jobs WHERE imageid IN (SELECT id FROM images_repair_backup_20261116))
      WHEN 'image_pair_edges' THEN (SELECT count(*) FROM image_pair_edges WHERE imagea IN (SELECT id FROM images_repair_backup_20261116) OR imageb IN (SELECT id FROM images_repair_backup_20261116))
    END
  ) THEN
    RAISE EXCEPTION 'Image references changed during duplicate cleanup';
  END IF;
END $$;

SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
DO $$
BEGIN
  IF (SELECT count(*) FROM (SELECT id FROM images GROUP BY id HAVING count(*) > 1) duplicates) <> 0 THEN
    RAISE EXCEPTION 'Duplicate image IDs remain';
  END IF;
  IF (SELECT count(*) FROM (
    SELECT subjectid, originalpath FROM images
    GROUP BY subjectid, originalpath HAVING count(*) > 1
  ) duplicates) <> 0 THEN
    RAISE EXCEPTION 'Duplicate subject/original path pairs remain';
  END IF;
END $$;
COMMIT;

REINDEX INDEX CONCURRENTLY public.images_pkey;
REINDEX INDEX CONCURRENTLY public.images_subjectid_originalpath_key;

SELECT id, thumbnailpath FROM images
WHERE id IN ('2817fcfa-fc6a-43d1-a2bd-52db9559d526', '78cc4ba0-62eb-4a71-8339-17b312a105e9');
