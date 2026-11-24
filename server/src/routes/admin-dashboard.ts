import type { Express, Request } from "express";
import { asyncRoute } from "./async-route.ts";

type DashboardRouteService = {
  listAdminDashboard(query: Request["query"]): Promise<unknown>;
  getDashboardStats(): Promise<unknown>;
  getDashboardProjectSection(query: Request["query"]): Promise<unknown>;
  getDashboardCharts(): Promise<unknown>;
  getDashboardAverageDuration(): Promise<unknown>;
  getDashboardWorkloadSection(query: Request["query"]): Promise<unknown>;
};

export function registerAdminDashboardRoutes(app: Express, service: DashboardRouteService) {
  app.get("/api/admin/dashboard", asyncRoute(async (req, res) => {
    res.json(await service.listAdminDashboard(req.query));
  }));
  app.get("/api/admin/dashboard/stats", asyncRoute(async (_req, res) => {
    res.json(await service.getDashboardStats());
  }));
  app.get("/api/admin/dashboard/project-summary", asyncRoute(async (req, res) => {
    res.json(await service.getDashboardProjectSection(req.query));
  }));
  app.get("/api/admin/dashboard/charts", asyncRoute(async (_req, res) => {
    res.json(await service.getDashboardCharts());
  }));
  app.get("/api/admin/dashboard/average-duration", asyncRoute(async (_req, res) => {
    res.json(await service.getDashboardAverageDuration());
  }));
  app.get("/api/admin/dashboard/workload", asyncRoute(async (req, res) => {
    res.json(await service.getDashboardWorkloadSection(req.query));
  }));
}
