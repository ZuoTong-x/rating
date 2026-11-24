import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createOperationalLogger,
  describeApi,
  readOperationalLogs,
  requestLogMetadata,
} from "../src/operational-logger.ts";

test("API 日志会补充接口说明并归一化资源 ID", () => {
  const metadata = requestLogMetadata({
    method: "GET",
    originalUrl: "/api/projects/31614151-f35c-46e6-b9b2-b179303462f7?full=1",
    params: { id: "31614151-f35c-46e6-b9b2-b179303462f7" },
    headers: {},
  });
  assert.equal(metadata.path, "/api/projects/:id");
  assert.equal(metadata.description, "读取项目及任务统计");
  assert.equal(describeApi("GET", "/api/admin/logs"), "查询线上结构化错误日志");
});

test("结构化日志保留 PostgreSQL 元数据并脱敏敏感字段", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rating-operational-logs-"));
  try {
    const logger = createOperationalLogger({ source: "api", logDir: directory });
    const error = Object.assign(new Error("index contains unexpected zero page"), {
      code: "XX002",
      detail: "block 205259",
      table: "rating_tasks",
    });
    logger.write({
      level: "error",
      kind: "api-error",
      message: error.message,
      code: error.code,
      status: 500,
      api: { method: "POST", path: "/api/tasks/:id", description: "领取、提交或调整评分任务" },
      metadata: { password: "must-not-leak", taskId: "task-1" },
      error,
    });
    await logger.flush();
    const result = await readOperationalLogs({ logDir: directory });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].code, "XX002");
    assert.equal(result.entries[0].error.detail, "block 205259");
    assert.equal(result.entries[0].metadata.password, "[已脱敏]");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("日志时间范围按开始时间包含、结束时间不包含筛选", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rating-operational-range-"));
  try {
    const filename = path.join(directory, "operational-api-2026-11-16.jsonl");
    await fs.writeFile(filename, [
      { id: "before", timestamp: "2026-11-16T00:00:00.000Z", source: "api", level: "error" },
      { id: "inside", timestamp: "2026-11-16T08:00:00.000Z", source: "api", level: "error" },
      { id: "after", timestamp: "2026-11-16T16:00:00.000Z", source: "api", level: "warning" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const result = await readOperationalLogs({
      logDir: directory,
      startTime: "2026-11-16T08:00:00.000Z",
      endTime: "2026-11-16T16:00:00.000Z",
    });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].id, "inside");
    assert.equal(result.summary.byLevel.error, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("查询历史时间范围时不会被较新的日志占用读取额度", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rating-operational-history-"));
  try {
    await fs.writeFile(path.join(directory, "operational-api-2026-11-01.jsonl"),
      `${JSON.stringify({ id: "history", timestamp: "2026-11-01T10:00:00.000Z", source: "api", level: "error" })}\n`);
    await fs.writeFile(path.join(directory, "operational-api-2026-11-16.jsonl"),
      `${JSON.stringify({ id: "recent", timestamp: "2026-11-16T10:00:00.000Z", source: "api", level: "error" })}\n`);
    const result = await readOperationalLogs({
      logDir: directory,
      startTime: "2026-11-01T00:00:00.000Z",
      endTime: "2026-11-02T00:00:00.000Z",
      maximumBytes: 150,
    });
    assert.equal(result.total, 1);
    assert.equal(result.entries[0].id, "history");
    assert.equal(result.truncated, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
