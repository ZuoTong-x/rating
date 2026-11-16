\set ON_ERROR_STOP on

BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';

-- Pause the API stats flusher while keeping scoring submissions available.
SELECT pg_advisory_xact_lock(2026091401);

CREATE TEMP TABLE repair_meta ON COMMIT DROP AS
SELECT clock_timestamp() AS cutoff;

-- The damaged primary-key index can hide heap rows, so duplicate discovery
-- and deletion must not rely on any index.
SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;

CREATE TEMP TABLE repair_projects ON COMMIT DROP AS
SELECT DISTINCT projectid
FROM (
  SELECT scorer, taskversion, projectid, submissionmode
  FROM scorer_scoring_stats
  WHERE taskversion = 'v3'
  GROUP BY scorer, taskversion, projectid, submissionmode
  HAVING COUNT(*) > 1
) duplicates;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM repair_projects) THEN
    RAISE EXCEPTION 'No duplicate scorer_scoring_stats projects found; refusing to run repair';
  END IF;
END;
$$;

CREATE TEMP TABLE rebuilt_project_task_stats ON COMMIT DROP AS
SELECT
  projectid,
  taskversion,
  COUNT(*)::integer AS total,
  COUNT(*) FILTER (WHERE status = 'pending')::integer AS pending,
  COUNT(*) FILTER (WHERE status = 'assigned')::integer AS assigned,
  COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed,
  COUNT(*) FILTER (WHERE NOT isbacktest)::integer AS basetotal,
  COUNT(*) FILTER (WHERE NOT isbacktest AND status = 'pending')::integer AS basepending,
  COALESCE(MAX(updatedat), (SELECT cutoff FROM repair_meta)) AS updatedat
FROM rating_tasks
WHERE taskversion = 'v3'
  AND projectid IN (SELECT projectid FROM repair_projects)
GROUP BY projectid, taskversion;

CREATE TEMP TABLE rebuilt_scorer_task_stats ON COMMIT DROP AS
SELECT
  scorer,
  taskversion,
  projectid,
  COUNT(*) FILTER (WHERE status = 'assigned')::integer AS assigned,
  COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed,
  COALESCE(MAX(updatedat), (SELECT cutoff FROM repair_meta)) AS updatedat
FROM rating_tasks
WHERE taskversion = 'v3'
  AND projectid IN (SELECT projectid FROM repair_projects)
  AND scorer IS NOT NULL
  AND BTRIM(scorer) <> ''
  AND status IN ('assigned', 'completed')
GROUP BY scorer, taskversion, projectid;

