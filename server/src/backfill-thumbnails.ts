import fs from "node:fs/promises";
import path from "node:path";
import { db } from "./postgres.ts";
import {
  createThumbnail,
  thumbnailStoragePath,
  uploadFilePath,
} from "./image-assets.ts";

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = Number.parseInt(limitArgument?.slice("--limit=".length) || "0", 10);
const rows = await db
  .prepare(
    `SELECT id, storagePath
     FROM images
     WHERE thumbnailPath IS NULL OR TRIM(thumbnailPath) = ''
     ORDER BY createdAt ASC${Number.isInteger(limit) && limit > 0 ? " LIMIT ?" : ""}`,
  )
  .all(...(Number.isInteger(limit) && limit > 0 ? [limit] : [])) as Array<{
    id: string;
    storagePath: string;
  }>;
const updateThumbnailPathStmt = db.prepare(
  "UPDATE images SET thumbnailPath = ? WHERE id = ?",
);

let generated = 0;
let reused = 0;
let failed = 0;

for (const [index, row] of rows.entries()) {
  const thumbnailPath = thumbnailStoragePath(row.storagePath);
  const originalPath = uploadFilePath(uploadDir, row.storagePath);
  const targetPath = uploadFilePath(uploadDir, thumbnailPath);

  try {
    try {
      await fs.access(targetPath);
      reused += 1;
    } catch {
      await createThumbnail(originalPath, targetPath);
      generated += 1;
    }
    await updateThumbnailPathStmt.run(thumbnailPath, row.id);
  } catch (error) {
    failed += 1;
    console.error(`缩略图生成失败 [${row.id}]`, error instanceof Error ? error.message : error);
  }

  if ((index + 1) % 25 === 0 || index + 1 === rows.length) {
    console.log(`已处理 ${index + 1}/${rows.length}`);
  }
}

console.log(
  JSON.stringify({ total: rows.length, generated, reused, failed }, null, 2),
);
