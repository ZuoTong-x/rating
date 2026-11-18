-- v52 production: scorer task detail/submit errors on three rating_tasks indexes.
-- Run with psql -v ON_ERROR_STOP=1 after checking that no long-running
-- rating_tasks transaction remains. Do not wrap this file in BEGIN/COMMIT:
-- REINDEX CONCURRENTLY must run outside a transaction block.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND xact_start < now() - interval '5 minutes'
      AND query ~* 'rating_tasks'
  ) THEN
    RAISE EXCEPTION 'Long-running rating_tasks transaction remains; defer index repair';
  END IF;
END $$;

SET lock_timeout = '5s';
SET statement_timeout = '30min';

REINDEX INDEX CONCURRENTLY public.idx_rating_tasks_subject;
REINDEX INDEX CONCURRENTLY public.rating_tasks_subjectid_taskversion_round_tasktype_imagekey_key;
REINDEX INDEX CONCURRENTLY public.idx_rating_tasks_assigned_assignment_list;

SELECT indexrelid::regclass AS index_name, indisvalid, indisready
FROM pg_index
WHERE indrelid = 'public.rating_tasks'::regclass
  AND indexrelid::regclass::text IN (
    'idx_rating_tasks_subject',
    'rating_tasks_subjectid_taskversion_round_tasktype_imagekey_key',
    'idx_rating_tasks_assigned_assignment_list'
  )
ORDER BY indexrelid::regclass::text;

SELECT indexrelid::regclass AS invalid_index
FROM pg_index
WHERE indrelid = 'public.rating_tasks'::regclass AND NOT indisvalid;
