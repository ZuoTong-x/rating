import assert from "node:assert/strict";
import test from "node:test";
import { createTaskGenerationTemplatesService } from "../src/services/task-generation-templates.ts";

const { buildDimensionAwareAssignmentPlan } = createTaskGenerationTemplatesService({
  httpError: (status, message) => Object.assign(new Error(message), { status }),
});

test("维度分配保持每位打分人的任务总数，并覆盖每个维度", () => {
  const candidates = ["layout", "text", "color"].flatMap((criterion) =>
    Array.from({ length: 4 }, () => ({ criterion }))
  );
  const plan = buildDimensionAwareAssignmentPlan(candidates, [
    { scorer: "A", taskCount: 5 },
    { scorer: "B", taskCount: 4 },
    { scorer: "C", taskCount: 3 },
  ]);

  assert.equal(plan.length, candidates.length);
  for (const [scorer, expected] of [["A", 5], ["B", 4], ["C", 3]]) {
    assert.equal(plan.filter((assigned) => assigned === scorer).length, expected);
  }
  for (let start = 0; start < candidates.length; start += 4) {
    assert.deepEqual(new Set(plan.slice(start, start + 4)), new Set(["A", "B", "C"]));
  }
});

test("候选任务数与分配总数不一致时拒绝下发", () => {
  assert.throws(
    () => buildDimensionAwareAssignmentPlan([{ criterion: "layout" }], [
      { scorer: "A", taskCount: 2 },
    ]),
    /任务候选数量与分配数量不一致/,
  );
});
