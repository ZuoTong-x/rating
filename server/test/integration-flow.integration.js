import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import pg from "pg";
import sharp from "sharp";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error("Set INTEGRATION_DATABASE_URL to an isolated local test database");
const databaseLocation = new URL(databaseUrl);
if (!["127.0.0.1", "localhost"].includes(databaseLocation.hostname)) {
  throw new Error("Integration tests only run against local PostgreSQL");
}
const databaseName = databaseLocation.pathname.slice(1);
if (!/^rating_optimization_test_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error("Integration tests require a rating_optimization_test_* database");
}

const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "rating-integration-"));
process.env.DATABASE_URL = databaseUrl;
process.env.RUN_SCHEMA_INIT = "0";
process.env.UPLOAD_DIR = path.join(temporaryDir, "uploads");
process.env.LOG_DIR = path.join(temporaryDir, "logs");

const moduleRoot = process.env.INTEGRATION_USE_DIST === "1" ? "../dist" : "../src";
const { default: app, runStartupMaintenance, startupState } = await import(`${moduleRoot}/app.${process.env.INTEGRATION_USE_DIST === "1" ? "js" : "ts"}`);
const { pool: appPool } = await import(`${moduleRoot}/postgres.${process.env.INTEGRATION_USE_DIST === "1" ? "js" : "ts"}`);
const seedPool = new pg.Pool({ connectionString: databaseUrl });
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

async function request(uri, { method = "GET", cookie, body, headers: extraHeaders = {} } = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...extraHeaders };
  const rawBody = body instanceof FormData || Buffer.isBuffer(body) || body instanceof Blob;
  if (body != null && !rawBody) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${uri}`, {
    method,
    headers,
    body: rawBody ? body : body == null ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer();
  return { response, payload };
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

async function seedUser(id, username, role) {
  await seedPool.query(`
    INSERT INTO users (id, username, password, role, status, mustchangepassword, createdat, updatedat)
    VALUES ($1, $2, $3, $4, 'enabled', false, NOW(), NOW())
  `, [id, username, passwordHash("Integration@123"), role]);
}

async function login(username) {
  const { response, payload } = await request("/api/auth/login", {
    method: "POST",
    body: { username, password: "Integration@123" },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.user.username, username);
  return response.headers.get("set-cookie").split(";")[0];
}

async function waitForJob(uri, cookie, maxAttempts = 80) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { response, payload } = await request(uri, { cookie });
    assert.equal(response.status, 200, JSON.stringify(payload));
    if (payload.status === "completed") return payload;
    if (payload.status === "failed") assert.fail(JSON.stringify(payload));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Timed out waiting for ${uri}`);
}

