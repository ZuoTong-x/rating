import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { db as database } from "../postgres.ts";

type Statement = ReturnType<typeof database.prepare>;
type AccessUser = { role?: string; username?: string } | null | undefined;

type AccessDependencies = {
  db: typeof database;
  httpError: (status: number, message: string) => Error;
  selectProjectByIdStmt: Statement;
  selectSubjectByIdStmt: Statement;
  selectSubjectsStmt: Statement;
  taskVersion: string;
  cleanRelative: (value: string) => string;
  imageExts: Set<string>;
  getProjectOrThrow: (id: string) => Promise<{ _id: string }>;
};

export function createAccessService({
  db, httpError, selectProjectByIdStmt, selectSubjectByIdStmt,
  selectSubjectsStmt, taskVersion, cleanRelative, imageExts,
  getProjectOrThrow,
}: AccessDependencies) {
  async function assertSubjectAccess(subjectId: string, user: AccessUser) {
    const project = await selectProjectByIdStmt.get(subjectId);
    if (!project) {
      const subject = await selectSubjectByIdStmt.get(subjectId);
      if (!subject) throw httpError(404, "项目不存在");
      if (user?.role === "admin") return subject;
      const assignedToPackage = await db
        .prepare(
          `SELECT 1 FROM rating_tasks
           JOIN projects ON projects.id = rating_tasks.projectId
           WHERE rating_tasks.subjectId = ?
             AND rating_tasks.scorer = ?
             AND rating_tasks.status IN ('assigned', 'completed')
             AND projects.tasksLocked = false
             AND projects.deletionRequestedAt IS NULL
           LIMIT 1`,
        )
        .get(subjectId, user?.username || "");
      if (!assignedToPackage) throw httpError(403, "无权访问该项目");
      return subject;
    }
    if (user?.role === "admin") return project;
    if (project.tasksLocked) throw httpError(403, "该项目任务尚未开放");

    const assigned = await db
      .prepare(
        `SELECT 1 FROM rating_tasks
         WHERE projectId = ? AND scorer = ? AND status IN ('assigned', 'completed')
         LIMIT 1`,
      )
      .get(subjectId, user?.username || "");
    if (!assigned) throw httpError(403, "无权访问该项目");
    return project;
  }

  async function listVisibleSubjects(user: AccessUser) {
    if (user?.role === "admin") return await selectSubjectsStmt.all();
    return await db
      .prepare(
        `SELECT DISTINCT
           subjects.id AS _id,
           subjects.name,
           subjects.originalFilename,
           subjects.importBatch,
           subjects.storageRoot,
           subjects.imageCount,
           subjects.categoryCount,
           subjects.status,
           subjects.taskStatus,
           subjects.deletionRequestedAt,
           subjects.createdAt,
           subjects.updatedAt
         FROM subjects
         JOIN rating_tasks ON rating_tasks.subjectId = subjects.id
         JOIN projects ON projects.id = rating_tasks.projectId
         WHERE subjects.deletionRequestedAt IS NULL
           AND projects.tasksLocked = false
           AND projects.deletionRequestedAt IS NULL
           AND rating_tasks.taskVersion = ?
           AND rating_tasks.scorer = ?
           AND rating_tasks.status IN ('assigned', 'completed')
         ORDER BY subjects.createdAt DESC`,
      )
      .all(taskVersion, user?.username || "");
  }

  function ensureFileAccess(req: Request, _res: Response, next: NextFunction) {
    let storagePath: string;
    try {
      storagePath = cleanRelative(decodeURIComponent(req.path));
    } catch {
      return next(httpError(400, "图片路径不正确"));
    }
    if (!storagePath || storagePath.startsWith("_")) {
      return next(httpError(404, "文件不存在"));
    }
    if (!imageExts.has(path.extname(storagePath).toLowerCase())) {
      return next(httpError(404, "文件不存在"));
    }
    return next();
  }

  async function parseProjectId(value: unknown) {
    const text = String(value ?? "").trim();
    if (!text) throw httpError(400, "请选择项目");
    return (await getProjectOrThrow(text))._id;
  }

  return { assertSubjectAccess, listVisibleSubjects, ensureFileAccess, parseProjectId };
}
