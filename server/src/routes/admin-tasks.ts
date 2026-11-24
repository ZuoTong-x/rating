import type { Express, Request, RequestHandler, Response } from "express";
import { registerTaskGenerationRoutes } from "./task-generation.ts";

type Project = { _id: string };
type GenerationJob = { subjectId: string };
type AdminTaskRoutesService = {
  getTaskReassignmentOptions(id: string): Promise<unknown>;
  reassignSubjectTasks(id: string, body: unknown): Promise<unknown>;
  getSubjectTaskReportSummary(id: string): Promise<unknown>;
  exportSubjectTaskReport(id: string, res: Response): Promise<void>;
  getProjectOrThrow(id: string): Promise<Project>;
  listSubjectTaskOptions(id: string): Promise<unknown>;
  projectDto(project: Project): Promise<unknown> | unknown;
  projectSubjectDto(project: Project, view: unknown): Promise<unknown> | unknown;
  listSubjectTasks(id: string, query: Request["query"]): Promise<Record<string, unknown>>;
  taskAllocationUpload: { single(fieldName: string): RequestHandler };
  parseTaskAllocationWorkbook(file: Express.Multer.File | undefined): Promise<unknown>;
  taskGenerationJobDto(job: GenerationJob): unknown;
  startSubjectTaskGeneration(id: string, body: unknown): Promise<GenerationJob>;
  startExactSubjectTaskGeneration(id: string, body: unknown, file: Express.Multer.File | undefined): Promise<GenerationJob>;
  exactTaskAssignmentUpload: { single(fieldName: string): RequestHandler };
  getTaskGenerationJob(id: string): Promise<GenerationJob | null | undefined>;
  httpError(status: number, message: string): Error;
  getTaskDetail(id: string, options: { projectId: string; includeAdminFields: boolean }): Promise<unknown>;
};

export function registerAdminTaskRoutes(app: Express, services: AdminTaskRoutesService, requireAdmin: RequestHandler) {
  const {
    getTaskReassignmentOptions, reassignSubjectTasks, getSubjectTaskReportSummary,
    exportSubjectTaskReport, getProjectOrThrow, listSubjectTaskOptions, projectDto,
    projectSubjectDto, listSubjectTasks, taskAllocationUpload, parseTaskAllocationWorkbook,
    taskGenerationJobDto, startSubjectTaskGeneration, startExactSubjectTaskGeneration,
    exactTaskAssignmentUpload, getTaskGenerationJob, httpError, getTaskDetail,
  } = services;

app.get(
  "/api/subjects/:id/tasks/reassignment-options",
  requireAdmin,
  async (req, res, next) => {
    try {
      res.json(await getTaskReassignmentOptions(req.params.id));
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/subjects/:id/tasks/reassign",
  requireAdmin,
  async (req, res, next) => {
    try {
      res.json(await reassignSubjectTasks(req.params.id, req.body));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/subjects/:id/tasks/report",
  requireAdmin,
  async (req, res, next) => {
    try {
      res.json(await getSubjectTaskReportSummary(req.params.id));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/subjects/:id/tasks/report/export",
  requireAdmin,
  async (req, res, next) => {
    try {
      await exportSubjectTaskReport(req.params.id, res);
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/subjects/:id/tasks/options",
  requireAdmin,
  async (req, res, next) => {
    try {
      await getProjectOrThrow(req.params.id);
      res.json(await listSubjectTaskOptions(req.params.id));
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/projects/:id/tasks", requireAdmin, async (req, res, next) => {
  try {
    const project = await getProjectOrThrow(req.params.id);
    const projectView = await projectDto(project);
    res.json({
      subject: await projectSubjectDto(project, projectView),
      project: projectView,
      ...(await listSubjectTasks(req.params.id, req.query)),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/options", requireAdmin, async (req, res, next) => {
  try {
    await getProjectOrThrow(req.params.id);
    res.json(await listSubjectTaskOptions(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/reassignment-options", requireAdmin, async (req, res, next) => {
  try {
    res.json(await getTaskReassignmentOptions(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/projects/:id/tasks/allocations/import",
  requireAdmin,
  taskAllocationUpload.single("file"),
  async (req, res, next) => {
    try {
      await getProjectOrThrow(req.params.id);
      res.json(await parseTaskAllocationWorkbook(req.file));
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/projects/:id/tasks/reassign", requireAdmin, async (req, res, next) => {
  try {
    res.json(await reassignSubjectTasks(req.params.id, req.body));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/report", requireAdmin, async (req, res, next) => {
  try {
    res.json(await getSubjectTaskReportSummary(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/report/export", requireAdmin, async (req, res, next) => {
  try {
    await exportSubjectTaskReport(req.params.id, res);
  } catch (error) {
    next(error);
  }
});

registerTaskGenerationRoutes(app, {
  taskGenerationJobDto,
  startSubjectTaskGeneration,
  startExactSubjectTaskGeneration,
  exactTaskAssignmentUpload,
  getTaskGenerationJob,
  httpError,
}, requireAdmin);

app.get("/api/projects/:id/tasks/:taskId", requireAdmin, async (req, res, next) => {
  try {
    res.json({
      task: await getTaskDetail(req.params.taskId, {
        projectId: req.params.id,
        includeAdminFields: true,
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/subjects/:id/tasks/:taskId",
  requireAdmin,
  async (req, res, next) => {
    try {
      res.json({
        task: await getTaskDetail(req.params.taskId, {
          projectId: req.params.id,
          includeAdminFields: true,
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/subjects/:id/tasks", requireAdmin, async (req, res, next) => {
  try {
    const project = await getProjectOrThrow(req.params.id);
    const projectView = await projectDto(project);
    res.json({
      subject: await projectSubjectDto(project, projectView),
      project: projectView,
      ...(await listSubjectTasks(req.params.id, req.query)),
    });
  } catch (error) {
    next(error);
  }
});

}
