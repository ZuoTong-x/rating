import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";

const { Pool } = pg;

const scorer = process.argv[2] || "test";
const criterion = process.argv[3] || "overall";
const supportedCriteria = new Set(["overall", "ss_infographic_v2"]);
if (!supportedCriteria.has(criterion)) {
  throw new Error(`测试样例仅支持 overall 或 ss_infographic_v2，当前为：${criterion}`);
}
const demoKey = criterion === "overall" ? "reference" : criterion.replaceAll("_", "-");
const demoTitle = criterion === "overall" ? "参考图展示测试" : "高密度信息图规则测试";
const subjectId = `local-${demoKey}-demo-subject`;
const projectId = `local-${demoKey}-demo-project`;
const taskId = `local-${demoKey}-demo-task`;
const importBatch = `local-${demoKey}-demo-batch`;
const taskVersion = "v3";
const storageDirectory = `local-${demoKey}-demo`;
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
const outputDirectory = path.join(uploadDir, storageDirectory);

const databaseUrl = process.env.DATABASE_URL || (
  process.env.POSTGRES_DB && process.env.POSTGRES_USER && process.env.POSTGRES_PASSWORD
    ? `postgresql://${encodeURIComponent(process.env.POSTGRES_USER)}:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${process.env.POSTGRES_HOST || "127.0.0.1"}:${process.env.POSTGRES_PORT || "5432"}/${encodeURIComponent(process.env.POSTGRES_DB)}`
    : null
);

if (!databaseUrl) {
  throw new Error("缺少本地 PostgreSQL 配置，请先配置 DATABASE_URL 或 POSTGRES_* 环境变量");
}

