import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../src/thumbnail-runtime.js";

test("缩略图任务在超时前完成时返回原结果", async () => {
  assert.equal(await withTimeout(Promise.resolve("ready"), 50, "timeout"), "ready");
});

test("缩略图任务卡住时按时释放任务槽", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, "缩略图处理超时"),
    /缩略图处理超时/,
  );
});
