import test from "node:test";
import assert from "node:assert/strict";
import { createTaskStatsCalculation } from "../src/services/task-stats-calculation.ts";

const calculations = createTaskStatsCalculation({
  taskVersion: "v3",
  nowIso: () => "2026-11-18T00:00:00.000Z",
});

test("提交任务后项目和打分人计数只转移状态，不增加总数", () => {
  const oldTask = {
    id: "task-1", projectId: "project-1", taskVersion: "v3",
    scorer: "scorer-1", status: "assigned", isBacktest: false,
  };
  const newTask = {
    ...oldTask, status: "completed", completedAt: "2026-11-18T12:15:00.000Z",
    submissionMode: "direct", behaviorTracked: true, durationMs: 5000,
    largeImageOpened: true, largeImageOpenCount: 1, riskScore: 10,
  };
  const event = calculations.normalizedTaskStatsEvent({
    oldTask, newTask, applyScorerTaskStats: true,
  });
  const result = calculations.aggregateTaskStatsEvents([event]);
  assert.deepEqual(
    [result.projectDeltas.get("project-1").total,
      result.projectDeltas.get("project-1").assigned,
      result.projectDeltas.get("project-1").completed],
    [0, -1, 1],
  );
  const scorer = result.scorerTaskDeltas.get("scorer-1\u0000v3\u0000project-1");
  assert.equal(scorer.assigned, -1);
  assert.equal(scorer.completed, 1);
  const scoring = result.scoringDeltas.get("scorer-1\u0000v3\u0000project-1\u0000direct");
  assert.equal(scoring.taskCount, 1);
  assert.equal(scoring.durationTotal, 5000);
  assert.equal(result.hourDeltas.get("v3\u000020"), 1);
});
