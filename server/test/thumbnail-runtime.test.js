import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout, isDatabaseIntegrityError } from "../src/thumbnail-runtime.js";

test("缩略图任务在超时前完成时返回原结果", async () => {
  assert.equal(await withTimeout(Promise.resolve("ready"), 50, "timeout"), "ready");
});

test("缩略图任务卡住时按时释放任务槽", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, "缩略图处理超时"),
    /缩略图处理超时/,
  );
});

test("数据库物理错误暂停队列，普通生成错误仍按任务重试", () => {
  assert.equal(isDatabaseIntegrityError({ code: "XX002", message: "index contains unexpected zero page" }), true);
  assert.equal(isDatabaseIntegrityError({ code: "XX000", message: "unexpected data beyond EOF" }), true);
  assert.equal(isDatabaseIntegrityError({ message: "unexpected data beyond EOF in block 2" }), true);
  assert.equal(isDatabaseIntegrityError({ code: "23505", message: "duplicate key" }), false);
  assert.equal(isDatabaseIntegrityError(new Error("无法解码图片")), false);
});
