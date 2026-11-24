import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

type CacheOptions = {
  sourcePath: string;
  targetPath: string;
  cacheRoot: string;
  variant: string;
  timeoutMs: number;
  createThumbnail: (sourcePath: string, targetPath: string) => Promise<void>;
  isReady: (path: string) => Promise<boolean>;
};

const sleep = (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs));

async function contentKey(sourcePath: string, variant: string) {
  const hash = crypto.createHash("sha256");
  hash.update(variant);
  hash.update("\0");
  for await (const chunk of createReadStream(sourcePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function linkOrCopy(cachePath: string, targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  try {
    try {
      await fs.link(cachePath, temporaryPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "EOPNOTSUPP") throw error;
      await fs.copyFile(cachePath, temporaryPath);
    }
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function tryLinkOrCopy(cachePath: string, targetPath: string) {
  try {
    await linkOrCopy(cachePath, targetPath);
    return true;
  } catch (error) {
    // A cache entry may disappear between validation and linking when pruning
    // an unreferenced old file. Regenerate it under the per-key lock.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function materializeCachedThumbnail({
  sourcePath, targetPath, cacheRoot, variant, timeoutMs, createThumbnail, isReady,
}: CacheOptions) {
  const key = await contentKey(sourcePath, variant);
  const cacheDir = path.join(cacheRoot, key.slice(0, 2));
  const cachePath = path.join(cacheDir, `${key}.webp`);
  const lockPath = `${cachePath}.lock`;
  await fs.mkdir(cacheDir, { recursive: true });

  if (await isReady(cachePath) && await tryLinkOrCopy(cachePath, targetPath)) {
    return { reused: true, key };
  }

  const deadline = Date.now() + Math.max(1000, timeoutMs - 10000);
  const staleLockMs = Math.max(10 * 60_000, timeoutMs * 2);
  while (true) {
    let lock: fs.FileHandle;
    try {
      lock = await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isReady(cachePath) && await tryLinkOrCopy(cachePath, targetPath)) {
        return { reused: true, key };
      }
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleLockMs) await fs.unlink(lockPath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) throw new Error("等待相同图片的缩略图生成超时");
      await sleep(200);
      continue;
    }

    let reused = false;
    try {
      if (await isReady(cachePath)) {
        reused = true;
      } else {
        await createThumbnail(sourcePath, cachePath);
        if (!await isReady(cachePath)) throw new Error("缩略图缓存生成后校验失败");
      }
    } finally {
      await lock.close();
      await fs.unlink(lockPath).catch(() => {});
    }
    await linkOrCopy(cachePath, targetPath);
    return { reused, key };
  }
}

export async function pruneThumbnailCacheShard(cacheRoot: string, shard: number, olderThanMs: number) {
  if (!Number.isInteger(shard) || shard < 0 || shard > 255) throw new RangeError("Invalid thumbnail cache shard");
  const directory = path.join(cacheRoot, shard.toString(16).padStart(2, "0"));
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { scanned: 0, removed: 0 };
    throw error;
  }
  let scanned = 0;
  let removed = 0;
  const cutoff = Date.now() - olderThanMs;
  for (const name of entries) {
    if (!/^[a-f0-9]{64}\.webp$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const stat = await fs.stat(file);
      scanned += 1;
      if (stat.isFile() && stat.nlink === 1 && stat.mtimeMs < cutoff) {
        await fs.unlink(file);
        removed += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { scanned, removed };
}
