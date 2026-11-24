import type { Express, Request, RequestHandler, Response } from "express";
import type { db as database } from "../postgres.ts";
import { requestUser, type AuthenticatedUser } from "./authenticated-request.ts";

type Statement = ReturnType<typeof database.prepare>;
type Row = Record<string, unknown>;
type CatalogRoutesService = {
  listVisibleSubjects(user: AuthenticatedUser): Promise<Row[]>;
  subjectDto(row: Row): unknown;
  httpError(status: number, message: string): Error;
  assertSubjectAccess(id: string, user: AuthenticatedUser): Promise<unknown>;
  getCategories(subjectId: unknown): Promise<unknown>;
  getScorers(subjectId: unknown): Promise<unknown>;
  listImages(query: Request["query"]): Promise<unknown>;
  setShortApiCache(res: Response): void;
};
type CatalogMutationService = {
  selectSubjectByIdStmt: Statement;
  assertPackageCanBeDeleted(id: string): Promise<void>;
  markSubjectForDeletionStmt: Statement;
  subjectDto(row: Row): unknown;
  queueSubjectDeletion(id: string): void;
  selectImageByIdStmt: Statement;
  selectAssignedTaskForImageStmt: Statement;
  httpError(status: number, message: string): Error;
  normalizeScorePayload(body: Row): Row;
  updateImageScoreStmt: Statement;
  imageDto(row: Row | undefined): unknown;
};

export function registerCatalogRoutes(app: Express, services: CatalogRoutesService) {
  const {
    listVisibleSubjects, subjectDto, httpError, assertSubjectAccess,
    getCategories, getScorers, listImages, setShortApiCache,
  } = services;

  app.get("/api/subjects", async (req, res, next) => {
    try {
      res.json((await listVisibleSubjects(requestUser(req))).map(subjectDto));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/categories", async (req, res, next) => {
    try {
      if (requestUser(req).role !== "admin" && !req.query.subjectId)
        throw httpError(400, "请选择项目");
      if (req.query.subjectId)
        await assertSubjectAccess(String(req.query.subjectId), requestUser(req));
      res.json(await getCategories(req.query.subjectId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/scorers", async (req, res, next) => {
    try {
      if (requestUser(req).role !== "admin" && !req.query.subjectId)
        throw httpError(400, "请选择项目");
      if (req.query.subjectId)
        await assertSubjectAccess(String(req.query.subjectId), requestUser(req));
      res.json(await getScorers(req.query.subjectId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/images", async (req, res, next) => {
    try {
      if (requestUser(req).role !== "admin" && !req.query.subjectId)
        throw httpError(400, "请选择项目");
      if (req.query.subjectId)
        await assertSubjectAccess(String(req.query.subjectId), requestUser(req));
      setShortApiCache(res);
      res.json(await listImages(req.query));
    } catch (error) {
      next(error);
    }
  });
}

export function registerCatalogMutationRoutes(app: Express, services: CatalogMutationService, requireAdmin: RequestHandler) {
  const {
    selectSubjectByIdStmt, assertPackageCanBeDeleted, markSubjectForDeletionStmt,
    subjectDto, queueSubjectDeletion, selectImageByIdStmt, selectAssignedTaskForImageStmt,
    httpError, normalizeScorePayload, updateImageScoreStmt, imageDto,
  } = services;

app.delete("/api/subjects/:id", requireAdmin, async (req, res, next) => {
  try {
    const subject = await selectSubjectByIdStmt.get(req.params.id);
    if (!subject) return res.status(404).json({ message: "项目不存在" });
    await assertPackageCanBeDeleted(String(subject._id));

    const requestedAt = new Date().toISOString();
    const result = await markSubjectForDeletionStmt.run({
      id: subject._id,
      deletionRequestedAt: requestedAt,
      updatedAt: requestedAt,
    });
    if (!result.changes) {
      return res.status(404).json({ message: "Subject no longer exists" });
    }

    res.status(202).json({
      subject: subjectDto({ ...subject, deletionRequestedAt: requestedAt }),
      deletedImages: subject.imageCount,
      queued: true,
    });
    queueSubjectDeletion(String(subject._id));
  } catch (error) {
    next(error);
  }
});

app.put("/api/images/:id/score", async (req, res, next) => {
  try {
    const current = await selectImageByIdStmt.get(req.params.id);
    if (!current) return res.status(404).json({ message: "图片不存在" });
    if (
      requestUser(req).role !== "admin" &&
      !(await selectAssignedTaskForImageStmt.get(requestUser(req).username, current.storagePath, current.storagePath))
    ) {
      throw httpError(403, "无权为该图片评分");
    }

    const score = normalizeScorePayload({
      ...(req.body || {}),
      scorer: requestUser(req).role === "scorer" ? requestUser(req).username : current.scorer,
    });
    await updateImageScoreStmt.run({
      id: req.params.id,
      ...score,
      scorer: score.scorer ?? current.scorer ?? null,
      updatedAt: score.ratedAt,
    });

    const updated = await selectImageByIdStmt.get(req.params.id);
    res.json(imageDto(updated));
  } catch (error) {
    next(error);
  }
});

}
