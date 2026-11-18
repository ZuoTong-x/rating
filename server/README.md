# Server code map

The API entry point is `src/index.js`. It imports the Express app from `src/app.js`, starts listening, then runs startup maintenance. `src/postgres.js` owns the PostgreSQL pool and the SQLite-style prepared-statement adapter. Schema changes run through `src/migrate-schema.js` and `src/postgres-schema.sql` in the Compose deployment.

Like the client, the server separates its entry point, feature-facing endpoints, and data services. `src/routes/` registers HTTP endpoints and shapes responses. `src/services/` owns domain queries and operations. `src/app.js` wires middleware and dependencies together while older domains are moved out incrementally. Route files receive their services explicitly; they do not create database pools or start background workers.

## Main paths

| Area | Files | Responsibility |
| --- | --- | --- |
| HTTP API and older domain logic | `src/app.js` | Routes, imports, project and task operations. This is the remaining large module to split by domain. |
| Admin HTTP endpoints | `src/routes/admin-*.js` | Register dashboard, thumbnail, system/log, scoring, account/team, and export endpoints after admin authentication middleware. |
| Authentication and scorer HTTP endpoints | `src/routes/auth.js`, `scorer-tasks.js`, `feedback.js` | Keep public login, authenticated session, scorer tasks, and feedback endpoints in their own modules. `app.js` preserves middleware order. |
| Route error handling | `src/routes/async-route.js` | Pass rejected async handlers to the existing API error middleware. |
| Admin summaries | `src/services/admin-dashboard.js`, `admin-scoring.js`, `admin-system.js`, `admin-logs.js` | Dashboard, scoring management, host health and logs. |
| Thumbnail import | `src/services/thumbnail-import.js` | Adds thumbnail jobs after image import; it does not decode images. |
| Thumbnail queue controls | `src/services/admin-thumbnails.js` | Queue overview, per-package pause/disable/priority and retries. |
| Thumbnail execution | `src/thumbnail-worker.js`, `src/image-assets.js`, `src/thumbnail-scheduler.js`, `src/thumbnail-runtime.js` | Queue repair and claim, image conversion, time-of-day concurrency, timeouts. |
| Task generation | `src/task-generation-worker.js`, `src/task-stats-retry.js` | Worker process and statistics retries. |

## Thumbnail flow

1. An import writes image records; `thumbnail-import.js` adds pending jobs asynchronously.
2. The thumbnail worker periodically checks for missing jobs and expired claims. Disabled packages are skipped when repairing the queue.
3. The worker reads queue controls, claims jobs, converts images through Sharp and marks both the job and image record ready in one transaction.
   Manually prioritized packages run first. Other eligible jobs are claimed from the newest imported package, oldest job first within that package; this also applies after a worker restart.
4. The admin endpoint reports raw pending jobs and separately reports pending jobs in disabled packages. Disabling a package preserves jobs so it can be resumed later.
5. PostgreSQL integrity errors pause the queue in `thumbnail_queue_settings` and appear in operational logs as `thumbnail-database-integrity`. Repair the database first, then resume the queue in the admin page. These failures do not consume a job's attempt allowance.
6. Admin queue counts read `thumbnail_subject_stats` instead of scanning all image/job rows. Statement triggers maintain counts when job status changes. The API fills historical counts one package at a time after startup; packages being rebuilt show `统计中`. This backfill runs in the background and does not delay API readiness.

`subjects.taskstatus` is not a reliable indicator that labeling has finished. To identify finished-only packages, inspect all links in `project_packages` plus the primary `projects.packageid`, and exclude any package still used by an active project.
The admin page's "停用已完成图包" action previews at most 100 eligible packages and requires confirmation. The server rechecks project links before disabling them; it does not delete their queued jobs.

## Troubleshooting

- `XX002` / `unexpected zero page` names a damaged PostgreSQL index. Code retries do not repair it. Confirm the exact index before targeted maintenance.
- Check Worker logs for `thumbnail-worker-heartbeat` and `thumbnail-queue-repair`; compare `lastClaimedAt`, `activeJobCount` and the latest `thumbnail_jobs.completedat`.
- The admin thumbnail page requests 10–50 packages at a time and can search by package name or ID. Package and global counts come from the small stats table and are cached for 45 seconds; the last five minutes of completed jobs use the completed-time index. Control updates invalidate the overview cache.
- The frontend falls back to the original image when `thumbnailPath` is absent; skipping unnecessary thumbnails does not delete images.

When extracting the rest of `app.js`, keep existing routes and response shapes stable, move one domain at a time, and verify the import, task submission and admin flows after each move.

The service and route layout is a transition, not a completed migration. The import and project/task logic still lives in `app.js`. New endpoints should be registered in their domain route file and call a service rather than adding another large handler to `app.js`.
