import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const thumbnailMaxSize = Math.max(
  40,
  Number.parseInt(process.env.IMAGE_THUMBNAIL_SIZE || "600", 10) || 600,
);
const thumbnailQuality = Math.min(
  90,
  Math.max(
    50,
    Number.parseInt(process.env.IMAGE_THUMBNAIL_QUALITY || "60", 10) || 60,
  ),
);
const thumbnailEffort = Math.min(
  6,
  Math.max(0, Number.parseInt(process.env.IMAGE_THUMBNAIL_EFFORT || "0", 10) || 0),
);

function normalizedStoragePath(storagePath) {
  return String(storagePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

export function thumbnailStoragePath(storagePath) {
  const normalized = normalizedStoragePath(storagePath);
  const parsed = path.posix.parse(normalized);
  if (!parsed.dir || !parsed.name) {
    throw new Error("图片存储路径不正确，无法生成缩略图");
  }
  return path.posix.join(parsed.dir, "_thumbnails", `${parsed.name}.webp`);
}

export function uploadFilePath(uploadDir, storagePath) {
  return path.join(uploadDir, ...normalizedStoragePath(storagePath).split("/"));
}

export async function createThumbnail(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await sharp(sourcePath, { animated: false })
      .rotate()
      .resize({
        width: thumbnailMaxSize,
        height: thumbnailMaxSize,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: thumbnailQuality, effort: thumbnailEffort })
      .toFile(temporaryPath);
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}
