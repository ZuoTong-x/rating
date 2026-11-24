import type { db as database } from "../postgres.ts";
import type { AdminExportConfig, AdminExportJob, AdminExportQuery } from "./admin-export-types.ts";

type Statement = Pick<ReturnType<typeof database.prepare>, "get">;

export function createAdminExportQueueService({
  adminExportQueue, ADMIN_EXPORT_CONCURRENCY,
  nowIso, httpError, parseQueryList, getProjectOrThrow,
  selectUserByIdStmt, selectScorerByUsernameStmt,
  normalizeTeamIds, selectTeamByIdStmt, runAdminExportJob,
}: {
  adminExportQueue: AdminExportJob[];
  ADMIN_EXPORT_CONCURRENCY: number;
  nowIso: () => string;
  httpError: (status: number, message: string) => Error;
  parseQueryList: (value: unknown) => string[];
  getProjectOrThrow: (id: unknown) => Promise<{ name: string }>;
  selectUserByIdStmt: Statement;
  selectScorerByUsernameStmt: Statement;
  normalizeTeamIds: (ids: string[]) => Promise<string[]>;
  selectTeamByIdStmt: Statement;
  runAdminExportJob: (job: AdminExportJob) => Promise<void>;
}) {
let activeAdminExportCount = 0;
function adminExportJobDto(job: AdminExportJob) {
  const payload: Record<string, unknown> = {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
    filename: job.filename,
    contentType: job.contentType,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  };
  if (job.status === "completed") {
    payload.downloadUrl = `/api/admin/exports/${job.jobId}/download`;
  }
  if (job.result) payload.result = job.result;
  return payload;
}

function updateAdminExportJob(job: AdminExportJob, patch: Partial<AdminExportJob>) {
  Object.assign(job, patch, { updatedAt: nowIso() });
}

function validateAdminExportJobId(jobId: string) {
  if (!/^[a-z0-9-]{8,128}$/i.test(jobId)) {
    throw httpError(400, "导出任务标识不正确");
  }
}

function adminExportTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeExportFilenamePart(value: unknown, fallback: string) {
  const text = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+$/, "")
    .slice(0, 96);
  return text || fallback;
}

function attachmentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function normalizeAdminExportDate(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw httpError(400, `${label}不正确`);
  return date.toISOString();
}

function normalizeAdminExportBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function adminExportJobConfig(type: string) {
  if (type === "project-completed-tasks") {
    return {
      fallbackName: "项目",
      title: "完成任务明细",
      extension: ".json",
      contentType: "application/json; charset=utf-8",
      stage: "等待导出项目任务明细",
    };
  }
  if (type === "scorer-completed-tasks") {
    return {
      fallbackName: "打分人",
      title: "完成任务明细",
      extension: ".json",
      contentType: "application/json; charset=utf-8",
      stage: "等待导出打分人任务明细",
    };
  }
  if (type === "scoring-operation-log") {
    return {
      fallbackName: "筛选结果",
      title: "打分操作记录",
      extension: ".json",
      contentType: "application/json; charset=utf-8",
      stage: "等待导出打分操作记录",
    };
  }
  if (type === "scoring-risk-report") {
    return {
      fallbackName: "打分人",
      title: "风险报告",
      extension: ".json",
      contentType: "application/json; charset=utf-8",
      stage: "等待导出打分风险报告",
    };
  }
  if (type === "team-task-summary") {
    return {
      fallbackName: "团队",
      title: "任务汇总",
      extension: ".json",
      contentType: "application/json; charset=utf-8",
      stage: "等待导出团队汇总",
    };
  }
  if (type === "project-task-report") {
    return {
      fallbackName: "项目",
      title: "打分详情",
      extension: ".xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      stage: "等待生成 Excel",
    };
  }
  throw httpError(400, "导出类型不正确");
}