const samples = [
  { id: `${subjectId}-image-reference`, label: "REFERENCE", subtitle: "Default first, draggable", colors: ["#fff7ed", "#fb923c"], role: "filler" },
  { id: `${subjectId}-image-a`, label: "TARGET A", subtitle: "Warm portrait", colors: ["#fef2f2", "#ef4444"], role: "target" },
  { id: `${subjectId}-image-b`, label: "TARGET B", subtitle: "Cool landscape", colors: ["#eff6ff", "#3b82f6"], role: "target" },
];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function createSampleImages() {
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const [index, sample] of samples.entries()) {
    const filename = `${index + 1}-${sample.role === "filler" ? "reference" : `target-${index}`}.png`;
    const targetPath = path.join(outputDirectory, filename);
    const svg = `
      <svg width="1200" height="900" viewBox="0 0 1200 900" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="${sample.colors[0]}"/>
            <stop offset="1" stop-color="${sample.colors[1]}"/>
          </linearGradient>
        </defs>
        <rect width="1200" height="900" fill="url(#background)"/>
        <rect x="90" y="90" width="1020" height="720" rx="48" fill="#ffffff" fill-opacity="0.88"/>
        <circle cx="600" cy="330" r="120" fill="${sample.colors[1]}" fill-opacity="0.22"/>
        <circle cx="600" cy="330" r="72" fill="${sample.colors[1]}"/>
        <text x="600" y="560" text-anchor="middle" font-family="Arial, sans-serif" font-size="76" font-weight="700" fill="#111827">${escapeXml(sample.label)}</text>
        <text x="600" y="640" text-anchor="middle" font-family="Arial, sans-serif" font-size="38" fill="#4b5563">${escapeXml(sample.subtitle)}</text>
        <text x="600" y="735" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" fill="#6b7280">Local rating dialog preview</text>
      </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(targetPath);
    sample.filename = filename;
    sample.storagePath = `${storageDirectory}/${filename}`;
  }
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await createSampleImages();
  await client.query("BEGIN");

  const userResult = await client.query(
    "SELECT username FROM users WHERE username = $1 AND role = 'scorer' AND status = 'enabled'",
    [scorer],
  );
  if (!userResult.rowCount) {
    throw new Error(`本地不存在可用的打分账号：${scorer}`);
  }

  const now = new Date().toISOString();
  await client.query("DELETE FROM rating_tasks WHERE id = $1", [taskId]);

  await client.query(
    `INSERT INTO subjects (
       id, name, originalfilename, importbatch, storageroot, sourcezippath,
       imagecount, categorycount, status, taskstatus, createdat, updatedat
     ) VALUES ($1, $2, $3, $4, $5, NULL, $6, 1, 'imported', 'scoring', $7, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       imagecount = EXCLUDED.imagecount,
       categorycount = EXCLUDED.categorycount,
       status = 'imported',
       taskstatus = 'scoring',
       updatedat = EXCLUDED.updatedat`,
    [subjectId, `${demoTitle}图包`, `${storageDirectory}.zip`, importBatch, outputDirectory, samples.length, now],
  );

  await client.query("DELETE FROM images WHERE subjectid = $1", [subjectId]);
  for (const sample of samples) {
    await client.query(
      `INSERT INTO images (
         id, subjectid, filename, originalpath, storagepath, thumbnailpath,
         mimetype, category, directory, isinfographic, prompt, catalogdata,
         importbatch, createdat, updatedat
       ) VALUES ($1, $2, $3, $4, $5, $5, 'image/png', '参考图交互测试', '', 0, $6, NULL, $7, $8, $8)`,
      [
        sample.id,
        subjectId,
        sample.filename,
        sample.filename,
        sample.storagePath,
        sample.role === "filler" ? "这是一张参考图，可拖动并参与排序。" : "这是一张普通待排序图片。",
        importBatch,
        now,
      ],
    );
  }

  await client.query(
    `INSERT INTO projects (
       id, name, icon, packageid, taskstatus, taskslocked, createdat, updatedat
     ) VALUES ($1, $2, 'images', $3, 'scoring', false, $4, $4)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       packageid = EXCLUDED.packageid,
       taskstatus = 'scoring',
       taskslocked = false,
       deletionrequestedat = NULL,
       updatedat = EXCLUDED.updatedat`,
    [projectId, demoTitle, subjectId, now],
  );

  await client.query(
    `INSERT INTO project_packages (projectid, packageid, createdat)
     VALUES ($1, $2, $3)
     ON CONFLICT (projectid, packageid) DO NOTHING`,
    [projectId, subjectId, now],
  );

  await client.query(
    `INSERT INTO rating_tasks (
       id, subjectid, projectid, taskversion, round, tasktype, status, scorer,
       ranking, assignmentkey, imagekey, createdat, updatedat
     ) VALUES ($1, $2, $3, $4, 1, $5, 'assigned', $6, NULL, $7, $8, $9, $9)`,
    [taskId, subjectId, projectId, taskVersion, `dimension:${criterion}`, scorer, crypto.randomInt(1, 2147483647), `${storageDirectory}-task`, now],
  );

  for (const [position, sample] of samples.entries()) {
    await client.query(
      `INSERT INTO rating_task_items (taskid, imageid, position, role)
       VALUES ($1, $2, $3, $4)`,
      [taskId, sample.id, position, sample.role],
    );
  }

  await client.query(
    `INSERT INTO project_task_stats (
       projectid, taskversion, total, pending, assigned, completed, basetotal, basepending, updatedat
     ) VALUES ($1, $2, 1, 0, 1, 0, 1, 0, $3)
     ON CONFLICT (projectid, taskversion) DO UPDATE SET
       total = 1, pending = 0, assigned = 1, completed = 0,
       basetotal = 1, basepending = 0, updatedat = EXCLUDED.updatedat`,
    [projectId, taskVersion, now],
  );

  await client.query(
    `INSERT INTO scorer_task_stats (scorer, taskversion, projectid, assigned, completed, updatedat)
     VALUES ($1, $2, $3, 1, 0, $4)
     ON CONFLICT (scorer, taskversion, projectid) DO UPDATE SET
       assigned = 1, completed = 0, updatedat = EXCLUDED.updatedat`,
    [scorer, taskVersion, projectId, now],
  );

  await client.query("COMMIT");
  console.log(JSON.stringify({ scorer, projectId, taskId, imageCount: samples.length }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
