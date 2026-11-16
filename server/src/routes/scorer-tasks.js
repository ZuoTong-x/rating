import { asyncRoute } from "./async-route.js";

export function registerScorerTaskListRoutes(app, tasks, setShortApiCache) {
  app.get("/api/tasks/assigned/options", asyncRoute(async (req, res) => {
    setShortApiCache(res);
    res.json(await tasks.assignedTaskOptions({ scorer: req.auth.username }));
  }));
  app.get("/api/tasks/assigned", asyncRoute(async (req, res) => {
    setShortApiCache(res);
    res.json(await tasks.listAssignedTasks({ ...req.query, scorer: req.auth.username }));
  }));
  app.get("/api/scorer/dashboard", asyncRoute(async (req, res) => {
    setShortApiCache(res);
    res.json(await tasks.getScorerDashboard({ ...req.query, scorer: req.auth.username }));
  }));
}

export function registerScorerTaskDetailRoutes(app, tasks, requireScorer) {
  app.post("/api/tasks/:id/complete", requireScorer, asyncRoute(async (req, res) => {
    res.json({ task: await tasks.completeAssignedTask(req.params.id, {
      ...req.body,
      scorer: req.auth.username,
    }) });
  }));
  app.put("/api/tasks/:id/complete", requireScorer, asyncRoute(async (req, res) => {
    res.json({ task: await tasks.updateCompletedTask(req.params.id, {
      ...req.body,
      scorer: req.auth.username,
    }) });
  }));
  app.get("/api/tasks/:id", requireScorer, asyncRoute(async (req, res) => {
    res.json({ task: await tasks.getTaskDetail(req.params.id, {
      scorer: req.auth.username,
      claimToken: req.query.claimToken,
    }) });
  }));
  app.post("/api/tasks/:id/release", requireScorer, asyncRoute(async (req, res) => {
    res.json(await tasks.releaseTaskClaim(req.params.id, req.auth.username, req.body?.claimToken));
  }));
}