async function adminExportEntityNames(type: string, query: AdminExportQuery = {}): Promise<string[]> {
  if (type === "scoring-operation-log") {
    return ["筛选结果"];
  }
  if (type === "scoring-risk-report") {
    return parseQueryList(query.scorers);
  }
  if (type === "project-completed-tasks") {
    const ids = parseQueryList(query.projectIds ?? query.projectId);
    const projects = await Promise.all(ids.map((id) => getProjectOrThrow(id)));
    return projects.map((project) => project.name);
  }
  if (type === "project-task-report") {
    const project = await getProjectOrThrow(query.projectId);
    return [project.name];
  }
  if (type === "scorer-completed-tasks") {
    const values = parseQueryList(query.scorerIds ?? query.scorerId ?? query.scorer);
    const users = await Promise.all(values.map(async (value) => {
      const user = (await selectUserByIdStmt.get(value)) || (await selectScorerByUsernameStmt.get(value));
      if (!user || user.role !== "scorer") throw httpError(400, "打分人不存在");
      return user;
    }));
    return users.map((user) => String(user.username));
  }
  if (type === "team-task-summary") {
    const ids = await normalizeTeamIds(parseQueryList(query.teamIds ?? query.teamId));
    const teams = await Promise.all(ids.map(async (id) => {
      const team = await selectTeamByIdStmt.get(id);
      if (!team) throw httpError(400, "团队不存在");
      return team;
    }));
    return teams.map((team) => String(team.name));
  }
  return [];
}

async function adminExportFilename(config: AdminExportConfig) {
  const names = await adminExportEntityNames(config.type, config.query);
  const entityName = names.length === 1
    ? names[0]
    : `${config.fallbackName}-${names.length || 0}个`;
  return `${sanitizeExportFilenamePart(entityName, config.fallbackName)}-${config.title}-${adminExportTimestamp()}${config.extension}`;
}

function normalizeAdminExportRequest(body: AdminExportQuery = {}): AdminExportConfig {
  const type = String(body.type || "").trim();
  const config = adminExportJobConfig(type);
  const completedFrom = normalizeAdminExportDate(body.completedFrom, "开始完成时间");
  const completedTo = normalizeAdminExportDate(body.completedTo, "结束完成时间");
  if (completedFrom && completedTo && new Date(completedFrom).getTime() > new Date(completedTo).getTime()) {
    throw httpError(400, "完成时间范围不正确");
  }
  if (
    type === "project-completed-tasks" &&
    !parseQueryList(body.projectIds ?? body.projectId).length
  ) {
    throw httpError(400, "请选择需要导出的项目");
  }
  if (
    type === "scorer-completed-tasks" &&
    !parseQueryList(body.scorerIds ?? body.scorerId ?? body.scorer).length
  ) {
    throw httpError(400, "请选择需要导出的打分人");
  }
  if (type === "scoring-risk-report" && !parseQueryList(body.scorers).length) {
    throw httpError(400, "请选择需要导出风险报告的打分人");
  }
  if (
    type === "team-task-summary" &&
    !parseQueryList(body.teamIds ?? body.teamId).length
  ) {
    throw httpError(400, "请选择需要导出的团队");
  }
  if (type === "project-task-report" && !String(body.projectId || "").trim()) {
    throw httpError(400, "缺少项目 ID");
  }
  return {
    type,
    query: {
      projectId: body.projectId,
      projectIds: body.projectIds,
      scorer: body.scorer,
      scorerId: body.scorerId,
      scorerIds: body.scorerIds,
      scorers: body.scorers,
      teamId: body.teamId,
      teamIds: body.teamIds,
      completedFrom,
      completedTo,
      submissionMode: body.submissionMode,
      minDurationSeconds: body.minDurationSeconds,
      maxDurationSeconds: body.maxDurationSeconds,
      excludeInactiveScorers: normalizeAdminExportBoolean(body.excludeInactiveScorers),
    },
    ...config,
  };
}

function runNextAdminExportJob() {
  if (activeAdminExportCount >= ADMIN_EXPORT_CONCURRENCY) return;
  const job = adminExportQueue.shift();
  if (!job) return;
  activeAdminExportCount += 1;
  setImmediate(async () => {
    await runAdminExportJob(job);
    activeAdminExportCount -= 1;
    runNextAdminExportJob();
  });
}

function scheduleAdminExportJob(job: AdminExportJob) {
  adminExportQueue.push(job);
  runNextAdminExportJob();
}
  return {
    adminExportJobDto, updateAdminExportJob, validateAdminExportJobId,
    adminExportFilename, normalizeAdminExportRequest,
    scheduleAdminExportJob, attachmentDisposition,
  };
}
