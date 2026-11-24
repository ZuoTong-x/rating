type TaskRecord = {
  id?: string; projectId?: string; subjectId?: string; taskVersion?: string;
  status?: string; scorer?: string | null; completedAt?: string | Date | null;
  isBacktest?: boolean; behaviorTracked?: boolean; largeImageOpened?: boolean;
  orderChanged?: boolean; durationMs?: number | null; riskScore?: number | null;
  submissionMode?: string | null; largeImageOpenCount?: number | null;
  dragActionCount?: number | null; rankingActionCount?: number | null;
  pageBlurCount?: number | null; firstActionMs?: number | null;
  startedAt?: string | null; editedAt?: string | null; updatedAt?: string | null;
  rollbackCount?: number | null;
};

export type TaskStatsEvent = {
  oldTask?: TaskRecord | null; newTask?: TaskRecord | null;
  projectId?: string; subjectId?: string; taskId?: string; id?: string;
  taskVersion?: string; eventType?: string; oldStatus?: string | null;
  newStatus?: string | null; oldScorer?: string | null; newScorer?: string | null;
  oldCompletedAt?: string | Date | null; newCompletedAt?: string | Date | null;
  isBacktest?: boolean; applyScorerTaskStats?: boolean;
  oldScoringStats?: ScoringSnapshot | null; newScoringStats?: ScoringSnapshot | null;
  createdAt?: string;
};

type ScoringSnapshot = NonNullable<ReturnType<ReturnType<typeof createTaskStatsCalculation>["taskScoringStatsSnapshot"]>>;

