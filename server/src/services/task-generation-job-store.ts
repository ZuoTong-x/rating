import type { ChildProcess } from "node:child_process";

type Statement = ReturnType<typeof import("../postgres.ts").db.prepare>;

type StageEvent = {
  stage: string;
  progress: number;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  durationMs?: number;
};

export type TaskGenerationJob = {
  jobId: string;
  subjectId: string;
  status: string;
  stage: string;
  progress: number;
  message?: string | null;
  request?: unknown;
  stageEvents?: StageEvent[];
  result?: unknown;
  createdAt: string | Date;
  updatedAt: string | Date;
  expiresAt: string | Date;
  cleanupTimer?: NodeJS.Timeout;
  worker?: ChildProcess;
  persistPromise?: Promise<void>;
};

export function createTaskGenerationJobStore({
  taskGenerationJobs, activeTaskGenerationBySubject, nowIso,
  upsertTaskGenerationJobStmt, selectTaskGenerationJobStmt,
  selectActiveTaskGenerationJobBySubjectStmt,
  selectActiveTaskGenerationJobStmt, deleteTaskGenerationJobStmt,
}: {
  taskGenerationJobs: Map<string, TaskGenerationJob>;
  activeTaskGenerationBySubject: Map<string, string>;
  nowIso: () => string;
  upsertTaskGenerationJobStmt: Statement;
  selectTaskGenerationJobStmt: Statement;
  selectActiveTaskGenerationJobBySubjectStmt: Statement;
  selectActiveTaskGenerationJobStmt: Statement;
  deleteTaskGenerationJobStmt: Statement;
}) {

function parseTaskGenerationJobJson<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function taskGenerationJobDto(job: TaskGenerationJob) {
  const payload = {
    jobId: job.jobId,
    subjectId: job.subjectId,
    projectId: job.subjectId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
  };
  if (job.request) Object.assign(payload, { request: job.request });
  if (job.stageEvents?.length) Object.assign(payload, { stageEvents: job.stageEvents });
  if (job.result) Object.assign(payload, { result: job.result });
  return payload;
}

function taskGenerationJobFromRow(row: Record<string, unknown> | null | undefined): TaskGenerationJob | null {
  if (!row) return null;
  return {
    jobId: String(row.jobId),
    subjectId: String(row.subjectId),
    status: String(row.status),
    stage: String(row.stage),
    progress: Number(row.progress || 0),
    message: row.message ? String(row.message) : null,
    request: parseTaskGenerationJobJson(row.requestJson, null),
    stageEvents: parseTaskGenerationJobJson<StageEvent[]>(row.stageEventsJson, []),
    result: parseTaskGenerationJobJson(row.resultJson, null),
    createdAt: row.createdAt as string | Date,
    updatedAt: row.updatedAt as string | Date,
    expiresAt: row.expiresAt as string | Date,
  };
}

function taskGenerationJobRecord(job: TaskGenerationJob) {
  return {
    jobId: job.jobId,
    subjectId: job.subjectId,
    status: job.status,
    stage: job.stage,
    progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
    message: job.message || null,
    requestJson: job.request ? JSON.stringify(job.request) : null,
    stageEventsJson: job.stageEvents?.length ? JSON.stringify(job.stageEvents) : null,
    resultJson: job.result ? JSON.stringify(job.result) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  };
}

async function persistTaskGenerationJob(job: TaskGenerationJob) {
  job.updatedAt = nowIso();
  await upsertTaskGenerationJobStmt.run(taskGenerationJobRecord(job));
}

function closeTaskGenerationStageEvent(event: StageEvent | undefined, endedAt: string) {
  if (!event || event.endedAt) return;
  event.endedAt = endedAt;
  const startedAt = new Date(event.startedAt).getTime();
  const endedAtMs = new Date(endedAt).getTime();
  if (Number.isFinite(startedAt) && Number.isFinite(endedAtMs)) {
    event.durationMs = Math.max(0, endedAtMs - startedAt);
  }
}

function recordTaskGenerationStage(job: TaskGenerationJob, stage: string, progress: number, terminal = false) {
  const nextStage = String(stage || job.stage || "任务生成中");
  const nextProgress = Math.max(0, Math.min(100, Number(progress ?? job.progress) || 0));
  const timestamp = nowIso();
  const events = Array.isArray(job.stageEvents) ? job.stageEvents : [];
  const current = events[events.length - 1];
  if (!current || current.stage !== nextStage) {
    closeTaskGenerationStageEvent(current, timestamp);
    events.push({
      stage: nextStage,
      progress: nextProgress,
      startedAt: timestamp,
      updatedAt: timestamp,
    });
  } else {
    current.progress = nextProgress;
    current.updatedAt = timestamp;
  }
  if (terminal) closeTaskGenerationStageEvent(events[events.length - 1], timestamp);
  job.stageEvents = events.slice(-80);
}

async function getTaskGenerationJob(jobId: string) {
  const cached = taskGenerationJobs.get(jobId);
  if (cached) return cached;
  return taskGenerationJobFromRow(await selectTaskGenerationJobStmt.get(jobId));
}

async function getActiveTaskGenerationJob(subjectId: string) {
  const activeJobId = activeTaskGenerationBySubject.get(subjectId);
  if (activeJobId) {
    const cached = taskGenerationJobs.get(activeJobId);
    if (cached && ["queued", "running"].includes(cached.status)) return cached;
    const persisted = taskGenerationJobFromRow(
      await selectTaskGenerationJobStmt.get(activeJobId),
    );
    if (persisted && ["queued", "running"].includes(persisted.status)) {
      taskGenerationJobs.set(persisted.jobId, persisted);
      return persisted;
    }
    activeTaskGenerationBySubject.delete(subjectId);
  }

  const persisted = taskGenerationJobFromRow(
    await selectActiveTaskGenerationJobBySubjectStmt.get(subjectId),
  );
  if (persisted) {
    taskGenerationJobs.set(persisted.jobId, persisted);
    activeTaskGenerationBySubject.set(subjectId, persisted.jobId);
  }
  return persisted;
}

async function getAnyActiveTaskGenerationJob() {
  const cached = [...taskGenerationJobs.values()]
    .filter((job) => ["queued", "running"].includes(job.status))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0];
  if (cached) return cached;
  return taskGenerationJobFromRow(await selectActiveTaskGenerationJobStmt.get());
}

