import { asyncRoute } from "./async-route.js";

export function registerAdminThumbnailRoutes(app, service) {
  app.get("/api/admin/thumbnails", asyncRoute(async (req, res) => {
    res.json(await service.getOverview(req.query));
  }));
  app.patch("/api/admin/thumbnails/settings", asyncRoute(async (req, res) => {
    const settings = await service.updateSettings(req.body || {}, req.auth?.username);
    res.json({ settings });
  }));
  app.get("/api/admin/thumbnails/completed-candidates", asyncRoute(async (_req, res) => {
    res.json({ packages: await service.getCompletedCandidates() });
  }));
  app.post("/api/admin/thumbnails/disable-completed", asyncRoute(async (req, res) => {
    res.json(await service.disableCompletedPackages(req.body?.subjectIds, req.auth?.username));
  }));
  app.patch("/api/admin/thumbnails/packages/:subjectId", asyncRoute(async (req, res) => {
    const control = await service.updatePackageControl(
      String(req.params.subjectId || ""),
      req.body || {},
      req.auth?.username,
    );
    res.json({ control });
  }));
  app.post("/api/admin/thumbnails/packages/:subjectId/retry-failed", asyncRoute(async (req, res) => {
    res.json(await service.retryPackageFailed(String(req.params.subjectId || "")));
  }));
  app.post("/api/admin/thumbnails/retry-failed", asyncRoute(async (_req, res) => {
    res.json(await service.retryAllFailed());
  }));
}
