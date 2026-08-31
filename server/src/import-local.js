import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { importZipArchive } from "./app.js";
import { runWithDatabaseContext } from "./postgres.js";

function usage() {
  console.error("用法: node src/import-local.js <容器内 ZIP 路径> [--keep]");
  console.error("示例: node src/import-local.js /app/inbox/example.zip");
}

async function moveFile(sourcePath, targetPath) {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await fs.copyFile(sourcePath, targetPath);
    await fs.unlink(sourcePath);
  }
}

async function uniquePath(directory, filename) {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = path.join(directory, filename);
  let suffix = 1;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(directory, `${stem}-${suffix}${extension}`);
      suffix += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
  }
}

async function main() {
  const [inputArg, ...options] = process.argv.slice(2);
  if (!inputArg || options.some((option) => option !== "--keep")) {
    usage();
    process.exitCode = 2;
    return;
  }

  const zipPath = path.resolve(inputArg);
  const originalFilename = path.basename(zipPath);
  if (path.extname(originalFilename).toLowerCase() !== ".zip") {
    throw new Error("只支持 .zip 文件");
  }

  const stat = await fs.stat(zipPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("ZIP 文件不存在或为空");
  }

  const result = await runWithDatabaseContext(() =>
    importZipArchive(zipPath, originalFilename, {
      removeSource: false,
      onProgress: ({ current, total }) => {
        const progress = total ? Math.round((current / total) * 100) : 0;
        process.stderr.write(`导入进度: ${progress}% (${current}/${total})\r`);
      },
    }),
  );
  process.stderr.write("\n");

  if (!options.includes("--keep")) {
    const archiveDir = path.resolve(
      process.env.IMPORT_ARCHIVE_DIR || path.join(path.dirname(zipPath), "processed"),
    );
    await fs.mkdir(archiveDir, { recursive: true });
    const archivedPath = await uniquePath(archiveDir, originalFilename);
    await moveFile(zipPath, archivedPath);
    result.archivedPath = archivedPath;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