export function createTaskStatsCalculation({ taskVersion, nowIso }: { taskVersion: string; nowIso: () => string }) {
function normalizedTaskStatsEvent(event: TaskStatsEvent = {}) {
  const oldTask = event.oldTask || null;
  const newTask = event.newTask || null;
  const projectId = String(
    event.projectId || newTask?.projectId || oldTask?.projectId ||
    event.subjectId || newTask?.subjectId || oldTask?.subjectId || "",
  ).trim();
  if (!projectId) return null;
  return {
    taskId: event.taskId || event.id || newTask?.id || oldTask?.id || null,
    projectId,
    taskVersion: event.taskVersion || newTask?.taskVersion || oldTask?.taskVersion || taskVersion,
    eventType: event.eventType || "task_changed",
    oldStatus: event.oldStatus ?? oldTask?.status ?? null,
    newStatus: event.newStatus ?? newTask?.status ?? null,
    oldScorer: event.oldScorer ?? oldTask?.scorer ?? null,
    newScorer: event.newScorer ?? newTask?.scorer ?? null,
    oldCompletedAt: event.oldCompletedAt ?? oldTask?.completedAt ?? null,
    newCompletedAt: event.newCompletedAt ?? newTask?.completedAt ?? null,
    isBacktest: Boolean(event.isBacktest ?? newTask?.isBacktest ?? oldTask?.isBacktest),
    applyScorerTaskStats: Boolean(event.applyScorerTaskStats),
    oldScoringStats: event.oldScoringStats ?? taskScoringStatsSnapshot(oldTask),
    newScoringStats: event.newScoringStats ?? taskScoringStatsSnapshot(newTask),
    createdAt: event.createdAt || nowIso(),
  };
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function taskScoringStatsSnapshot(task: TaskRecord | null | undefined) {
  if (!task || task.status !== "completed") return null;
  const scorer = String(task.scorer || "").trim();
  const projectId = String(task.projectId || task.subjectId || "").trim();
  if (!scorer || !projectId) return null;
  const behaviorTracked = Boolean(task.behaviorTracked);
  const largeImageOpened = Boolean(task.largeImageOpened);
  const orderChanged = Boolean(task.orderChanged);
  const durationValue = Number(task.durationMs);
  const durationMs = Number.isFinite(durationValue) && durationValue >= 0
    ? Math.floor(durationValue)
    : null;
  const riskScore = nonNegativeInteger(task.riskScore);
  return {
    scorer,
    taskVersion: task.taskVersion || taskVersion,
    projectId,
    submissionMode: task.submissionMode || "untracked",
    taskCount: 1,
    largeImageOpenedCount: largeImageOpened ? 1 : 0,
    trackedLargeImageOpenedCount: behaviorTracked && largeImageOpened ? 1 : 0,
    largeImageOpenCountTotal: nonNegativeInteger(task.largeImageOpenCount),
    dragActionCountTotal: nonNegativeInteger(task.dragActionCount),
    orderChangedCount: behaviorTracked && orderChanged ? 1 : 0,
    fastSubmitCount: behaviorTracked && durationMs != null && durationMs < 3000 ? 1 : 0,
    highRiskCount: behaviorTracked && riskScore >= 60 ? 1 : 0,
    behaviorTrackedCount: behaviorTracked ? 1 : 0,
    riskScoreTotal: behaviorTracked ? riskScore : 0,
    riskScoreMax: behaviorTracked ? riskScore : 0,
    pageBlurCountTotal: behaviorTracked ? nonNegativeInteger(task.pageBlurCount) : 0,
    durationTotal: durationMs ?? 0,
    durationCount: durationMs == null ? 0 : 1,
    durationMin: durationMs,
    durationMax: durationMs,
    rollbackCount: nonNegativeInteger(task.rollbackCount),
  };
}

const scoringStatsAdditiveFields = [
  "taskCount",
  "largeImageOpenedCount",
  "trackedLargeImageOpenedCount",
  "largeImageOpenCountTotal",
  "dragActionCountTotal",
  "orderChangedCount",
  "fastSubmitCount",
  "highRiskCount",
  "behaviorTrackedCount",
  "riskScoreTotal",
  "pageBlurCountTotal",
  "durationTotal",
  "durationCount",
  "rollbackCount",
 ] as const;

type AdditiveField = typeof scoringStatsAdditiveFields[number];
type ProjectDelta = {
  projectId: string; taskVersion: string; total: number; pending: number;
  assigned: number; completed: number; baseTotal: number; basePending: number;
};
type ScorerTaskDelta = {
  scorer: string; taskVersion: string; projectId: string;
  assigned: number; completed: number;
};
type ScoringDelta = Record<AdditiveField, number> & {
  scorer: string; taskVersion: string; projectId: string; submissionMode: string;
  riskScoreMax: number; durationMin: number | null; durationMax: number | null;
  requiresExtremaRefresh: boolean;
};

function statusCounterDelta(target: ProjectDelta, status: string | null, direction: number, isBacktest = false) {
  if (!status) return;
  target.total += direction;
  if (status === "pending") target.pending += direction;
  if (status === "assigned") target.assigned += direction;
  if (status === "completed") target.completed += direction;
  if (!isBacktest) {
    target.baseTotal += direction;
    if (status === "pending") target.basePending += direction;
  }
}

function scorerTaskStatsDelta(map: Map<string, ScorerTaskDelta>, event: NonNullable<ReturnType<typeof normalizedTaskStatsEvent>>, scorer: string | null, status: string | null, direction: number) {
  if (!event.applyScorerTaskStats || !scorer || !status || !["assigned", "completed"].includes(status)) return;
  const key = [scorer, event.taskVersion, event.projectId].join("\u0000");
  const delta = map.get(key) || {
    scorer,
    taskVersion: event.taskVersion,
    projectId: event.projectId,
    assigned: 0,
    completed: 0,
  };
  delta[status as "assigned" | "completed"] += direction;
  map.set(key, delta);
}

function scoringStatsDelta(map: Map<string, ScoringDelta>, snapshot: ScoringSnapshot | null, direction: number) {
  if (!snapshot?.scorer || !snapshot?.projectId) return;
  const submissionMode = snapshot.submissionMode || "untracked";
  const key = [snapshot.scorer, snapshot.taskVersion, snapshot.projectId, submissionMode].join("\u0000");
  const delta = map.get(key) || {
    scorer: snapshot.scorer,
    taskVersion: snapshot.taskVersion,
    projectId: snapshot.projectId,
    submissionMode,
    riskScoreMax: 0,
    durationMin: null,
    durationMax: null,
    requiresExtremaRefresh: false,
    ...Object.fromEntries(scoringStatsAdditiveFields.map((field) => [field, 0])) as Record<AdditiveField, number>,
  };
  scoringStatsAdditiveFields.forEach((field) => {
    delta[field] += direction * Number(snapshot[field] || 0);
  });
  if (direction > 0) {
    delta.riskScoreMax = Math.max(delta.riskScoreMax, Number(snapshot.riskScoreMax || 0));
    if (snapshot.durationMin != null) {
      delta.durationMin = delta.durationMin == null
        ? Number(snapshot.durationMin)
        : Math.min(delta.durationMin, Number(snapshot.durationMin));
    }
    if (snapshot.durationMax != null) {
      delta.durationMax = delta.durationMax == null
        ? Number(snapshot.durationMax)
        : Math.max(delta.durationMax, Number(snapshot.durationMax));
    }
  } else {
    delta.requiresExtremaRefresh = true;
  }
  map.set(key, delta);
}

function shanghaiHour(value: string | Date | null) {
  if (!value) return null;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return null;
  return (timestamp.getUTCHours() + 8) % 24;
}

function aggregateTaskStatsEvents(events: Array<NonNullable<ReturnType<typeof normalizedTaskStatsEvent>>>) {
  const projectDeltas = new Map<string, ProjectDelta>();
  const scorerTaskDeltas = new Map<string, ScorerTaskDelta>();
  const scoringDeltas = new Map<string, ScoringDelta>();
  const hourDeltas = new Map<string, number>();
  for (const event of events) {
    const projectDelta = projectDeltas.get(event.projectId) || {
      projectId: event.projectId,
      taskVersion: event.taskVersion,
      total: 0,
      pending: 0,
      assigned: 0,
      completed: 0,
      baseTotal: 0,
      basePending: 0,
    };
    statusCounterDelta(projectDelta, event.oldStatus, -1, event.isBacktest);
    statusCounterDelta(projectDelta, event.newStatus, 1, event.isBacktest);
    projectDeltas.set(event.projectId, projectDelta);

    scorerTaskStatsDelta(scorerTaskDeltas, event, event.oldScorer, event.oldStatus, -1);
    scorerTaskStatsDelta(scorerTaskDeltas, event, event.newScorer, event.newStatus, 1);
    scoringStatsDelta(scoringDeltas, event.oldScoringStats, -1);
    scoringStatsDelta(scoringDeltas, event.newScoringStats, 1);

    const oldHour = event.oldStatus === "completed" ? shanghaiHour(event.oldCompletedAt) : null;
    const newHour = event.newStatus === "completed" ? shanghaiHour(event.newCompletedAt) : null;
    if (oldHour != null) {
      const key = `${event.taskVersion}\u0000${oldHour}`;
      hourDeltas.set(key, (hourDeltas.get(key) || 0) - 1);
    }
    if (newHour != null) {
      const key = `${event.taskVersion}\u0000${newHour}`;
      hourDeltas.set(key, (hourDeltas.get(key) || 0) + 1);
    }
  }
  return { projectDeltas, scorerTaskDeltas, scoringDeltas, hourDeltas };
}
  return {
    normalizedTaskStatsEvent, taskScoringStatsSnapshot,
    scoringStatsAdditiveFields, aggregateTaskStatsEvents,
  };
}
