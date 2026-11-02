import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import pg from "pg";

const [sourceZipPath, outputPath] = process.argv.slice(2);
if (!sourceZipPath || !outputPath) {
  throw new Error("Usage: node map_selected_export_images.mjs <source.zip> <output.json>");
}

const criteria = new Set([
  "overall", "creativity", "mood", "composition", "color", "lighting",
  "realism", "detail", "promptAlignment", "textCorrectness",
  "anatomyNormality", "informationClarity", "designQuality", "typography",
]);

function clean(value) {
  return String(value ?? "").replace(/\\/g, "/").trim();
}

function taskReference(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return value.src_rel_path ?? value.originalPath ?? value.path ?? value.filename ?? value.image ?? "";
  }
  return "";
}

function filename(value) {
  return path.posix.basename(clean(value)).toLowerCase();
}

function destinationFor(row) {
  const ext = path.posix.extname(row.filename || row.originalpath || ".jpg").toLowerCase() || ".jpg";
  return `images/${row.id}${ext}`;
}

const zip = new AdmZip(sourceZipPath);
const taskEntry = zip.getEntries().find((entry) => !entry.isDirectory && entry.entryName.replace(/\\/g, "/").endsWith("/tasks.json"));
if (!taskEntry) throw new Error("Source ZIP does not contain tasks.json");

const taskDocument = JSON.parse(taskEntry.getData().toString("utf8"));
if (!Array.isArray(taskDocument.tasks)) throw new Error("Source tasks.json does not contain a tasks array");

const refs = new Set();
for (const task of taskDocument.tasks) {
  for (const item of task?.images || []) {
    const name = filename(taskReference(item));
    if (name) refs.add(name);
  }
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const result = await client.query(
    `SELECT id, filename, originalpath, storagepath, catalogdata
     FROM images
     WHERE lower(filename) = ANY($1::text[])
     ORDER BY createdat DESC`,
    [[...refs]],
  );

  const matches = new Map();
  for (const row of result.rows) {
    const key = String(row.filename).toLowerCase();
    if (!matches.has(key)) matches.set(key, row);
  }

  const usedRows = new Map();
  const taskIds = new Set();
  const taskGroups = new Set();
  const normalizedTasks = [];
  const failures = [];
  let duplicateImageRefsRemoved = 0;
  let duplicateTaskGroupsRemoved = 0;

  for (let index = 0; index < taskDocument.tasks.length; index += 1) {
    const rawTask = taskDocument.tasks[index];
    const id = String(rawTask?.id ?? "").trim();
    const criterion = String(rawTask?.criterion ?? "").trim();
    if (!id || id.length > 160 || taskIds.has(id)) {
      failures.push({ index, id, reason: "invalid or duplicate id" });
      continue;
    }
    taskIds.add(id);
    if (!criteria.has(criterion)) {
      failures.push({ index, id, reason: `unsupported criterion ${criterion}` });
      continue;
    }
    if (!Array.isArray(rawTask?.images) || rawTask.images.length < 1 || rawTask.images.length > 5) {
      failures.push({ index, id, reason: "images must contain 1 to 5 values" });
      continue;
    }

    const seen = new Set();
    const images = [];
    let missing = null;
    for (const rawItem of rawTask.images) {
      const source = clean(taskReference(rawItem));
      const key = filename(source);
      const row = matches.get(key);
      if (!row) {
        missing = source || "empty image reference";
        break;
      }
      if (seen.has(row.id)) {
        duplicateImageRefsRemoved += 1;
        continue;
      }
      seen.add(row.id);
      usedRows.set(row.id, { ...row, source });
      images.push({ src_rel_path: destinationFor(row) });
    }
    if (missing) {
      failures.push({ index, id, reason: `not found in rating_v24: ${missing}` });
      continue;
    }
    if (!images.length) {
      failures.push({ index, id, reason: "no images remain after duplicate removal" });
      continue;
    }

    const groupKey = `${criterion}|${images.map((image) => image.src_rel_path).sort().join("|")}`;
    if (taskGroups.has(groupKey)) {
      duplicateTaskGroupsRemoved += 1;
      continue;
    }
    taskGroups.add(groupKey);
    normalizedTasks.push({ id, criterion, images });
  }

  const rows = [...usedRows.values()].map((row) => {
    let catalogRow = null;
    try { catalogRow = row.catalogdata ? JSON.parse(row.catalogdata) : null; } catch {}
    const destination = destinationFor(row);
    return {
      src_abs_path: row.source,
      src_rel_path: destination,
      dest_rel_path: destination,
      image_filename: path.posix.basename(destination),
      image_path: destination,
      source_original_path: row.originalpath,
      source_storage_path: row.storagepath,
      ...(catalogRow ? { catalog_row: catalogRow } : {}),
    };
  });

  const payload = {
    version: 1,
    source_zip: sourceZipPath,
    source_task_count: taskDocument.tasks.length,
    unique_source_references: refs.size,
    database_matches: matches.size,
    normalized_task_count: normalizedTasks.length,
    image_count: rows.length,
    duplicate_image_refs_removed: duplicateImageRefsRemoved,
    duplicate_task_groups_removed: duplicateTaskGroupsRemoved,
    failures,
    tasks: normalizedTasks,
    rows,
  };
  await fs.writeFile(outputPath, JSON.stringify(payload), "utf8");
  console.log(JSON.stringify({
    source_task_count: payload.source_task_count,
    unique_source_references: payload.unique_source_references,
    database_matches: payload.database_matches,
    normalized_task_count: payload.normalized_task_count,
    image_count: payload.image_count,
    duplicate_image_refs_removed: payload.duplicate_image_refs_removed,
    duplicate_task_groups_removed: payload.duplicate_task_groups_removed,
    failed_task_count: failures.length,
    failure_samples: failures.slice(0, 10),
  }, null, 2));
} finally {
  await client.end();
}
