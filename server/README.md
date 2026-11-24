# Server code map

The API entry point is `src/index.ts`. It imports the Express app from `src/app.js`, starts listening, then runs startup maintenance. `src/postgres.ts` owns the PostgreSQL pool and the SQLite-style prepared-statement adapter. Compose runs `dist/migrate-schema.js` before the API, compiled from `src/migrate-schema.ts`. Versioned SQL lives in `src/migrations/`; `src/postgres-schema.sql` is a full-schema reference for the SQLite migration utility.

Like the client, the server separates its entry point, feature-facing endpoints, and data services. `src/routes/` registers HTTP endpoints and shapes responses. `src/services/` owns domain queries and operations. `src/app.js` wires middleware and dependencies together while older domains are moved out incrementally. Route files receive their services explicitly; they do not create database pools or start background workers.

## Main paths

| Area | Files | Responsibility |
| --- | --- | --- |
| HTTP API assembly | `src/app.js` | Middleware, startup wiring, dependency assembly and the remaining cross-domain helpers. |
| Database statements | `src/repositories/*.js` | Prepared statements grouped by project, account, import, task, statistics and assets. |
| Project and import HTTP endpoints | `src/routes/projects.js`, `task-generation.js`, `imports.js` | Register project CRUD, task generation, direct ZIP, Tus and chunked import endpoints. |
| Catalog HTTP endpoints | `src/routes/catalog.js` | Subject list, categories, scorer names and image list with the existing access checks. |
| Admin task HTTP endpoints | `src/routes/admin-tasks.js` | Task lists, details, reports, reassignment and generation route registration. |
| Project and task operations | `src/services/projects.js`, `task-generation-*.js` | Project CRUD, locks and visibility; task planning, assignment, execution and job lifecycle. |
| Accounts, feedback and teams | `src/services/login.ts`, `auth-session.js`, `scorer-accounts.js`, `teams.js`, `feedback.js` | Login, sessions, scorer accounts, team membership and feedback lifecycle. |
| Task statistics | `src/services/task-stats-calculation.ts`, `task-stats-write.ts`, `task-stats-worker.js` | Event deltas, materialized counters and background reconciliation. |
| Scorer task submission | `src/services/task-submission.js`, `task-submission-validation.js` | Validate ranking and behavior data, claim tasks, submit and edit completed tasks. |
| Image catalog queries | `src/services/catalog.js` | Image filtering, pagination, category and scorer lists. |
| Archive import | `src/services/import-archive.js` | ZIP parsing and image import work. |
| Admin HTTP endpoints | `src/routes/admin-dashboard.ts`, `admin-system.ts`, `admin-exports.ts`, `admin-*.js` | Register dashboard, thumbnail, system/log, scoring, account/team, and export endpoints after admin authentication middleware. |
| Authentication and scorer HTTP endpoints | `src/routes/auth.js`, `scorer-tasks.js`, `feedback.js` | Keep public login, authenticated session, scorer tasks, and feedback endpoints in their own modules. `app.js` preserves middleware order. |
| Route error handling | `src/routes/async-route.ts` | Pass rejected async handlers to the existing API error middleware. |
| Admin summaries | `src/services/admin-dashboard.js`, `admin-scoring.js`, `admin-system.js`, `admin-logs.ts` | Dashboard, scoring management, host health and logs. |
| Image access and scores | `src/services/access.ts`, `image-score.ts` | Verify project and file access; parse score values and shape stored scores. |
| Thumbnail import | `src/services/thumbnail-import.ts` | Adds thumbnail jobs after image import; it does not decode images. |
| Thumbnail queue controls | `src/services/admin-thumbnails.js` | Queue overview, per-package pause/disable/priority and retries. |
| Thumbnail execution | `src/thumbnail-worker.ts`, `src/image-assets.ts`, `src/thumbnail-cache.ts`, `src/thumbnail-scheduler.ts`, `src/thumbnail-runtime.ts` | Queue repair and claim, image conversion and content reuse, time-of-day concurrency, timeouts. |
| Task generation | `src/task-generation-worker.ts`, `src/task-stats-retry.ts` | Worker process and statistics retries. |

## Thumbnail flow

1. An import writes image records; `thumbnail-import.ts` adds pending jobs asynchronously.
2. The thumbnail worker periodically checks for missing jobs and expired claims. Disabled packages are skipped when repairing the queue.
3. The worker reads queue controls, pages candidate packages in groups of 64 using priority/import-time/ID cursors, claims jobs, converts images through Sharp and marks both the job and image record ready in one transaction.
   Manually prioritized packages run first. Other eligible jobs are claimed from the newest imported package, oldest job first within that package; this also applies after a worker restart.