async function waitForThumbnailJobs(subjectId, expected) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await seedPool.query(`
      SELECT COUNT(*)::int AS total FROM thumbnail_jobs jobs
      JOIN images ON images.id = jobs.imageid
      WHERE images.subjectid = $1
    `, [subjectId]);
    if (result.rows[0].total === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Thumbnail jobs for ${subjectId} did not reach ${expected}`);
}

test("login → ZIP import → locked project → task generation → scorer submit → export", async () => {
  let thumbnailWorker = null;
  let secondaryThumbnailWorker = null;
  let thumbnailWorkerLog = "";
  try {
    const tables = await seedPool.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        AND tablename NOT IN ('thumbnail_queue_settings', 'schema_migrations')
    `);
    if (tables.rows.length) {
      const names = tables.rows.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(", ");
      await seedPool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
    }
    await runStartupMaintenance();
    assert.equal(startupState.status, "ready", startupState.error || "startup maintenance did not finish");
    await seedPool.query(`
      INSERT INTO thumbnail_queue_settings (
        id, globallypaused, daytimeconcurrency, nighttimeconcurrency,
        nightstarthour, nightendhour, timezone, updatedat
      ) VALUES ('default', false, 2, 6, 22, 8, 'Asia/Shanghai', NOW())
      ON CONFLICT (id) DO UPDATE SET globallypaused = false, updatedat = NOW()
    `);
    const now = new Date().toISOString();
    await seedUser("integration-admin", "admin", "admin");
    await seedUser("integration-scorer", "integration-scorer", "scorer");
    await seedUser("integration-scorer-2", "integration-scorer-2", "scorer");
    await seedPool.query("INSERT INTO teams (id, name, status, createdat, updatedat) VALUES ($1, $2, 'enabled', $3, $3)", ["integration-team", "Integration team", now]);
    await seedPool.query("INSERT INTO user_teams (userid, teamid, createdat) VALUES ($1, $2, $3)", ["integration-scorer", "integration-team", now]);
    await seedPool.query("INSERT INTO user_teams (userid, teamid, createdat) VALUES ($1, $2, $3)", ["integration-scorer-2", "integration-team", now]);

    const adminCookie = await login("admin");
    const scorerCookie = await login("integration-scorer");
    const adminSession = await request("/api/auth/session", { cookie: adminCookie });
    assert.equal(adminSession.response.status, 200);
    assert.equal(adminSession.payload.user.role, "admin");
    const scorerSession = await request("/api/auth/session", { cookie: scorerCookie });
    assert.equal(scorerSession.response.status, 200);
    assert.equal(scorerSession.payload.user.role, "scorer");
    assert.equal((await request("/api/projects")).response.status, 401);
    assert.equal((await request("/api/admin/thumbnails", { cookie: scorerCookie })).response.status, 403);
    const systemStatus = await request("/api/admin/system/status", { cookie: adminCookie });
    assert.equal(systemStatus.response.status, 200, JSON.stringify(systemStatus.payload));
    assert.equal(systemStatus.payload.database.status, "healthy");
    assert.ok(Array.isArray(systemStatus.payload.activity.hotApis));

    const feedbackForm = new FormData();
    feedbackForm.set("title", "Integration feedback");
    feedbackForm.set("type", "platform_bug");
    feedbackForm.set("description", "Feedback service regression check");
    const createdFeedback = await request("/api/feedbacks", {
      method: "POST", cookie: scorerCookie, body: feedbackForm,
    });
    assert.equal(createdFeedback.response.status, 201, JSON.stringify(createdFeedback.payload));
    const feedbackId = createdFeedback.payload.feedback.id;
    assert.equal(createdFeedback.payload.feedback.status, "pending");
    const listedFeedback = await request("/api/feedbacks?page=1&pageSize=10", { cookie: adminCookie });
    assert.equal(listedFeedback.response.status, 200, JSON.stringify(listedFeedback.payload));
    assert.ok(listedFeedback.payload.items.some((item) => item.id === feedbackId));
    const repliedFeedback = await request(`/api/feedbacks/${feedbackId}/reply`, {
      method: "PUT", cookie: adminCookie, body: { content: "Received" },
    });
    assert.equal(repliedFeedback.response.status, 200, JSON.stringify(repliedFeedback.payload));
    assert.equal(repliedFeedback.payload.feedback.status, "processing");
    assert.equal(repliedFeedback.payload.feedback.messages.length, 1);
    const resolvedFeedback = await request(`/api/feedbacks/${feedbackId}/status`, {
      method: "PUT", cookie: adminCookie, body: { status: "resolved" },
    });
    assert.equal(resolvedFeedback.response.status, 200, JSON.stringify(resolvedFeedback.payload));
    assert.equal(resolvedFeedback.payload.feedback.status, "resolved");

    const createdTeam = await request("/api/teams", {
      method: "POST", cookie: adminCookie, body: { name: "Regression team" },
    });
    assert.equal(createdTeam.response.status, 201, JSON.stringify(createdTeam.payload));
    const regressionTeamId = createdTeam.payload.team.id;
    const disabledTeam = await request(`/api/teams/${regressionTeamId}`, {
      method: "PATCH", cookie: adminCookie, body: { status: "disabled" },
    });
    assert.equal(disabledTeam.response.status, 200, JSON.stringify(disabledTeam.payload));
    assert.equal(disabledTeam.payload.team.status, "disabled");
    const disabledTeams = await request("/api/teams?status=disabled", { cookie: adminCookie });
    assert.equal(disabledTeams.response.status, 200, JSON.stringify(disabledTeams.payload));
    assert.ok(disabledTeams.payload.some((team) => team.id === regressionTeamId));
    const deletedTeam = await request(`/api/teams/${regressionTeamId}`, {
      method: "DELETE", cookie: adminCookie,
    });
    assert.equal(deletedTeam.response.status, 200, JSON.stringify(deletedTeam.payload));
    assert.equal(deletedTeam.payload.deleted, true);

    const createdScorer = await request("/api/users/scorers", {
      method: "POST", cookie: adminCookie,
      body: { username: "regression-scorer", password: "Regression@123", teamNames: [] },
    });
    assert.equal(createdScorer.response.status, 201, JSON.stringify(createdScorer.payload));
    const scorerId = createdScorer.payload.user.id;
    const scorerPage = await request("/api/users/scorers?page=1&pageSize=20", { cookie: adminCookie });
    assert.equal(scorerPage.response.status, 200, JSON.stringify(scorerPage.payload));
    assert.ok(scorerPage.payload.users.some((user) => user.id === scorerId));
    const disabledScorer = await request(`/api/users/scorers/${scorerId}`, {
      method: "PATCH", cookie: adminCookie, body: { status: "disabled" },
    });
    assert.equal(disabledScorer.response.status, 200, JSON.stringify(disabledScorer.payload));
    assert.equal(disabledScorer.payload.user.status, "disabled");
    const deletedScorer = await request(`/api/users/scorers/${scorerId}`, {
      method: "DELETE", cookie: adminCookie,
    });
    assert.equal(deletedScorer.response.status, 200, JSON.stringify(deletedScorer.payload));
    assert.equal(deletedScorer.payload.deleted, true);

    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#e4a85a" },
    }).png().toBuffer();
    const zip = new AdmZip();
    for (const name of ["a.png", "b.png", "reference.png"]) zip.addFile(name, image);
    zip.addFile("tasks.json", Buffer.from(JSON.stringify({
      version: 1,
      tasks: [{
        id: "integration-task",
        criterion: "ss_infographic_v2",
        images: [
          { src_rel_path: "reference.png", role: "filler" },
          "a.png",
          "b.png",
        ],
      }],
    })));
    const form = new FormData();
    form.set("file", new Blob([zip.toBuffer()], { type: "application/zip" }), "integration.zip");
    const imported = await request("/api/import", { method: "POST", cookie: adminCookie, body: form });
    assert.equal(imported.response.status, 201, JSON.stringify(imported.payload));
    assert.equal(imported.payload.imported, 3);
    const subjectId = imported.payload.subject._id;
    const importedImage = await seedPool.query(
      "SELECT id FROM images WHERE subjectid = $1 ORDER BY id LIMIT 1", [subjectId],
    );
    const scoredImage = await request(`/api/images/${importedImage.rows[0].id}/score`, {
      method: "PUT", cookie: adminCookie, body: { overall: 8, comment: "Integration score" },
    });
    assert.equal(scoredImage.response.status, 200, JSON.stringify(scoredImage.payload));
    assert.equal(scoredImage.payload.score.overall, 8);
    assert.equal(scoredImage.payload.score.comment, "Integration score");

    const tusArchive = zip.toBuffer();
    const tusHeaders = { "Tus-Resumable": "1.0.0" };
    const tusCreated = await request("/api/import/uploads", {
      method: "POST", cookie: adminCookie,
      headers: {
        ...tusHeaders,
        "Upload-Length": String(tusArchive.length),
        "Upload-Metadata": `filename ${Buffer.from("integration-tus.zip").toString("base64")}`,
      },
    });
    assert.equal(tusCreated.response.status, 201, JSON.stringify(tusCreated.payload));
    const uploadId = tusCreated.payload.uploadId;
    const tusProbe = await request(`/api/import/uploads/${uploadId}`, {
      method: "HEAD", cookie: adminCookie, headers: tusHeaders,
    });
    assert.equal(tusProbe.response.status, 204);
    assert.equal(tusProbe.response.headers.get("upload-offset"), "0");
    const tusPatched = await request(`/api/import/uploads/${uploadId}`, {
      method: "PATCH", cookie: adminCookie, body: tusArchive,
      headers: {
        ...tusHeaders,
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
      },
    });
    assert.equal(tusPatched.response.status, 204, JSON.stringify(tusPatched.payload));
    const tusJob = await waitForJob(`/api/import/uploads/${uploadId}/status`, adminCookie);
    assert.equal(tusJob.result?.imported, 3);
    const tusSubjectId = tusJob.result.subject._id;

    const chunkUploadId = crypto.randomUUID();
    const chunkForm = new FormData();
    chunkForm.set("chunk", new Blob([tusArchive], { type: "application/zip" }), "part.bin");
    const chunkPart = await request(`/api/import/chunks/${chunkUploadId}/parts/0`, {
      method: "POST", cookie: adminCookie, body: chunkForm,
    });
    assert.equal(chunkPart.response.status, 204, JSON.stringify(chunkPart.payload));
    const chunkCompleted = await request(`/api/import/chunks/${chunkUploadId}/complete`, {
      method: "POST", cookie: adminCookie,
      body: { filename: "integration-chunked.zip", totalChunks: 1 },
    });
    assert.equal(chunkCompleted.response.status, 202, JSON.stringify(chunkCompleted.payload));
    const chunkJob = await waitForJob(`/api/import/chunks/${chunkUploadId}/status`, adminCookie);
    assert.equal(chunkJob.result?.imported, 3);
    const chunkSubjectId = chunkJob.result.subject._id;

    await waitForThumbnailJobs(subjectId, 3);
    const stats = await seedPool.query("SELECT pending, total FROM thumbnail_subject_stats WHERE subjectid = $1", [subjectId]);
    assert.equal(Number(stats.rows[0].pending), 3);
    assert.equal(Number(stats.rows[0].total), 3);
    const jobIds = (await seedPool.query(`
      SELECT jobs.imageid FROM thumbnail_jobs jobs
      JOIN images ON images.id = jobs.imageid
      WHERE images.subjectid = $1 ORDER BY jobs.imageid
    `, [subjectId])).rows.map((row) => row.imageid);
    await seedPool.query("UPDATE thumbnail_jobs SET status = 'processing' WHERE imageid = $1", [jobIds[0]]);
    await seedPool.query("UPDATE thumbnail_jobs SET status = 'failed' WHERE imageid = $1", [jobIds[1]]);
    const changedStats = await seedPool.query(`
      SELECT pending, processing, failed, total FROM thumbnail_subject_stats WHERE subjectid = $1
    `, [subjectId]);
    assert.deepEqual(
      ['pending', 'processing', 'failed', 'total'].map((key) => Number(changedStats.rows[0][key])),
      [1, 1, 1, 3],
    );
    await seedPool.query("UPDATE thumbnail_jobs SET status = 'pending' WHERE imageid = ANY($1::text[])", [jobIds.slice(0, 2)]);
    const restoredStats = await seedPool.query("SELECT pending, processing, failed, total FROM thumbnail_subject_stats WHERE subjectid = $1", [subjectId]);
    assert.deepEqual(
      ['pending', 'processing', 'failed', 'total'].map((key) => Number(restoredStats.rows[0][key])),
      [3, 0, 0, 3],
    );
    const overviewStarted = performance.now();
    const overview = await request("/api/admin/thumbnails?page=1&pageSize=25", { cookie: adminCookie });
    const overviewMs = Math.round(performance.now() - overviewStarted);
    assert.equal(overview.response.status, 200, JSON.stringify(overview.payload));
    const invalidSchedule = await request("/api/admin/thumbnails/settings", {
      method: "PATCH", cookie: adminCookie, body: { nighttimeConcurrency: 17 },
    });
    assert.equal(invalidSchedule.response.status, 400, JSON.stringify(invalidSchedule.payload));
    const schedule = await request("/api/admin/thumbnails/settings", {
      method: "PATCH", cookie: adminCookie,
      body: { daytimeConcurrency: 2, nighttimeConcurrency: 6, nightStartHour: 22, nightEndHour: 8 },
    });
    assert.equal(schedule.response.status, 200, JSON.stringify(schedule.payload));
    assert.equal(schedule.payload.settings.daytimeConcurrency, 2);
    assert.equal(schedule.payload.settings.nighttimeConcurrency, 6);
    const completedCandidates = await request("/api/admin/thumbnails/completed-candidates", { cookie: adminCookie });
    assert.equal(completedCandidates.response.status, 200, JSON.stringify(completedCandidates.payload));
    assert.ok(Array.isArray(completedCandidates.payload.packages));

    const paused = await request(`/api/admin/thumbnails/packages/${subjectId}`, {
      method: "PATCH", cookie: adminCookie, body: { paused: true },
    });
    assert.equal(paused.response.status, 200, JSON.stringify(paused.payload));
    assert.equal(paused.payload.control.paused, true);
    const resumed = await request(`/api/admin/thumbnails/packages/${subjectId}`, {
      method: "PATCH", cookie: adminCookie, body: { paused: false },
    });
    assert.equal(resumed.response.status, 200, JSON.stringify(resumed.payload));
    assert.equal(resumed.payload.control.paused, false);
    const disabled = await request(`/api/admin/thumbnails/packages/${tusSubjectId}`, {
      method: "PATCH", cookie: adminCookie, body: { generationEnabled: false },
    });
    assert.equal(disabled.response.status, 200, JSON.stringify(disabled.payload));
    assert.equal(disabled.payload.control.generationEnabled, false);

    // Newer stale package counters must not hide real pending jobs beyond the first cursor page.
    await seedPool.query(`
      INSERT INTO subjects (id, name, originalfilename, importbatch, imagecount,
                            categorycount, status, createdat, updatedat)
      SELECT 'integration-empty-' || n, 'Stale candidate ' || n, 'empty.zip',
             'integration-empty-' || n, 1, 0, 'imported',
             NOW() + INTERVAL '1 day', NOW()
      FROM generate_series(1, 70) AS n
    `);
    const { findBackfillCandidate } = await import(`${moduleRoot}/thumbnail-stats-backfill.${process.env.INTEGRATION_USE_DIST === "1" ? "js" : "ts"}`);
    assert.equal(await findBackfillCandidate([]), "integration-empty-1");
    assert.equal(await findBackfillCandidate(["integration-empty-1"]), "integration-empty-10");

    const workerPath = fileURLToPath(new URL(
      `${moduleRoot}/thumbnail-worker.${process.env.INTEGRATION_USE_DIST === "1" ? "js" : "ts"}`,
      import.meta.url,
    ));
    thumbnailWorker = spawn(process.execPath, [
      ...(process.env.INTEGRATION_USE_DIST === "1" ? [] : ["--import", "tsx"]),
      workerPath,
    ], {
      env: {
        ...process.env,
        THUMBNAIL_WORKER: "1",
        THUMBNAIL_POLL_MS: "100",
        THUMBNAIL_SETTINGS_REFRESH_INTERVAL_MS: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    thumbnailWorker.stdout.on("data", (chunk) => { thumbnailWorkerLog += chunk.toString(); });
    thumbnailWorker.stderr.on("data", (chunk) => { thumbnailWorkerLog += chunk.toString(); });
    secondaryThumbnailWorker = spawn(process.execPath, [
      ...(process.env.INTEGRATION_USE_DIST === "1" ? [] : ["--import", "tsx"]),
      workerPath,
    ], {
      env: {
        ...process.env,
        THUMBNAIL_WORKER: "1",
        THUMBNAIL_POLL_MS: "100",
        THUMBNAIL_SETTINGS_REFRESH_INTERVAL_MS: "100",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    secondaryThumbnailWorker.stdout.on("data", (chunk) => { thumbnailWorkerLog += chunk.toString(); });
    secondaryThumbnailWorker.stderr.on("data", (chunk) => { thumbnailWorkerLog += chunk.toString(); });
    let readyThumbnailCount = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await seedPool.query(`
        SELECT COUNT(*)::int AS total FROM thumbnail_jobs jobs
        JOIN images ON images.id = jobs.imageid
        WHERE images.subjectid = $1 AND jobs.status = 'ready'
      `, [subjectId]);
      readyThumbnailCount = ready.rows[0].total;
      if (readyThumbnailCount === 3) break;
      if (thumbnailWorker.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(readyThumbnailCount, 3, `Thumbnail worker did not complete imported images: ${thumbnailWorkerLog}`);
    const readyStats = await seedPool.query("SELECT ready, total FROM thumbnail_subject_stats WHERE subjectid = $1", [subjectId]);
    assert.equal(Number(readyStats.rows[0].ready), 3);
    assert.equal(Number(readyStats.rows[0].total), 3);
    const disabledJobs = await seedPool.query(`
      SELECT jobs.status FROM thumbnail_jobs jobs JOIN images ON images.id = jobs.imageid
      WHERE images.subjectid = $1
    `, [tusSubjectId]);
    assert.equal(disabledJobs.rows.length, 3);
    assert.ok(disabledJobs.rows.every((row) => row.status === "pending"));
    const reenabled = await request(`/api/admin/thumbnails/packages/${tusSubjectId}`, {
      method: "PATCH", cookie: adminCookie, body: { generationEnabled: true },
    });
    assert.equal(reenabled.response.status, 200, JSON.stringify(reenabled.payload));
    let resumedReadyCount = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await seedPool.query(`
        SELECT COUNT(*)::int AS total FROM thumbnail_jobs jobs
        JOIN images ON images.id = jobs.imageid
        WHERE images.subjectid = $1 AND jobs.status = 'ready'
      `, [tusSubjectId]);
      resumedReadyCount = ready.rows[0].total;
      if (resumedReadyCount === 3) break;
      if (thumbnailWorker.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(resumedReadyCount, 3, `Re-enabled package did not resume: ${thumbnailWorkerLog}`);
    let duplicateImportReadyCount = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await seedPool.query(`
        SELECT COUNT(*)::int AS total FROM thumbnail_jobs jobs
        JOIN images ON images.id = jobs.imageid
        WHERE images.subjectid = $1 AND jobs.status = 'ready'
      `, [chunkSubjectId]);
      duplicateImportReadyCount = ready.rows[0].total;
      if (duplicateImportReadyCount === 3) break;
      if (thumbnailWorker.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(duplicateImportReadyCount, 3, `Repeated ZIP import package was skipped: ${thumbnailWorkerLog}`);
    const duplicateClaims = await seedPool.query(`
      SELECT COUNT(*)::int AS total FROM thumbnail_jobs jobs
      JOIN images ON images.id = jobs.imageid
      WHERE images.subjectid = ANY($1::text[]) AND jobs.attempts <> 1
    `, [[subjectId, tusSubjectId, chunkSubjectId]]);
    assert.equal(duplicateClaims.rows[0].total, 0, "parallel workers must claim each image only once");
    const repeatedImages = await seedPool.query(`
      SELECT thumbnailpath FROM images
      WHERE subjectid = ANY($1::text[])
    `, [[subjectId, tusSubjectId, chunkSubjectId]]);
    assert.equal(repeatedImages.rows.length, 9);
    const thumbnailInodes = await Promise.all(repeatedImages.rows.map(async ({ thumbnailpath }) => {
      assert.ok(thumbnailpath);
      const file = path.join(process.env.UPLOAD_DIR, ...thumbnailpath.split("/"));
      return (await fs.stat(file)).ino;
    }));
    assert.equal(new Set(thumbnailInodes).size, 1, "identical images should share one generated thumbnail across packages");

    const created = await request("/api/projects", {
      method: "POST", cookie: adminCookie,
      body: { name: `Integration ${Date.now()}`, packageIds: [subjectId] },
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.equal(created.payload.project.tasksLocked, true);
    const projectId = created.payload.project._id;

    const generationStarted = performance.now();
    const generation = await request(`/api/projects/${projectId}/tasks/generate`, {
      method: "POST", cookie: adminCookie,
      body: { teamIds: ["integration-team"], allocations: [{ scorer: "integration-scorer", taskCount: 1 }] },
    });
    assert.equal(generation.response.status, 202, JSON.stringify(generation.payload));
    await waitForJob(`/api/projects/${projectId}/tasks/generate/${generation.payload.jobId}`, adminCookie);
    const generationMs = Math.round(performance.now() - generationStarted);

    const hidden = await request("/api/tasks/assigned", { cookie: scorerCookie });
    assert.equal(hidden.response.status, 200, JSON.stringify(hidden.payload));
    assert.equal(hidden.payload.tasks.length, 0);
    const hiddenDashboard = await request("/api/scorer/dashboard", { cookie: scorerCookie });
    assert.equal(hiddenDashboard.response.status, 200, JSON.stringify(hiddenDashboard.payload));
    assert.equal(hiddenDashboard.payload.totalTasks, 0);
    const unlocked = await request(`/api/projects/${projectId}/task-lock`, {
      method: "PATCH", cookie: adminCookie, body: { locked: false },
    });
    assert.equal(unlocked.response.status, 200, JSON.stringify(unlocked.payload));
    assert.equal(unlocked.payload.project.tasksLocked, false);

    const assigned = await request("/api/tasks/assigned", { cookie: scorerCookie });
    assert.equal(assigned.response.status, 200, JSON.stringify(assigned.payload));
    assert.equal(assigned.payload.tasks.length, 1);
    const adminTasks = await request(`/api/projects/${projectId}/tasks?page=1&pageSize=10&includeTotal=true`, { cookie: adminCookie });
    assert.equal(adminTasks.response.status, 200, JSON.stringify(adminTasks.payload));
    assert.equal(adminTasks.payload.tasks[0].items[0].image.filename, "reference.png");
    const visibleDashboard = await request("/api/scorer/dashboard", { cookie: scorerCookie });
    assert.equal(visibleDashboard.response.status, 200, JSON.stringify(visibleDashboard.payload));
    assert.equal(visibleDashboard.payload.totalTasks, 1);
    const task = assigned.payload.tasks[0];
    assert.equal(task.items.length, 3);
    assert.equal(task.items[0].role, "filler");
    const detail = await request(`/api/tasks/${task.id}`, { cookie: scorerCookie });
    assert.equal(detail.response.status, 200, JSON.stringify(detail.payload));
    assert.ok(detail.payload.task.claimToken);
    const released = await request(`/api/tasks/${task.id}/release`, {
      method: "POST", cookie: scorerCookie,
      body: { claimToken: detail.payload.task.claimToken },
    });
    assert.equal(released.response.status, 200, JSON.stringify(released.payload));
    assert.equal(released.payload.released, true);
    const reclaimed = await request(`/api/tasks/${task.id}`, { cookie: scorerCookie });
    assert.equal(reclaimed.response.status, 200, JSON.stringify(reclaimed.payload));
    assert.ok(reclaimed.payload.task.claimToken);
    const ranking = task.items.map((item) => item.image._id);
    const submissionStarted = performance.now();
    const submitted = await request(`/api/tasks/${task.id}/complete`, {
      method: "POST", cookie: scorerCookie,
      body: { ranking, durationMs: 12000, submissionMode: "ranked" },
    });
    assert.equal(submitted.response.status, 200, JSON.stringify(submitted.payload));
    assert.equal(submitted.payload.task.status, "completed");
    const submissionMs = Math.round(performance.now() - submissionStarted);
    const repeatedSubmission = await request(`/api/tasks/${task.id}/complete`, {
      method: "POST", cookie: scorerCookie,
      body: { ranking, durationMs: 12000, submissionMode: "ranked" },
    });
    assert.equal(repeatedSubmission.response.status, 200, JSON.stringify(repeatedSubmission.payload));
    assert.equal(repeatedSubmission.payload.task.status, "completed");
    const completionEvents = await seedPool.query(
      "SELECT COUNT(*)::integer AS count FROM task_stats_events WHERE taskid = $1 AND eventtype = 'task_completed'",
      [task.id],
    );
    assert.equal(completionEvents.rows[0].count, 1);
    const edited = await request(`/api/tasks/${task.id}/complete`, {
      method: "PUT", cookie: scorerCookie,
      body: { ranking: [...ranking].reverse(), durationMs: 15000, submissionMode: "ranked" },
    });
    assert.equal(edited.response.status, 200, JSON.stringify(edited.payload));
    assert.equal(edited.payload.task.status, "completed");
    let settledStats = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const [projectStats, scorerStats, scoringStats] = await Promise.all([
        seedPool.query("SELECT completed FROM project_task_stats WHERE projectid = $1", [projectId]),
        seedPool.query("SELECT completed FROM scorer_task_stats WHERE projectid = $1 AND scorer = $2", [projectId, "integration-scorer"]),
        seedPool.query("SELECT taskcount FROM scorer_scoring_stats WHERE projectid = $1 AND scorer = $2", [projectId, "integration-scorer"]),
      ]);
      const counts = {
        project: Number(projectStats.rows[0]?.completed || 0),
        scorer: Number(scorerStats.rows[0]?.completed || 0),
        scoring: Number(scoringStats.rows[0]?.taskcount || 0),
      };
      if (counts.project === 1 && counts.scorer === 1 && counts.scoring === 1) {
        settledStats = counts;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(settledStats, { project: 1, scorer: 1, scoring: 1 });
    console.log(JSON.stringify({ event: "integration_baseline", overviewMs, generationMs, submissionMs }));

    const exported = await request("/api/admin/tasks/completed/export", { cookie: adminCookie });
    assert.equal(exported.response.status, 200);
    assert.match(exported.response.headers.get("content-disposition"), /attachment/);
    assert.ok(JSON.stringify(exported.payload).includes(task.id));
    const queuedExport = await request("/api/admin/exports", {
      method: "POST", cookie: adminCookie,
      body: { type: "project-completed-tasks", projectIds: [projectId] },
    });
    assert.equal(queuedExport.response.status, 202, JSON.stringify(queuedExport.payload));
    const completedExport = await waitForJob(`/api/admin/exports/${queuedExport.payload.jobId}`, adminCookie);
    assert.equal(completedExport.status, "completed");
    const downloadedExport = await request(completedExport.downloadUrl, { cookie: adminCookie });
    assert.equal(downloadedExport.response.status, 200);
    assert.ok(JSON.stringify(downloadedExport.payload).includes(task.id));
    const report = await request(`/api/projects/${projectId}/tasks/report`, { cookie: adminCookie });
    assert.equal(report.response.status, 200, JSON.stringify(report.payload));
    const reportExport = await request(`/api/projects/${projectId}/tasks/report/export`, { cookie: adminCookie });
    assert.equal(reportExport.response.status, 200);
    assert.match(reportExport.response.headers.get("content-disposition"), /attachment/);
    assert.ok(reportExport.payload.byteLength > 1000);

    const exactProject = await request("/api/projects", {
      method: "POST", cookie: adminCookie,
      body: { name: `Integration exact ${Date.now()}`, packageIds: [subjectId] },
    });
    assert.equal(exactProject.response.status, 201, JSON.stringify(exactProject.payload));
    const exactProjectId = exactProject.payload.project._id;
    const allocationWorkbook = new ExcelJS.Workbook();
    const allocationSheet = allocationWorkbook.addWorksheet("分配");
    allocationSheet.addRow(["打分人", "任务数"]);
    allocationSheet.addRow(["integration-scorer", 1]);
    const allocationForm = new FormData();
    allocationForm.set("file", new Blob([await allocationWorkbook.xlsx.writeBuffer()], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }), "allocations.xlsx");
    const parsedAllocations = await request(`/api/projects/${exactProjectId}/tasks/allocations/import`, {
      method: "POST", cookie: adminCookie, body: allocationForm,
    });
    assert.equal(parsedAllocations.response.status, 200, JSON.stringify(parsedAllocations.payload));
    assert.deepEqual(parsedAllocations.payload.rows.map(({ scorer, taskCount }) => ({ scorer, taskCount })), [
      { scorer: "integration-scorer", taskCount: 1 },
    ]);
    const exactForm = new FormData();
    exactForm.set("teamIds", JSON.stringify(["integration-team"]));
    exactForm.set("file", new Blob([JSON.stringify({ tasks: [
      { sourceTaskId: "integration-task", scorer: "integration-scorer" },
    ] })], { type: "application/json" }), "exact.json");
    const exactGeneration = await request(`/api/projects/${exactProjectId}/tasks/generate/exact`, {
      method: "POST", cookie: adminCookie, body: exactForm,
    });
    assert.equal(exactGeneration.response.status, 202, JSON.stringify(exactGeneration.payload));
    const exactJob = await waitForJob(
      `/api/projects/${exactProjectId}/tasks/generate/${exactGeneration.payload.jobId}`,
      adminCookie,
    );
    assert.equal(exactJob.result?.baseAssignedCount, 1);
    const reassignmentOptions = await request(`/api/projects/${exactProjectId}/tasks/reassignment-options`, { cookie: adminCookie });
    assert.equal(reassignmentOptions.response.status, 200, JSON.stringify(reassignmentOptions.payload));
    const reassigned = await request(`/api/projects/${exactProjectId}/tasks/reassign`, {
      method: "POST", cookie: adminCookie,
      body: {
        source: "selected_scorers",
        sourceScorers: ["integration-scorer"],
        scorers: ["integration-scorer-2"],
        taskCount: 1,
      },
    });
    assert.equal(reassigned.response.status, 200, JSON.stringify(reassigned.payload));
    assert.equal(reassigned.payload.reassignedCount, 1);
    const reassignedTask = await seedPool.query("SELECT scorer FROM rating_tasks WHERE projectid = $1", [exactProjectId]);
    assert.equal(reassignedTask.rows[0].scorer, "integration-scorer-2");

    const rollbackProject = await request("/api/projects", {
      method: "POST", cookie: adminCookie,
      body: { name: `Integration rollback ${Date.now()}`, packageIds: [subjectId] },
    });
    assert.equal(rollbackProject.response.status, 201, JSON.stringify(rollbackProject.payload));
    const rollbackProjectId = rollbackProject.payload.project._id;
    await seedPool.query(`
      CREATE FUNCTION integration_reject_task_item() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'integration task item failure'; END $$
    `);
    await seedPool.query(`
      CREATE TRIGGER integration_reject_task_item BEFORE INSERT ON rating_task_items
      FOR EACH ROW EXECUTE FUNCTION integration_reject_task_item()
    `);
    try {
      const failedGeneration = await request(`/api/projects/${rollbackProjectId}/tasks/generate`, {
        method: "POST", cookie: adminCookie,
        body: { teamIds: ["integration-team"], allocations: [{ scorer: "integration-scorer", taskCount: 1 }] },
      });
      assert.equal(failedGeneration.response.status, 202, JSON.stringify(failedGeneration.payload));
      let failedJob;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const polled = await request(
          `/api/projects/${rollbackProjectId}/tasks/generate/${failedGeneration.payload.jobId}`,
          { cookie: adminCookie },
        );
        assert.equal(polled.response.status, 200, JSON.stringify(polled.payload));
        if (polled.payload.status === "failed") {
          failedJob = polled.payload;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(failedJob?.status, "failed", "failed write should finish the job as failed");
      const rolledBack = await seedPool.query(
        "SELECT COUNT(*)::int AS total FROM rating_tasks WHERE projectid = $1", [rollbackProjectId],
      );
      assert.equal(rolledBack.rows[0].total, 0, "task and item inserts must roll back together");
    } finally {
      await seedPool.query("DROP TRIGGER IF EXISTS integration_reject_task_item ON rating_task_items");
      await seedPool.query("DROP FUNCTION IF EXISTS integration_reject_task_item()");
    }
    const retriedGeneration = await request(`/api/projects/${rollbackProjectId}/tasks/generate`, {
      method: "POST", cookie: adminCookie,
      body: { teamIds: ["integration-team"], allocations: [{ scorer: "integration-scorer", taskCount: 1 }] },
    });
    assert.equal(retriedGeneration.response.status, 202, JSON.stringify(retriedGeneration.payload));
    await waitForJob(`/api/projects/${rollbackProjectId}/tasks/generate/${retriedGeneration.payload.jobId}`, adminCookie);
    const retriedTasks = await seedPool.query(
      "SELECT COUNT(*)::int AS total FROM rating_tasks WHERE projectid = $1", [rollbackProjectId],
    );
    assert.equal(retriedTasks.rows[0].total, 1);

    const secondProject = await request("/api/projects", {
      method: "POST", cookie: adminCookie,
      body: { name: `Integration removable ${Date.now()}`, packageIds: [subjectId] },
    });
    assert.equal(secondProject.response.status, 201, JSON.stringify(secondProject.payload));
    const removableId = secondProject.payload.project._id;
    const renamed = await request(`/api/projects/${removableId}`, {
      method: "PATCH", cookie: adminCookie,
      body: { name: `Integration renamed ${Date.now()}` },
    });
    assert.equal(renamed.response.status, 200, JSON.stringify(renamed.payload));
    assert.match(renamed.payload.project.name, /^Integration renamed/);
    const deleted = await request(`/api/projects/${removableId}`, {
      method: "DELETE", cookie: adminCookie,
    });
    assert.equal(deleted.response.status, 200, JSON.stringify(deleted.payload));
    assert.equal(deleted.payload.deleted, true);

    if (process.env.INTEGRATION_BULK === "1") {
      const bulkZip = new AdmZip();
      bulkZip.addFile("shared/reference.png", image);
      bulkZip.addFile("shared/other.png", image);
      const bulkTasks = [];
      for (let index = 0; index < 1000; index += 1) {
        const name = `variants/${String(index).padStart(4, "0")}.png`;
        bulkZip.addFile(name, image);
        bulkTasks.push({
          id: `bulk-${index}`,
          criterion: "ss_infographic_v2",
          images: [
            { src_rel_path: "shared/reference.png", role: "filler" },
            "shared/other.png",
            name,
          ],
        });
      }
      bulkZip.addFile("tasks.json", Buffer.from(JSON.stringify({ version: 1, tasks: bulkTasks })));
      const bulkForm = new FormData();
      bulkForm.set("file", new Blob([bulkZip.toBuffer()], { type: "application/zip" }), "integration-bulk.zip");
      const bulkImported = await request("/api/import", { method: "POST", cookie: adminCookie, body: bulkForm });
      assert.equal(bulkImported.response.status, 201, JSON.stringify(bulkImported.payload));
      assert.equal(bulkImported.payload.imported, 1002);
      const bulkSubjectId = bulkImported.payload.subject._id;

      for (const taskCount of [100, 500, 1000]) {
        const bulkProject = await request("/api/projects", {
          method: "POST", cookie: adminCookie,
          body: { name: `Integration bulk ${taskCount}`, packageIds: [bulkSubjectId] },
        });
        assert.equal(bulkProject.response.status, 201, JSON.stringify(bulkProject.payload));
        const bulkProjectId = bulkProject.payload.project._id;
        if (taskCount === 1000) {
          const overCapacity = await request(`/api/projects/${bulkProjectId}/tasks/generate`, {
            method: "POST", cookie: adminCookie,
            body: { teamIds: ["integration-team"], allocations: [{ scorer: "integration-scorer", taskCount: 1001 }] },
          });
          assert.equal(overCapacity.response.status, 400, JSON.stringify(overCapacity.payload));
          const untouched = await seedPool.query("SELECT COUNT(*)::int AS total FROM rating_tasks WHERE projectid = $1", [bulkProjectId]);
          assert.equal(untouched.rows[0].total, 0);
        }
        const startedAt = performance.now();
        const generated = await request(`/api/projects/${bulkProjectId}/tasks/generate`, {
          method: "POST", cookie: adminCookie,
          body: { teamIds: ["integration-team"], allocations: [{ scorer: "integration-scorer", taskCount }] },
        });
        assert.equal(generated.response.status, 202, JSON.stringify(generated.payload));
        const completed = await waitForJob(
          `/api/projects/${bulkProjectId}/tasks/generate/${generated.payload.jobId}`,
          adminCookie,
          400,
        );
        assert.equal(completed.result?.baseAssignedCount, taskCount);
        const databaseCount = await seedPool.query(`
          SELECT COUNT(*)::int AS total FROM rating_tasks
          WHERE projectid = $1 AND status = 'assigned' AND scorer = 'integration-scorer'
        `, [bulkProjectId]);
        assert.equal(databaseCount.rows[0].total, taskCount);
        console.log(JSON.stringify({
          event: "integration_bulk_generation",
          taskCount,
          totalMs: Math.round(performance.now() - startedAt),
        }));
      }
    }
  } finally {
    if (secondaryThumbnailWorker && secondaryThumbnailWorker.exitCode === null) {
      secondaryThumbnailWorker.kill("SIGTERM");
      await new Promise((resolve) => secondaryThumbnailWorker.once("exit", resolve));
    }
    if (thumbnailWorker && thumbnailWorker.exitCode === null) {
      thumbnailWorker.kill("SIGTERM");
      await new Promise((resolve) => thumbnailWorker.once("exit", resolve));
    }
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([appPool.end(), seedPool.end()]);
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});
