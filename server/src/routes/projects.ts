import type { Express, Request, RequestHandler } from "express";
import { asyncRoute } from "./async-route.ts";
import { requestUser, type AuthenticatedUser } from "./authenticated-request.ts";

type Project = { _id: string; tasksLocked?: boolean };
type ProjectRoutesService = {
  listVisibleProjects(user: AuthenticatedUser, query: Request["query"]): Promise<unknown>;
  getProjectOrThrow(id: string): Promise<Project>;
  canScorerAccessProject(id: string, username: string): Promise<unknown>;
  httpError(status: number, message: string): Error;
  projectDto(project: Project): unknown | Promise<unknown>;
  createProject(body: unknown): Promise<unknown>;
  updateProject(id: string, body: unknown): Promise<unknown>;
  updateProjectTaskLock(id: string, locked: unknown): Promise<unknown>;
  deleteProject(id: string): Promise<unknown>;
};

export function registerProjectRoutes(app: Express, projects: ProjectRoutesService, requireAdmin: RequestHandler) {
  app.get("/api/projects", asyncRoute(async (req, res) => {
    res.json(await projects.listVisibleProjects(requestUser(req), req.query));
  }));

  app.get("/api/projects/:id", asyncRoute(async (req, res) => {
    const project = await projects.getProjectOrThrow(req.params.id);
    const user = requestUser(req);
    if (user.role !== "admin") {
      if (project.tasksLocked) throw projects.httpError(403, "该项目任务尚未开放");
      const allowed = await projects.canScorerAccessProject(project._id, user.username);
      if (!allowed) throw projects.httpError(403, "无权访问该项目");
    }
    res.json({ project: await projects.projectDto(project) });
  }));

  app.post("/api/projects", requireAdmin, asyncRoute(async (req, res) => {
    res.status(201).json({ project: await projects.createProject(req.body) });
  }));

  app.patch("/api/projects/:id", requireAdmin, asyncRoute(async (req, res) => {
    res.json({ project: await projects.updateProject(req.params.id, req.body) });
  }));

  app.patch("/api/projects/:id/task-lock", requireAdmin, asyncRoute(async (req, res) => {
    res.json({ project: await projects.updateProjectTaskLock(req.params.id, req.body?.locked) });
  }));

  app.delete("/api/projects/:id", requireAdmin, asyncRoute(async (req, res) => {
    res.json(await projects.deleteProject(req.params.id));
  }));
}
