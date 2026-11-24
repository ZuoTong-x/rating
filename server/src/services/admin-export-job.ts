import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream, type WriteStream } from "node:fs";
import type { AdminExportConfig, AdminExportJob, AdminExportProgress, AdminExportQuery } from "./admin-export-types.ts";

type JsonExportWriter = (
  stream: WriteStream,
  query: AdminExportQuery,
  onProgress: (progress: AdminExportProgress) => void,
) => Promise<unknown>;

export function createAdminExportJobService({
    updateAdminExportJob, adminExportDir, writeProjectCompletedTasksExport,
    writeScorerCompletedTasksExport, writeScoringOperationsExport,
    writeScoringRiskReport, writeTeamTaskSummaryExport, writeSubjectTaskReportFile,
    httpError, adminExportJobs, ADMIN_EXPORT_JOB_TTL_MS,
    normalizeAdminExportRequest, adminExportFilename, nowIso,
    scheduleAdminExportJob,
}: {
  updateAdminExportJob: (job: AdminExportJob, patch: Partial<AdminExportJob>) => void;
  adminExportDir: string;
  writeProjectCompletedTasksExport: JsonExportWriter;
  writeScorerCompletedTasksExport: JsonExportWriter;
  writeScoringOperationsExport: JsonExportWriter;
  writeScoringRiskReport: JsonExportWriter;
  writeTeamTaskSummaryExport: JsonExportWriter;
  writeSubjectTaskReportFile: (
    projectId: string, filePath: string,
    onProgress: (progress: AdminExportProgress) => void,
  ) => Promise<unknown>;
  httpError: (status: number, message: string) => Error;
  adminExportJobs: Map<string, AdminExportJob>;
  ADMIN_EXPORT_JOB_TTL_MS: number;
  normalizeAdminExportRequest: (body: Record<string, unknown>) => AdminExportConfig;
  adminExportFilename: (config: AdminExportConfig) => Promise<string>;
  nowIso: () => string;
  scheduleAdminExportJob: (job: AdminExportJob) => void;
}) {
function updateAdminExportProgress(job: AdminExportJob, progress: AdminExportProgress | null | undefined) {
  if (!progress) return;
  updateAdminExportJob(job, {
    stage: progress.stage || job.stage,
    progress: Math.max(0, Math.min(99, Number(progress.progress) || job.progress)),
  });
}

async function runJsonAdminExport(job: AdminExportJob, writer: JsonExportWriter) {
  const stream = createWriteStream(job.filePath, { encoding: "utf8" });
  try {
    return await writer(stream, job.query, (progress) => {
      updateAdminExportProgress(job, progress);
    });
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

async function runAdminExportJob(job: AdminExportJob) {
  updateAdminExportJob(job, {
    status: "running",
    stage: "正在准备导出",
    progress: 3,
    message: null,
  });
  try {
    await fs.mkdir(adminExportDir, { recursive: true });
    if (job.type === "project-completed-tasks") {
      job.result = await runJsonAdminExport(job, writeProjectCompletedTasksExport);
    } else if (job.type === "scorer-completed-tasks") {
      job.result = await runJsonAdminExport(job, writeScorerCompletedTasksExport);
    } else if (job.type === "scoring-operation-log") {
      job.result = await runJsonAdminExport(job, writeScoringOperationsExport);
    } else if (job.type === "scoring-risk-report") {
      job.result = await runJsonAdminExport(job, writeScoringRiskReport);
    } else if (job.type === "team-task-summary") {
      job.result = await runJsonAdminExport(job, writeTeamTaskSummaryExport);
    } else if (job.type === "project-task-report") {
      const projectId = String(job.query.projectId || "").trim();
      if (!projectId) throw httpError(400, "缺少项目 ID");
      job.result = await writeSubjectTaskReportFile(
        projectId,
        job.filePath,
        (progress) => updateAdminExportProgress(job, progress),
      );
    } else {
      throw httpError(400, "导出类型不正确");
    }
    updateAdminExportJob(job, {
      status: "completed",
      stage: "导出文件已生成",
      progress: 100,
    });
  } catch (error) {
    await fs.rm(job.filePath, { force: true }).catch(() => {});
    updateAdminExportJob(job, {
      status: "failed",
      stage: "导出失败",
      progress: 100,
      message: error instanceof Error ? error.message : "导出失败，请重试",
    });
    console.error(`Admin export failed (${job.jobId})`, error);
  } finally {
    setTimeout(async () => {
      adminExportJobs.delete(job.jobId);
      await fs.rm(job.filePath, { force: true }).catch(() => {});
    }, ADMIN_EXPORT_JOB_TTL_MS).unref();
  }
}

async function startAdminExportJob(body: Record<string, unknown> = {}) {
  const config = normalizeAdminExportRequest(body);
  const filename = await adminExportFilename(config);
  const jobId = crypto.randomUUID();
  const now = nowIso();
  const job: AdminExportJob = {
    jobId,
    type: config.type,
    query: config.query,
    filename,
    contentType: config.contentType,
    extension: config.extension,
    filePath: path.join(adminExportDir, `${jobId}${config.extension}`),
    status: "queued",
    stage: config.stage,
    progress: 0,
    message: null,
    result: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + ADMIN_EXPORT_JOB_TTL_MS).toISOString(),
  };
  adminExportJobs.set(jobId, job);
  scheduleAdminExportJob(job);
  return job;
}

  return { runAdminExportJob, startAdminExportJob };
}
