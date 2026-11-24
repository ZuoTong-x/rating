import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeCachedThumbnail, pruneThumbnailCacheShard } from "../src/thumbnail-cache.ts";

test("相同图片的并发缩略图任务只转换一次并共享文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rating-thumbnail-cache-"));
  try {
    const sourcePath = path.join(root, "source.png");
    const targetA = path.join(root, "package-a", "thumbnail.webp");
    const targetB = path.join(root, "package-b", "thumbnail.webp");
    await fs.writeFile(sourcePath, "same-image-bytes");
    let conversions = 0;
    const options = {
      sourcePath,
      cacheRoot: path.join(root, "cache"),
      variant: "test-webp-v1",
      timeoutMs: 30_000,
      createThumbnail: async (_source, target) => {
        conversions += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await fs.writeFile(target, "webp-content");
      },
      isReady: async (candidate) => {
        try { return (await fs.stat(candidate)).size > 0; }
        catch { return false; }
      },
    };
    const [first, second] = await Promise.all([
      materializeCachedThumbnail({ ...options, targetPath: targetA }),
      materializeCachedThumbnail({ ...options, targetPath: targetB }),
    ]);
    assert.equal(conversions, 1);
    assert.equal(first.key, second.key);
    assert.equal((await fs.readFile(targetA)).toString(), "webp-content");
    assert.equal((await fs.readFile(targetB)).toString(), "webp-content");
    assert.equal((await fs.stat(targetA)).ino, (await fs.stat(targetB)).ino);

    await materializeCachedThumbnail({ ...options, targetPath: path.join(root, "package-c", "thumbnail.webp"), variant: "test-webp-v2" });
    assert.equal(conversions, 2, "输出参数变化后必须重新生成");

    const cacheFile = path.join(options.cacheRoot, first.key.slice(0, 2), `${first.key}.webp`);
    const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60_000);
    await fs.utimes(cacheFile, oldDate, oldDate);
    const shard = Number.parseInt(first.key.slice(0, 2), 16);
    await pruneThumbnailCacheShard(options.cacheRoot, shard, 14 * 24 * 60 * 60_000);
    assert.equal((await fs.stat(cacheFile)).nlink, 3, "有图包仍引用的缓存应保留");
    await fs.unlink(targetA);
    await fs.unlink(targetB);
    await pruneThumbnailCacheShard(options.cacheRoot, shard, 14 * 24 * 60 * 60_000);
    await assert.rejects(fs.stat(cacheFile), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