4. The admin endpoint reports raw pending jobs and separately reports pending jobs in disabled packages. Disabling a package preserves jobs so it can be resumed later.
5. PostgreSQL integrity errors pause the queue in `thumbnail_queue_settings` and appear in operational logs as `thumbnail-database-integrity`. Repair the database first, then resume the queue in the admin page. These failures do not consume a job's attempt allowance.
6. Admin queue counts read `thumbnail_subject_stats` instead of scanning all image/job rows. Statement triggers maintain counts when job status changes. The API fills historical counts one package at a time after startup; packages being rebuilt show `统计中`. This backfill runs in the background and does not delay API readiness.
7. For an image without a valid thumbnail, the worker hashes its source bytes together with the output settings. Images with identical content reuse a WebP file through hard links across packages; unsupported filesystems fall back to copying. A per-key lock prevents concurrent workers from converting the same image at once. The cache is outside package directories and is inaccessible through the image API. Every five minutes the worker checks one of 256 cache shards and removes files older than 14 days only when no package still links to them. Unique images incur a source-file hash read before conversion.

`subjects.taskstatus` is not a reliable indicator that labeling has finished. To identify finished-only packages, inspect all links in `project_packages` plus the primary `projects.packageid`, and exclude any package still used by an active project.
The admin page's "停用已完成图包" action previews at most 100 eligible packages and requires confirmation. The server rechecks project links before disabling them; it does not delete their queued jobs.

## Troubleshooting

- `XX002` / `unexpected zero page` names a damaged PostgreSQL index. Code retries do not repair it. Confirm the exact index before targeted maintenance.
- Check Worker logs for `thumbnail-queue-repair` and thumbnail errors; compare the latest `thumbnail_jobs.completedat` with the queue counts in the admin page.
- The admin thumbnail page requests 10–50 packages at a time and can search by package name or ID. Package and global counts come from the small stats table and are cached for 45 seconds; the last five minutes of completed jobs use the completed-time index. Control updates invalidate the overview cache.
- The frontend falls back to the original image when `thumbnailPath` is absent; skipping unnecessary thumbnails does not delete images.

## Build and schema migrations

Run `npm run build` in `server/` before `npm start`, `npm run migrate:schema`, or a production Worker command. The build compiles JS/TS to `dist/` and copies migration SQL plus the full-schema reference. Development commands use `tsx` against `src/`. The Dockerfile builds `dist/` in a build stage and installs production dependencies in the runtime stage.

`schema_migrations` records a SHA-256 checksum for each immutable migration. The migrator takes an advisory lock and applies each outstanding migration in its own transaction. On an existing database, migration `0001` adopts the legacy schema after checking its expected tables; a fresh database executes it. `0002` adds thumbnail package statistics and triggers. `0003` removes the redundant `idx_project_packages_project_package` index; `project_packages_pkey` remains. A failed migration rolls back its transaction, and rerunning the migrator skips applied versions. Put later schema changes in a new numbered file; do not edit an applied migration.

For deployment, build and run `schema-migrate` first, then start the API and Workers. If `0002` or `0003` has already succeeded but the new API must be rolled back, the old API can run with the additive statistics table/triggers and without the redundant index; leave migration records in place. A failed migration should be diagnosed before restarting the API. The existing-schema adoption assumes all expected legacy tables represent the v54 schema; verify older or partially migrated databases separately before using this migrator.

When extracting the rest of `app.js`, keep existing routes and response shapes stable, move one domain at a time, and verify the import, task submission and admin flows after each move. `postgres.ts` still has a legacy camelCase row-key adapter; it now scans the complete source tree so newly moved services retain their existing row keys. Quote new camelCase SQL aliases explicitly when practical.

Run the isolated PostgreSQL flow test with `INTEGRATION_DATABASE_URL=postgresql://<local-user>@127.0.0.1:5432/rating_optimization_test_<name> npm run test:integration`. The test truncates tables in that local test database, then verifies ZIP import, reference image, project task lock, task generation, thumbnail pause/resume, scorer submission, and completed-task export.

The service and route layout is a transition. `app.js` still holds startup and cross-domain wiring, while the remaining subject/image handlers live in domain routes. New endpoints should be registered in their domain route file and call a service.
