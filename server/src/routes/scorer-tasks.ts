import type { Express, RequestHandler, Response } from "express";
import { asyncRoute } from "./async-route.ts";
import { requestUser } from "./authenticated-request.ts";

type ScorerTaskListService = {
  assignedTaskOptions(query: { scorer: string }): Promise<unknown>;
  listAssignedTasks(query: Record<string, unknown>): Promise<unknown>;
  getScorerDashboard(query: Record<string, unknown>): Promise<unknown>;
};
type ScorerTaskDetailService = {
  completeAssignedTask(id: string, body: Record<string, unknown>): Promise<unknown>;
  updateCompletedTask(id: string, body: Record<string, unknown>): Promise<unknown>;
  getTaskDetail(id: string, query: { scorer: string; claimToken: unknown }): Promise<unknown>;
  releaseTaskClaim(id: string, scorer: string, claimToken: unknown): Promise<unknown>;
};

export function registerScorerTaskListRoutes(app: Express, tasks: ScorerTaskListService, setShortApiCache: (res: Response) => void) {
  app.get("/api/tasks/assigned/options", asyncRoute(async (req, res) => {
    setShortApiCache(res);
    res.json(await tasks.assignedTaskOptions({ scorer: requestUser(req).username }));
  }));
  app.get("/api/tasks/assigned", asyncRoute(async (req, res) => {
    setShortApiCache(res);
    res.json(await tasks.listAssignedTasks({ ...req.query, scorer: requestUser(req).username }));
  }));
  app.get("/api/scorer/dashboard", asyncRoute(async (req, res) => {
    setShortApiCache(res);
    res.json(await tasks.getScorerDashboard({ ...req.query, scorer: requestUser(req).username }));
  }));
}

export function registerScorerTaskDetailRoutes(app: Express, tasks: ScorerTaskDetailService, requireScorer: RequestHandler) {
  app.post("/api/tasks/:id/complete", requireScorer, asyncRoute(async (req, res) => {
    res.json({ task: await tasks.completeAssignedTask(req.params.id, {
      ...req.body,
      scorer: requestUser(req).username,
    }) });
  }));
  app.put("/api/tasks/:id/complete", requireScorer, asyncRoute(async (req, res) => {
    res.json({ task: await tasks.updateCompletedTask(req.params.id, {
      ...req.body,
      scorer: requestUser(req).username,
    }) });
  }));
  app.get("/api/tasks/:id", requireScorer, asyncRoute(async (req, res) => {
    res.json({ task: await tasks.getTaskDetail(req.params.id, {
      scorer: requestUser(req).username,
      claimToken: req.query.claimToken,
    }) });
  }));
  app.post("/api/tasks/:id/release", requireScorer, asyncRoute(async (req, res) => {
    res.json(await tasks.releaseTaskClaim(req.params.id, requestUser(req).username, req.body?.claimToken));
  }));
}
