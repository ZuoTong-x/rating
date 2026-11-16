import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

process.env.TASK_GENERATION_WORKER = "1";
process.env.PG_STATEMENT_TIMEOUT_MS ||= "120000";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "../src");
const outputDir = path.resolve(process.env.UPLOAD_DIR || "uploads", "_exports");
const cutoff = process.env.EXPORT_COMPLETED_TO || new Date().toISOString();
const stamp = cutoff.replace(/[:.]/g, "-");
const outputPath = path.join(outputDir, `V4_ALL_COMPLETED_${stamp}.json.gz`);
const partialPath = `${outputPath}.partial`;
const token = crypto.randomUUID();
const tempAppPath = path.join(appDir, `.all-completed-export-${token}.mjs`);
const tempServicePath = path.join(
  appDir,
  "services",
  `.all-completed-export-${token}.js`,
);

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

let pool;
try {
  await fs.mkdir(outputDir, { recursive: true });
  const serviceSource = await fs.readFile(
    path.join(appDir, "services", "admin-dashboard.js"),
    "utf8",
  );
  const patchedService = serviceSource
    .replace(
      "const filters = { projectIds };",
      "const filters = { projectIds, ...parseCompletedTaskDateRange(query) };",
    )
    .replace("filters: { projectIds },", "filters,")
    .replace("const batchSize = 1000;", "const batchSize = 5000;")
    .replace(
      [
        "      for (const task of tasks) {",
        "        await writeResponseChunk(",
        "          stream,",
        '          `${written ? "," : ""}${JSON.stringify(task)}`,' ,
        "        );",
        "        written += 1;",
        "      }",
      ].join("\n"),
      [
        "      await writeResponseChunk(",
        "        stream,",
        '        `${written ? "," : ""}${tasks.map((task) => JSON.stringify(task)).join(",")}`,' ,
        "      );",
        "      written += tasks.length;",
      ].join("\n"),
    );
  if (
    patchedService === serviceSource ||
    !patchedService.includes("parseCompletedTaskDateRange(query)") ||
    !patchedService.includes("const batchSize = 5000") ||
    !patchedService.includes("written += tasks.length")
  ) {
    throw new Error("Unable to apply completed-time snapshot filter");
  }
  await fs.writeFile(tempServicePath, patchedService, { flag: "wx" });

  const serviceImport = `./services/${path.basename(tempServicePath)}`;
  const appSource = await fs.readFile(path.join(appDir, "app.js"), "utf8");
  const patchedApp = appSource.replace(
    'from "./services/admin-dashboard.js";',
    `from "${serviceImport}";`,
  );
  if (patchedApp === appSource) throw new Error("Unable to patch dashboard service import");
  await fs.writeFile(
    tempAppPath,
    `${patchedApp}\nexport { writeProjectCompletedTasksExport };\n`,
    { flag: "wx" },
  );

  const [{ db, pool: databasePool }, appModule] = await Promise.all([
    import(pathToFileURL(path.join(appDir, "postgres.js"))),
    import(pathToFileURL(tempAppPath)),
  ]);
  pool = databasePool;
  const anchor = await db
    .prepare("SELECT createdAt FROM projects WHERE name = ? AND deletionRequestedAt IS NULL")
    .get("V4_IMAGES_01");
  if (!anchor) throw new Error("V4_IMAGES_01 not found");
  const projects = await db
    .prepare(
      `SELECT id, name, createdAt
       FROM projects
       WHERE createdAt >= ?::timestamptz
         AND deletionRequestedAt IS NULL
       ORDER BY createdAt, id`,
    )
    .all(anchor.createdAt);
  const projectIds = projects.map((project) => project.id);
  if (!projectIds.length || projectIds.length > 100) {
    throw new Error(`Unexpected project count: ${projectIds.length}`);
  }

  let uncompressedBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      uncompressedBytes += chunk.length;
      callback(null, chunk);
    },
  });
  const gzip = createGzip({ level: 6 });
  const file = createWriteStream(partialPath, { flags: "wx" });
  const pipePromise = pipeline(counter, gzip, file);
  let lastProgress = -1;
  const result = await appModule.writeProjectCompletedTasksExport(
    counter,
    { projectIds, completedTo: cutoff },
    (progress) => {
      if (progress.progress === lastProgress) return;
      lastProgress = progress.progress;
      process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...progress })}\n`);
    },
  );
  await pipePromise;
  await fs.rename(partialPath, outputPath);
  const stat = await fs.stat(outputPath);
  const sha256 = await sha256File(outputPath);
  process.stdout.write(`${JSON.stringify({
    event: "completed",
    cutoff,
    outputPath,
    projectScopeCount: projects.length,
    exportedProjectCount: result.projectCount,
    taskCount: result.taskCount,
    uncompressedBytes,
    compressedBytes: stat.size,
    sha256,
  })}\n`);
} catch (error) {
  await fs.unlink(partialPath).catch(() => {});
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
} finally {
  await Promise.all([
    fs.unlink(tempAppPath).catch(() => {}),
    fs.unlink(tempServicePath).catch(() => {}),
  ]);
  await pool?.end().catch(() => {});
}

