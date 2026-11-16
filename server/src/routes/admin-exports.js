import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { asyncRoute } from "./async-route.js";

export function registerAdminExportRoutes(app, exports) {
  app.post("/api/admin/exports", asyncRoute(async (req, res) => {
    const job = await exports.startAdminExportJob(req.body);
    res.status(202).json(exports.adminExportJobDto(job));
  }));

  app.get("/api/admin/exports/:jobId", asyncRoute(async (req, res) => {
    exports.validateAdminExportJobId(req.params.jobId);
    const job = exports.adminExportJobs.get(req.params.jobId);
    if (!job) throw exports.httpError(404, "导出任务不存在或已过期");
    res.json(exports.adminExportJobDto(job));
  }));

  app.get("/api/admin/exports/:jobId/download", asyncRoute(async (req, res, next) => {
    exports.validateAdminExportJobId(req.params.jobId);
    const job = exports.adminExportJobs.get(req.params.jobId);
    if (!job) throw exports.httpError(404, "导出任务不存在或已过期");
    if (job.status !== "completed") throw exports.httpError(409, "导出文件尚未生成完成");
    await fs.access(job.filePath);
    res.setHeader("Content-Type", job.contentType);
    res.setHeader("Content-Disposition", exports.attachmentDisposition(job.filename));
    createReadStream(job.filePath).on("error", next).pipe(res);
  }));

  app.get("/api/admin/tasks/completed/export", asyncRoute(exports.exportCompletedTasks));
  app.get("/api/admin/scorers/task-summary/export", asyncRoute(exports.exportScorerTaskSummary));
  app.get("/api/admin/scorers/completed/export", asyncRoute(exports.exportScorerTaskSummary));
  app.get("/api/admin/teams/task-summary/export", asyncRoute(exports.exportTeamTaskSummary));
}
