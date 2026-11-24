import assert from "node:assert/strict";
import test from "node:test";
import { retryTaskStatsRefresh } from "../src/task-stats-retry.ts";

test("retries a serialization conflict from a fresh transaction", async () => {
  let attempts = 0;
  const waits = [];
  const result = await retryTaskStatsRefresh(
    async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("conflict"), { code: "40001" });
      return "done";
    },
    undefined,
    async (ms) => { waits.push(ms); },
  );
  assert.equal(result, "done");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [150, 300]);
});

test("does not repeat a nontransient error", async () => {
  let attempts = 0;
  await assert.rejects(
    retryTaskStatsRefresh(async () => {
      attempts += 1;
      throw Object.assign(new Error("bad request"), { code: "23505" });
    }, undefined, async () => {}),
    { code: "23505" },
  );
  assert.equal(attempts, 1);
});

test("stops after four retryable failures", async () => {
  let attempts = 0;
  await assert.rejects(
    retryTaskStatsRefresh(async () => {
      attempts += 1;
      throw Object.assign(new Error("deadlock"), { code: "40P01" });
    }, undefined, async () => {}),
    { code: "40P01" },
  );
  assert.equal(attempts, 4);
});
