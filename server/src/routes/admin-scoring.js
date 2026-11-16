import { asyncRoute } from "./async-route.js";

export function registerAdminScoringRoutes(app, service, { httpError, setShortApiCache }) {
  app.get("/api/admin/scoring/summary", asyncRoute(async (req, res) => {
    res.json(await service.listScoringSummary(req.query));
  }));
  app.get("/api/admin/scoring/options", asyncRoute(async (_req, res) => {
    setShortApiCache(res);
    res.json(await service.listScoringOptions());
  }));
  app.get("/api/admin/scoring/tasks", asyncRoute(async (req, res) => {
    res.json(await service.listScoringTaskRecords(req.query));
  }));
  app.post("/api/admin/scoring/rollback/preview", asyncRoute(async (req, res) => {
    res.json(await service.previewRollback(req.body));
  }));
  app.post("/api/admin/scoring/rollback", asyncRoute(async (req, res) => {
    res.status(202).json(service.rollbackJobDto(service.startRollbackJob(req.body, req.auth)));
  }));
  app.get("/api/admin/scoring/rollback/:jobId", asyncRoute(async (req, res) => {
    const job = service.getRollbackJob(req.params.jobId);
    if (!job) throw httpError(404, "任务回退作业不存在或已过期");
    res.json(service.rollbackJobDto(job));
  }));
}
