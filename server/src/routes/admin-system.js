import { asyncRoute } from "./async-route.js";

export function registerAdminSystemRoutes(app, { systemService, logService }) {
  app.get("/api/admin/system/status", asyncRoute(async (_req, res) => {
    res.json(await systemService.getSystemStatus());
  }));
  app.get("/api/admin/logs", asyncRoute(async (req, res) => {
    res.json(await logService.listLogs(req.query));
  }));
}
