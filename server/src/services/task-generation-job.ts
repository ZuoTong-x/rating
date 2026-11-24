import crypto from "node:crypto";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TaskGenerationJob } from "./task-generation-job-store.ts";
import type { createTaskGenerationPlanService } from "./task-generation-plan.ts";
import type { createProjectService } from "./projects.ts";

type PlanFns = ReturnType<typeof createTaskGenerationPlanService>;
type Assignment = Parameters<PlanFns["prepareTaskGeneration"]>[1] & { exactAssignmentFile?: string };
type Project = Awaited<ReturnType<ReturnType<typeof createProjectService>["getProjectOrThrow"]>>;
type WorkerMessage = {
  type?: string;
  stage?: string;
  progress?: number;
  result?: unknown;
  message?: string;
  needsReconciliation?: boolean;
};

export function createTaskGenerationJobService({
  getActiveTaskGenerationJob, getAnyActiveTaskGenerationJob, httpError,
  prepareTaskGeneration, nowIso, taskGenerationRequestSummary,
  taskGenerationJobTtlMs, persistTaskGenerationJob, taskGenerationJobs,
  activeTaskGenerationBySubject, invalidateScorerQueryCaches,
  invalidateTaskSummaryCaches, recordTaskGenerationStage,
  TASK_GENERATION_PROGRESS_PERSIST_INTERVAL_MS, queueTaskGenerationAnalyze,
  scheduleTaskGenerationJobCleanup, getProjectOrThrow,
  getTaskGenerationCapacity, parseTaskGenerationAssignees,
  parseExactTaskGenerationAssignment,
}: {
  getActiveTaskGenerationJob: (id: string) => Promise<TaskGenerationJob | null>;
  getAnyActiveTaskGenerationJob: () => Promise<TaskGenerationJob | null>;
  httpError: (status: number, message: string) => Error;
  prepareTaskGeneration: PlanFns["prepareTaskGeneration"];
  nowIso: () => string;
  taskGenerationRequestSummary: PlanFns["taskGenerationRequestSummary"];
  taskGenerationJobTtlMs: number;
  persistTaskGenerationJob: (job: TaskGenerationJob) => Promise<void>;
  taskGenerationJobs: Map<string, TaskGenerationJob>;
  activeTaskGenerationBySubject: Map<string, string>;
  invalidateScorerQueryCaches: () => void;
  invalidateTaskSummaryCaches: (id: string) => void;
  recordTaskGenerationStage: (job: TaskGenerationJob, stage: string, progress: number, terminal: boolean) => void;
  TASK_GENERATION_PROGRESS_PERSIST_INTERVAL_MS: number;
  queueTaskGenerationAnalyze: () => void;
  scheduleTaskGenerationJobCleanup: (job: TaskGenerationJob) => void;
  getProjectOrThrow: (id: string) => Promise<Project>;
  getTaskGenerationCapacity: PlanFns["getTaskGenerationCapacity"];
  parseTaskGenerationAssignees: (body: Record<string, unknown>) => Promise<Assignment>;
  parseExactTaskGenerationAssignment: (body: Record<string, unknown>, file: Express.Multer.File | undefined) => Promise<Assignment>;
}) {
  async function cleanupExactTaskAssignment(assignment: Assignment) {
    if (assignment?.mode !== "exact" || !assignment.exactAssignmentFile) return;
    await fs.unlink(assignment.exactAssignmentFile).catch(() => {});
  }

  async function startPreparedTaskGeneration(subjectId: string, assignment: Assignment, project: Project) {
    const exactMode = assignment.mode === "exact";
    const waitingStage = exactMode ? "等待精确任务分配" : "等待导入任务模板";
    const completedStage = exactMode ? "精确任务分配完成" : "任务导入完成";
    const failedStage = exactMode ? "精确任务分配失败" : "任务导入失败";

    const activeJob = await getActiveTaskGenerationJob(subjectId);
    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      await cleanupExactTaskAssignment(assignment);
      return activeJob;
    }

    const anyActiveJob = await getAnyActiveTaskGenerationJob();
    if (anyActiveJob && anyActiveJob.subjectId !== subjectId) {
      throw httpError(409, "已有任务生成作业正在执行，请等待完成后再下发");
    }

    const prepared = await prepareTaskGeneration(subjectId, assignment, project);

    const createdAt = nowIso();
    const job: TaskGenerationJob = {
      jobId: crypto.randomUUID(),
      subjectId,
      status: "queued",
      stage: waitingStage,
      progress: 0,
      message: null,
      request: taskGenerationRequestSummary(assignment, prepared),
      stageEvents: [{
        stage: waitingStage,
        progress: 0,
        startedAt: createdAt,
        updatedAt: createdAt,
      }],
      result: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + taskGenerationJobTtlMs).toISOString(),
    };
    await persistTaskGenerationJob(job);
    taskGenerationJobs.set(job.jobId, job);
    activeTaskGenerationBySubject.set(subjectId, job.jobId);
    invalidateScorerQueryCaches();

    const invalidateGenerationCaches = () => {
      invalidateTaskSummaryCaches(subjectId);
      invalidateScorerQueryCaches();
    };
    let worker;
    let terminalStateReceived = false;
    try {
      const compiled = import.meta.url.includes("/dist/");
      worker = fork(
        fileURLToPath(new URL(compiled ? "../task-generation-worker.js" : "../task-generation-worker.ts", import.meta.url)),
        [],
        {
          env: { ...process.env, TASK_GENERATION_WORKER: "1" },
          execArgv: compiled ? [] : ["--import", "tsx"],
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
    } catch (error) {
      invalidateGenerationCaches();
      job.status = "failed";
      job.stage = failedStage;
      job.message = error instanceof Error ? error.message : "任务生成进程启动失败";
      await persistTaskGenerationJob(job);
      activeTaskGenerationBySubject.delete(subjectId);
      await cleanupExactTaskAssignment(assignment);
      throw error;
    }
    job.worker = worker;
    let lastProgressPersistedAt = 0;
    const commitJobState = (patch: Partial<TaskGenerationJob> = {}, options: { force?: boolean } = {}) => {
      Object.assign(job, patch);
      if (patch.stage || patch.progress != null || ["completed", "failed"].includes(patch.status ?? "")) {
        recordTaskGenerationStage(
          job,
          job.stage,
          job.progress,
          ["completed", "failed"].includes(job.status),
        );
      }
      const isProgressUpdate = !options.force && patch.status === "running";
      const now = Date.now();
      if (
        isProgressUpdate &&
        lastProgressPersistedAt &&
        now - lastProgressPersistedAt < TASK_GENERATION_PROGRESS_PERSIST_INTERVAL_MS
      ) {
        return job.persistPromise || Promise.resolve();
      }
      if (isProgressUpdate) lastProgressPersistedAt = now;
      const next = (job.persistPromise || Promise.resolve())
        .catch(() => {})
        .then(() => persistTaskGenerationJob(job));
      job.persistPromise = next.catch((error) => {
        console.error(`Task generation job persist failed (${job.jobId})`, error);
      });
      return job.persistPromise;
    };
    worker.on("message", (rawMessage: unknown) => {
      const message = rawMessage as WorkerMessage;
      void (async () => {
        if (message?.type === "progress") {
          await commitJobState({
            status: "running",
            stage: message.stage || job.stage,
            progress: Math.max(0, Math.min(100, Number(message.progress) || 0)),
          });
          return;
        }
        if (message?.type === "completed") {
          if (terminalStateReceived) return;
          terminalStateReceived = true;
          invalidateGenerationCaches();
          await commitJobState({
            result: message.result,
            status: "completed",
            stage: completedStage,
            progress: 100,
          }, { force: true });
          queueTaskGenerationAnalyze();
          worker.disconnect();
          activeTaskGenerationBySubject.delete(subjectId);
          delete job.worker;
          await cleanupExactTaskAssignment(assignment);
          scheduleTaskGenerationJobCleanup(job);
          return;
        }
        if (message?.type === "failed") {
          if (terminalStateReceived) return;
          terminalStateReceived = true;
          invalidateGenerationCaches();
          if (message.needsReconciliation) {
            job.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
          }
          await commitJobState({
            status: "failed",
            stage: message.needsReconciliation ? "需要核对实际任务及统计结果" : failedStage,
            message: message.message || "任务导入失败，请重试",
          }, { force: true });
          worker.disconnect();
          activeTaskGenerationBySubject.delete(subjectId);
          delete job.worker;
          await cleanupExactTaskAssignment(assignment);
          scheduleTaskGenerationJobCleanup(job);
        }
      })().catch((error) => {
        console.error(`Task generation job update failed (${job.jobId})`, error);
      });
    });
    worker.on("error", (error) => {
      void (async () => {
        if (terminalStateReceived) return;
        terminalStateReceived = true;
        if (["queued", "running"].includes(job.status)) {
          invalidateGenerationCaches();
          await commitJobState({
            status: "failed",
            stage: failedStage,
            message: error.message || "任务生成进程启动失败",
          }, { force: true });
        }
        activeTaskGenerationBySubject.delete(subjectId);
        delete job.worker;
        await cleanupExactTaskAssignment(assignment);
        scheduleTaskGenerationJobCleanup(job);
      })().catch((persistError) => {
        console.error(`Task generation worker failed (${job.jobId})`, persistError);
      });
      console.error(`Task generation worker failed (${job.jobId})`, error);
    });
    worker.on("exit", (code, signal) => {
      void (async () => {
        if (terminalStateReceived) return;
        terminalStateReceived = true;
        if (["queued", "running"].includes(job.status)) {
          invalidateGenerationCaches();
          await commitJobState({
            status: "failed",
            stage: failedStage,
            message: signal
              ? `任务生成进程异常退出（signal ${signal}）`
              : `任务生成进程异常退出（code ${code}）`,
          }, { force: true });
        }
        activeTaskGenerationBySubject.delete(subjectId);
        delete job.worker;
        await cleanupExactTaskAssignment(assignment);
        scheduleTaskGenerationJobCleanup(job);
      })().catch((error) => {
        console.error(`Task generation job exit handling failed (${job.jobId})`, error);
      });
    });
    worker.send({ type: "start", subjectId, assignment });

    return job;
  }

  async function startSubjectTaskGeneration(subjectId: string, assigneesInput: Record<string, unknown> = {}) {
    const project = await getProjectOrThrow(subjectId);
    if (project.taskStatus === "task_completed" &&
        (await getTaskGenerationCapacity(subjectId, project)).availableTaskCount === 0) {
      throw httpError(409, "当前项目已完成任务，不能继续下发");
    }
    const assignment = await parseTaskGenerationAssignees(assigneesInput);
    return startPreparedTaskGeneration(subjectId, assignment, project);
  }

  async function startExactSubjectTaskGeneration(subjectId: string, body: Record<string, unknown>, file: Express.Multer.File | undefined) {
    try {
      const project = await getProjectOrThrow(subjectId);
      if (project.taskStatus === "task_completed" &&
          (await getTaskGenerationCapacity(subjectId, project)).availableTaskCount === 0) {
        throw httpError(409, "当前项目已完成任务，不能继续下发");
      }
      const assignment = await parseExactTaskGenerationAssignment(body, file);
      return await startPreparedTaskGeneration(subjectId, assignment, project);
    } catch (error) {
      if (file?.path) await fs.unlink(file.path).catch(() => {});
      throw error;
    }
  }

  return { startSubjectTaskGeneration, startExactSubjectTaskGeneration };
}
