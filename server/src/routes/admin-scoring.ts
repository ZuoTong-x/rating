import type { Express, Request, Response } from "express";
import { asyncRoute } from "./async-route.ts";

type ScoringRoutesService = {
  listScoringSummary(query: Request["query"]): Promise<unknown>;
  listScoringOptions(): Promise<unknown>;
  listScoringTaskRecords(query: Request["query"]): Promise<unknown>;
  previewRollback(body: unknown): Promise<unknown>;
  startRollbackJob(body: unknown, auth: unknown): unknown;
  getRollbackJob(jobId: string): unknown;
  rollbackJobDto(job: unknown): unknown;
};

export function registerAdminScoringRoutes(app: Express, service: ScoringRoutesService, {
  httpError, setShortApiCache,
}: {
  httpError: (status: number, message: string) => Error;
  setShortApiCache: (res: Response) => void;
}) {
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
    const auth = (req as Request & { auth?: unknown }).auth;
    res.status(202).json(service.rollbackJobDto(service.startRollbackJob(req.body, auth)));
  }));
  app.get("/api/admin/scoring/rollback/:jobId", asyncRoute(async (req, res) => {
    const job = service.getRollbackJob(req.params.jobId);
    if (!job) throw httpError(404, "任务回退作业不存在或已过期");
    res.json(service.rollbackJobDto(job));
  }));
}
