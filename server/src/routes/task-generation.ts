import type { Express, RequestHandler } from "express";
import { asyncRoute } from "./async-route.ts";

type GenerationJob = { subjectId: string };
type GenerationRoutesService = {
  taskGenerationJobDto(job: GenerationJob): unknown;
  startSubjectTaskGeneration(projectId: string, body: unknown): Promise<GenerationJob>;
  startExactSubjectTaskGeneration(projectId: string, body: unknown, file: Express.Multer.File | undefined): Promise<GenerationJob>;
  getTaskGenerationJob(jobId: string): Promise<GenerationJob | null | undefined>;
  exactTaskAssignmentUpload: { single(fieldName: string): RequestHandler };
  httpError(status: number, message: string): Error;
};

export function registerTaskGenerationRoutes(app: Express, generation: GenerationRoutesService, requireAdmin: RequestHandler) {
  app.post("/api/projects/:id/tasks/generate", requireAdmin, asyncRoute(async (req, res) => {
    res.status(202).json(generation.taskGenerationJobDto(
      await generation.startSubjectTaskGeneration(req.params.id, req.body),
    ));
  }));

  app.post(
    "/api/projects/:id/tasks/generate/exact",
    requireAdmin,
    generation.exactTaskAssignmentUpload.single("file"),
    asyncRoute(async (req, res) => {
      res.status(202).json(generation.taskGenerationJobDto(
        await generation.startExactSubjectTaskGeneration(req.params.id, req.body, req.file),
      ));
    }),
  );

  app.get("/api/projects/:id/tasks/generate/:jobId", requireAdmin, asyncRoute(async (req, res) => {
    const job = await generation.getTaskGenerationJob(req.params.jobId);
    if (!job || job.subjectId !== req.params.id) {
      throw generation.httpError(404, "任务生成作业不存在或已过期");
    }
    res.json(generation.taskGenerationJobDto(job));
  }));
}