function scheduleTaskGenerationJobCleanup(job: TaskGenerationJob) {
  if (job.cleanupTimer) return;
  const delayMs = Math.max(0, new Date(job.expiresAt).getTime() - Date.now());
  job.cleanupTimer = setTimeout(() => {
    void deleteTaskGenerationJob(job.jobId).catch((error) => {
      console.error(`Failed to delete task generation job (${job.jobId})`, error);
    });
    delete job.cleanupTimer;
  }, delayMs).unref();
}

async function deleteTaskGenerationJob(jobId: string) {
  const cached = taskGenerationJobs.get(jobId);
  if (cached && activeTaskGenerationBySubject.get(cached.subjectId) === jobId) {
    activeTaskGenerationBySubject.delete(cached.subjectId);
  }
  if (cached?.cleanupTimer) {
    clearTimeout(cached.cleanupTimer);
    delete cached.cleanupTimer;
  }
  taskGenerationJobs.delete(jobId);
  await deleteTaskGenerationJobStmt.run(jobId);
}
  return {
    taskGenerationJobDto, taskGenerationJobFromRow,
    taskGenerationJobRecord, persistTaskGenerationJob,
    recordTaskGenerationStage, getTaskGenerationJob,
    getActiveTaskGenerationJob, getAnyActiveTaskGenerationJob,
    scheduleTaskGenerationJobCleanup, deleteTaskGenerationJob,
  };
}
