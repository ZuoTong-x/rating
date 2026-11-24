import type { Express, Request } from "express";
import { asyncRoute } from "./async-route.ts";

type ThumbnailRoutesService = {
  getOverview(query: Request["query"]): Promise<unknown>;
  updateSettings(body: unknown, username?: string): Promise<unknown>;
  getCompletedCandidates(): Promise<unknown>;
  disableCompletedPackages(subjectIds: unknown, username?: string): Promise<unknown>;
  updatePackageControl(subjectId: string, body: unknown, username?: string): Promise<unknown>;
  retryPackageFailed(subjectId: string): Promise<unknown>;
  retryAllFailed(): Promise<unknown>;
};

function actorUsername(req: Request): string | undefined {
  return (req as Request & { auth?: { username?: string } }).auth?.username;
}

export function registerAdminThumbnailRoutes(app: Express, service: ThumbnailRoutesService) {
  app.get("/api/admin/thumbnails", asyncRoute(async (req, res) => {
    res.json(await service.getOverview(req.query));
  }));
  app.patch("/api/admin/thumbnails/settings", asyncRoute(async (req, res) => {
    const settings = await service.updateSettings(req.body || {}, actorUsername(req));
    res.json({ settings });
  }));
  app.get("/api/admin/thumbnails/completed-candidates", asyncRoute(async (_req, res) => {
    res.json({ packages: await service.getCompletedCandidates() });
  }));
  app.post("/api/admin/thumbnails/disable-completed", asyncRoute(async (req, res) => {
    res.json(await service.disableCompletedPackages(req.body?.subjectIds, actorUsername(req)));
  }));
  app.patch("/api/admin/thumbnails/packages/:subjectId", asyncRoute(async (req, res) => {
    const control = await service.updatePackageControl(
      String(req.params.subjectId || ""),
      req.body || {},
      actorUsername(req),
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
