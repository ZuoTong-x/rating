import type { Express, Request } from "express";
import { asyncRoute } from "./async-route.ts";

type SystemRouteServices = {
  systemService: { getSystemStatus(): Promise<unknown> };
  logService: { listLogs(query: Request["query"]): Promise<unknown> };
};

export function registerAdminSystemRoutes(app: Express, { systemService, logService }: SystemRouteServices) {
  app.get("/api/admin/system/status", asyncRoute(async (_req, res) => {
    res.json(await systemService.getSystemStatus());
  }));
  app.get("/api/admin/logs", asyncRoute(async (req, res) => {
    res.json(await logService.listLogs(req.query));
  }));
}