CREATE TEMP TABLE rebuilt_scorer_scoring_stats ON COMMIT DROP AS
SELECT
  scorer,
  taskversion,
  COALESCE(projectid, '') AS projectid,
  COALESCE(submissionmode, 'untracked') AS submissionmode,
  COUNT(*)::bigint AS taskcount,
  COUNT(*) FILTER (WHERE COALESCE(largeimageopened, false))::bigint AS largeimageopenedcount,
  COUNT(*) FILTER (
    WHERE COALESCE(behaviortracked, false) AND COALESCE(largeimageopened, false)
  )::bigint AS trackedlargeimageopenedcount,
  COALESCE(SUM(GREATEST(COALESCE(largeimageopencount, 0), 0)), 0)::bigint AS largeimageopencounttotal,
  COALESCE(SUM(GREATEST(COALESCE(dragactioncount, 0), 0)), 0)::bigint AS dragactioncounttotal,
  COUNT(*) FILTER (
    WHERE COALESCE(behaviortracked, false) AND COALESCE(orderchanged, false)
  )::bigint AS orderchangedcount,
  COUNT(*) FILTER (
    WHERE COALESCE(behaviortracked, false)
      AND durationms IS NOT NULL
      AND durationms >= 0
      AND durationms < 3000
  )::bigint AS fastsubmitcount,
  COUNT(*) FILTER (
    WHERE COALESCE(behaviortracked, false) AND COALESCE(riskscore, 0) >= 60
  )::bigint AS highriskcount,
  COUNT(*) FILTER (WHERE COALESCE(behaviortracked, false))::bigint AS behaviortrackedcount,
  COALESCE(SUM(
    CASE WHEN COALESCE(behaviortracked, false)
      THEN GREATEST(COALESCE(riskscore, 0), 0)
      ELSE 0
    END
  ), 0)::bigint AS riskscoretotal,
  COALESCE(MAX(GREATEST(COALESCE(riskscore, 0), 0)), 0)::integer AS riskscoremax,
  COALESCE(SUM(
    CASE WHEN COALESCE(behaviortracked, false)
      THEN GREATEST(COALESCE(pageblurcount, 0), 0)
      ELSE 0
    END
  ), 0)::bigint AS pageblurcounttotal,
  COALESCE(SUM(
    CASE WHEN durationms IS NOT NULL AND durationms >= 0
      THEN durationms
      ELSE 0
    END
  ), 0)::bigint AS durationtotal,
  COUNT(*) FILTER (WHERE durationms IS NOT NULL AND durationms >= 0)::bigint AS durationcount,
  MIN(durationms) FILTER (WHERE durationms IS NOT NULL AND durationms >= 0) AS durationmin,
  MAX(durationms) FILTER (WHERE durationms IS NOT NULL AND durationms >= 0) AS durationmax,
  COALESCE(SUM(COALESCE(rollbackcount, 0)), 0)::bigint AS rollbackcount,
  COALESCE(MAX(updatedat), (SELECT cutoff FROM repair_meta)) AS updatedat
FROM rating_tasks
WHERE taskversion = 'v3'
  AND projectid IN (SELECT projectid FROM repair_projects)
  AND scorer IS NOT NULL
  AND BTRIM(scorer) <> ''
  AND status = 'completed'
GROUP BY scorer, taskversion, COALESCE(projectid, ''), COALESCE(submissionmode, 'untracked');

-- Hourly completion statistics are global, so rebuild v3 from the same
-- repeatable-read snapshot before marking repaired project events processed.
CREATE TEMP TABLE rebuilt_dashboard_completion_hour_stats ON COMMIT DROP AS
SELECT
  taskversion,
  EXTRACT(HOUR FROM completedat AT TIME ZONE 'Asia/Shanghai')::integer AS hour,
  COUNT(*)::bigint AS completedtaskcount,
  COALESCE(MAX(updatedat), (SELECT cutoff FROM repair_meta)) AS updatedat
FROM rating_tasks
WHERE taskversion = 'v3'
  AND status = 'completed'
  AND completedat IS NOT NULL
GROUP BY taskversion, EXTRACT(HOUR FROM completedat AT TIME ZONE 'Asia/Shanghai')::integer;

DELETE FROM project_task_stats
WHERE taskversion = 'v3'
  AND projectid IN (SELECT projectid FROM repair_projects);

DELETE FROM scorer_task_stats
WHERE taskversion = 'v3'
  AND projectid IN (SELECT projectid FROM repair_projects);

DELETE FROM scorer_scoring_stats
WHERE taskversion = 'v3'
  AND projectid IN (SELECT projectid FROM repair_projects);

-- Rebuild all indexes on the damaged aggregate table while duplicate heap
-- rows are absent.
REINDEX TABLE scorer_scoring_stats;

INSERT INTO project_task_stats (
  projectid, taskversion, total, pending, assigned, completed,
  basetotal, basepending, updatedat
)
SELECT
  projectid, taskversion, total, pending, assigned, completed,
  basetotal, basepending, updatedat
FROM rebuilt_project_task_stats;

INSERT INTO scorer_task_stats (
  scorer, taskversion, projectid, assigned, completed, updatedat
)
SELECT scorer, taskversion, projectid, assigned, completed, updatedat
FROM rebuilt_scorer_task_stats;

INSERT INTO scorer_scoring_stats (
  scorer, taskversion, projectid, submissionmode, taskcount,
  largeimageopenedcount, trackedlargeimageopenedcount, largeimageopencounttotal,
  dragactioncounttotal, orderchangedcount, fastsubmitcount, highriskcount,
  behaviortrackedcount, riskscoretotal, riskscoremax, pageblurcounttotal,
  durationtotal, durationcount, durationmin, durationmax, rollbackcount, updatedat
)
SELECT
  scorer, taskversion, projectid, submissionmode, taskcount,
  largeimageopenedcount, trackedlargeimageopenedcount, largeimageopencounttotal,
  dragactioncounttotal, orderchangedcount, fastsubmitcount, highriskcount,
  behaviortrackedcount, riskscoretotal, riskscoremax, pageblurcounttotal,
  durationtotal, durationcount, durationmin, durationmax, rollbackcount, updatedat
FROM rebuilt_scorer_scoring_stats;

DELETE FROM dashboard_completion_hour_stats WHERE taskversion = 'v3';
INSERT INTO dashboard_completion_hour_stats (
  taskversion, hour, completedtaskcount, updatedat
)
SELECT taskversion, hour, completedtaskcount, updatedat
FROM rebuilt_dashboard_completion_hour_stats;

UPDATE task_stats_events events
SET processedat = meta.cutoff
FROM repair_meta meta
WHERE events.taskversion = 'v3'
  AND events.processedat IS NULL
  AND events.createdat <= meta.cutoff
  AND events.projectid IN (SELECT projectid FROM repair_projects);

DO $$
DECLARE
  duplicate_groups integer;
  scoring_mismatches integer;
BEGIN
  SELECT COUNT(*) INTO duplicate_groups
  FROM (
    SELECT scorer, taskversion, projectid, submissionmode
    FROM scorer_scoring_stats
    GROUP BY scorer, taskversion, projectid, submissionmode
    HAVING COUNT(*) > 1
  ) duplicates;
  IF duplicate_groups <> 0 THEN
    RAISE EXCEPTION 'Repair validation failed: % duplicate scoring-stat groups remain', duplicate_groups;
  END IF;

  SELECT COUNT(*) INTO scoring_mismatches
  FROM rebuilt_scorer_scoring_stats expected
  FULL JOIN (
    SELECT stats.*
    FROM scorer_scoring_stats stats
    WHERE stats.taskversion = 'v3'
      AND stats.projectid IN (SELECT projectid FROM repair_projects)
  ) actual
    ON actual.scorer = expected.scorer
   AND actual.taskversion = expected.taskversion
   AND actual.projectid = expected.projectid
   AND actual.submissionmode = expected.submissionmode
  WHERE expected.scorer IS NULL
     OR actual.scorer IS NULL
     OR actual.taskcount <> expected.taskcount
     OR actual.durationtotal <> expected.durationtotal
     OR actual.riskscoretotal <> expected.riskscoretotal;
  IF scoring_mismatches <> 0 THEN
    RAISE EXCEPTION 'Repair validation failed: % rebuilt scoring-stat rows mismatch', scoring_mismatches;
  END IF;
END;
$$;

SELECT
  (SELECT cutoff FROM repair_meta) AS repair_cutoff,
  (SELECT COUNT(*) FROM repair_projects) AS repaired_projects,
  (SELECT COUNT(*) FROM rebuilt_scorer_scoring_stats) AS rebuilt_scoring_rows,
  (SELECT COUNT(*) FROM task_stats_events WHERE processedat IS NULL) AS pending_events_visible_in_snapshot;

COMMIT;

ANALYZE project_task_stats;
ANALYZE scorer_task_stats;
ANALYZE scorer_scoring_stats;
ANALYZE dashboard_completion_hour_stats;
