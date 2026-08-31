import "dotenv/config";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express from "express";
import cors from "cors";
import multer from "multer";
import ExcelJS from "exceljs";
import iconv from "iconv-lite";
import sharp from "sharp";
import yauzl from "yauzl";
import {
  createThumbnail,
  thumbnailStoragePath,
  uploadFilePath,
} from "./image-assets.js";
import {
  db,
  imageSelectColumns,
  scoreFilterKeys,
  scoreNumericFields,
  skippableScoreFields,
  projectSelectColumns,
  subjectSelectColumns,
  userSelectColumns,
  runWithDatabaseContext,
} from "./postgres.js";
import { createAdminDashboardService } from "./services/admin-dashboard.js";
import { createAdminScoringService } from "./services/admin-scoring.js";

const app = express();
const taskImageSelectColumns =
  "id AS _id, subjectId, filename, originalPath, storagePath, thumbnailPath, category, directory, isInfographic, prompt";
const taskListImageSelectColumns =
  "id AS _id, filename, storagePath, thumbnailPath";
const imageListSelectColumns =
  "id AS _id, subjectId, filename, storagePath, thumbnailPath, category, directory, isInfographic";
const uploadDir = path.resolve(process.env.UPLOAD_DIR || "uploads");
const zipUploadDir = path.join(uploadDir, "_zips");
const chunkUploadDir = path.join(uploadDir, "_chunks");
const resumableUploadDir = path.join(uploadDir, "_resumable");
const feedbackUploadDir = path.join(uploadDir, "feedback");
const imageExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const feedbackImageExts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const tusVersion = "1.0.0";
const resumableUploadExpiryMs = 24 * 60 * 60 * 1000;
const resumableUploadMaxChunkBytes = 16 * 1024 * 1024;
const taskTemplateRoles = new Set([
  "target",
  "filler",
  "anchor_low",
  "anchor_high",
  "boundary",
]);

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(zipUploadDir, { recursive: true });
await fs.mkdir(chunkUploadDir, { recursive: true });
await fs.mkdir(resumableUploadDir, { recursive: true });
await fs.mkdir(feedbackUploadDir, { recursive: true });

const corsOrigin = process.env.CORS_ORIGIN?.trim();
app.use(
  cors({
    origin: corsOrigin || false,
    credentials: true,
    exposedHeaders: [
      "Location",
      "Upload-Length",
      "Upload-Metadata",
      "Upload-Offset",
      "Upload-Expires",
      "Tus-Resumable",
      "Tus-Version",
      "Tus-Extension",
      "Tus-Max-Size",
    ],
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use((_req, _res, next) => runWithDatabaseContext(() => next()));

function positiveLimit(name, fallback) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

function setShortApiCache(res) {
  res.setHeader("Cache-Control", "private, max-age=2, stale-while-revalidate=2");
  res.setHeader("Vary", "Cookie");
}

const maxZipBytes = positiveLimit("MAX_ZIP_BYTES", 1024 * 1024 * 1024 * 100)
const maxArchiveEntries = positiveLimit("MAX_ARCHIVE_ENTRIES", 50000);
const maxArchiveUncompressedBytes = positiveLimit(
  "MAX_ARCHIVE_UNCOMPRESSED_BYTES",
  20 * 1024 * 1024 * 1024,
);
const maxImageUncompressedBytes = positiveLimit(
  "MAX_IMAGE_UNCOMPRESSED_BYTES",
  128 * 1024 * 1024,
);
const maxChunkCount = positiveLimit("MAX_CHUNK_COUNT", 10000);
const imageImportConcurrency = Math.min(
  16,
  Math.max(1, Math.floor(positiveLimit("IMAGE_IMPORT_CONCURRENCY", 4))),
);

const upload = multer({
  dest: zipUploadDir,
  limits: { fileSize: maxZipBytes },
});

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, callback) {
      let destination;
      try {
        destination = chunkDir(req.params.uploadId);
      } catch (error) {
        callback(error);
        return;
      }
      fs.mkdir(destination, { recursive: true })
        .then(() => callback(null, destination))
        .catch(callback);
    },
    filename(req, _file, callback) {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0 || index >= maxChunkCount) {
        callback(httpError(400, "分片序号不正确"));
        return;
      }
      callback(null, `${String(index).padStart(6, "0")}.part`);
    },
  }),
  // 保留足够的 multipart 边界余量，前端单片为 12MB。
  limits: { fileSize: 16 * 1024 * 1024 },
});

const feedbackUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 5,
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter(_req, file, callback) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (
      !feedbackImageExts.has(ext) ||
      !String(file.mimetype || "").startsWith("image/")
    ) {
      callback(httpError(400, "反馈图片仅支持 JPG、PNG、WebP 格式"));
      return;
    }
    callback(null, true);
  },
});

const taskAllocationUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter(_req, file, callback) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".xlsx") {
      callback(httpError(400, "分配表仅支持 XLSX 文件"));
      return;
    }
    callback(null, true);
  },
});

const importJobs = new Map();
const taskGenerationJobs = new Map();
const activeTaskGenerationBySubject = new Map();
const sessionSeenWriteAt = new Map();
const subjectTaskReportCache = new Map();
const subjectTaskReportCacheTtlMs = 15 * 1000;
const sessionSeenWriteIntervalMs = 5 * 60 * 1000;
// Keep task generation transactions short so large jobs do not monopolize
// PostgreSQL connections for long stretches.
const TASK_WRITE_BATCH_SIZE = 100;
const TASK_ASSIGN_BATCH_SIZE = 100;
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;

function taskGenerationJobDto(job) {
  const payload = {
    jobId: job.jobId,
    subjectId: job.subjectId,
    projectId: job.subjectId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
  };
  if (job.result) payload.result = job.result;
  return payload;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

const insertSubjectStmt = db.prepare(`
  INSERT INTO subjects (id, name, originalFilename, importBatch, storageRoot, sourceZipPath, imageCount, categoryCount, status, createdAt, updatedAt)
  VALUES (@id, @name, @originalFilename, @importBatch, @storageRoot, @sourceZipPath, 0, 0, 'importing', @createdAt, @updatedAt)
`);

const updateSubjectCountsStmt = db.prepare(`
  UPDATE subjects
  SET imageCount = @imageCount,
      categoryCount = @categoryCount,
      status = @status,
      updatedAt = @updatedAt
  WHERE id = @id
`);

const selectSubjectByIdStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE id = ? AND deletionRequestedAt IS NULL`,
);
const selectSubjectPendingDeletionStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE id = ? AND deletionRequestedAt IS NOT NULL`,
);
const selectSubjectsStmt = db.prepare(
  `SELECT ${subjectSelectColumns}
   FROM subjects
   WHERE deletionRequestedAt IS NULL
   ORDER BY createdAt DESC`,
);
const selectProjectByIdStmt = db.prepare(`
  SELECT ${projectSelectColumns}
  FROM projects
  JOIN subjects ON subjects.id = projects.packageId
  WHERE projects.id = ?
    AND projects.deletionRequestedAt IS NULL
`);
const selectProjectByNameStmt = db.prepare(`
  SELECT id
  FROM projects
  WHERE deletionRequestedAt IS NULL
    AND LOWER(TRIM(name)) = LOWER(?)
  LIMIT 1
`);
const selectProjectsStmt = db.prepare(`
  SELECT ${projectSelectColumns}
  FROM projects
  JOIN subjects ON subjects.id = projects.packageId
  WHERE projects.deletionRequestedAt IS NULL
  ORDER BY projects.createdAt DESC, projects.id ASC
`);
const selectProjectPackagesStmt = db.prepare(`
  SELECT subjects.id AS _id,
         subjects.name,
         subjects.originalFilename,
         subjects.imageCount,
         subjects.categoryCount,
         subjects.status,
         subjects.createdAt,
         subjects.updatedAt,
         COUNT(subject_task_templates.id) AS taskTemplateCount
  FROM project_packages
  JOIN subjects ON subjects.id = project_packages.packageId
  LEFT JOIN subject_task_templates
    ON subject_task_templates.subjectId = subjects.id
  WHERE project_packages.projectId = ?
    AND subjects.deletionRequestedAt IS NULL
  GROUP BY project_packages.projectId,
           project_packages.packageId,
           project_packages.createdAt,
           subjects.id,
           subjects.name,
           subjects.originalFilename,
           subjects.imageCount,
           subjects.categoryCount,
           subjects.status,
           subjects.createdAt,
           subjects.updatedAt
  ORDER BY project_packages.createdAt ASC, subjects.createdAt ASC, subjects.id ASC
`);
const insertProjectStmt = db.prepare(`
  INSERT INTO projects (
    id, name, icon, packageId, taskStatus, createdAt, updatedAt
  ) VALUES (
    @id, @name, @icon, @packageId, 'task_pending', @createdAt, @updatedAt
  )
`);
const insertProjectPackageStmt = db.prepare(`
  INSERT INTO project_packages (projectId, packageId, createdAt)
  VALUES (@projectId, @packageId, @createdAt)
  ON CONFLICT DO NOTHING
`);
const deleteProjectPackagesStmt = db.prepare(
  "DELETE FROM project_packages WHERE projectId = ?",
);
const updateProjectStmt = db.prepare(`
  UPDATE projects
  SET name = @name,
      icon = @icon,
      packageId = @packageId,
      updatedAt = @updatedAt
  WHERE id = @id
    AND deletionRequestedAt IS NULL
`);
const updateProjectTaskStatusStmt = db.prepare(`
  UPDATE projects
  SET taskStatus = @taskStatus,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const selectProjectTaskCountStmt = db.prepare(
  "SELECT COUNT(*) AS total FROM rating_tasks WHERE projectId = ?",
);
const deleteUncompletedProjectTasksStmt = db.prepare(
  "DELETE FROM rating_tasks WHERE projectId = ? AND status <> 'completed'",
);
const deleteProjectUserLinksStmt = db.prepare(
  "DELETE FROM user_projects WHERE projectId = ?",
);
const deleteProjectStmt = db.prepare(
  "DELETE FROM projects WHERE id = ? AND deletionRequestedAt IS NULL",
);
const selectPackageProjectCountStmt = db.prepare(
  `SELECT COUNT(*) AS total
   FROM project_packages
   JOIN projects ON projects.id = project_packages.projectId
   WHERE project_packages.packageId = ?
     AND projects.deletionRequestedAt IS NULL`,
);
const selectTeamByIdStmt = db.prepare(
  "SELECT id, name, status, createdAt, updatedAt FROM teams WHERE id = ?",
);
const selectTeamByNameStmt = db.prepare(
  "SELECT id, name, status, createdAt, updatedAt FROM teams WHERE LOWER(name) = LOWER(?)",
);
const selectTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status, teams.createdAt, teams.updatedAt,
         COUNT(DISTINCT user_teams.userId) AS userCount,
         COUNT(DISTINCT project_teams.projectId) AS projectCount
  FROM teams
  LEFT JOIN user_teams ON user_teams.teamId = teams.id
  LEFT JOIN project_teams ON project_teams.teamId = teams.id
  GROUP BY teams.id
  ORDER BY LOWER(teams.name) ASC, teams.name ASC
`);
const insertTeamStmt = db.prepare(`
  INSERT INTO teams (id, name, status, createdAt, updatedAt)
  VALUES (@id, @name, 'enabled', @createdAt, @updatedAt)
`);
const updateTeamStmt = db.prepare(`
  UPDATE teams
  SET name = COALESCE(@name, name),
      status = COALESCE(@status, status),
      updatedAt = @updatedAt
  WHERE id = @id
`);
const deleteTeamStmt = db.prepare("DELETE FROM teams WHERE id = ?");
const selectTeamUsageStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM user_teams WHERE teamId = ?) AS userCount,
    (SELECT COUNT(*) FROM project_teams WHERE teamId = ?) AS projectCount
`);
const selectUserTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status
  FROM user_teams
  JOIN teams ON teams.id = user_teams.teamId
  WHERE user_teams.userId = ?
  ORDER BY LOWER(teams.name) ASC, teams.name ASC
`);
const selectDisabledTeamForUserStmt = db.prepare(`
  SELECT teams.id, teams.name
  FROM user_teams
  JOIN teams ON teams.id = user_teams.teamId
  WHERE user_teams.userId = ?
    AND teams.status = 'disabled'
  ORDER BY LOWER(teams.name) ASC, teams.name ASC
  LIMIT 1
`);
const deleteUserTeamsStmt = db.prepare("DELETE FROM user_teams WHERE userId = ?");
const insertUserTeamStmt = db.prepare(`
  INSERT INTO user_teams (userId, teamId, createdAt)
  VALUES (@userId, @teamId, @createdAt)
  ON CONFLICT DO NOTHING
`);
const selectProjectTeamsStmt = db.prepare(`
  SELECT teams.id, teams.name, teams.status
  FROM project_teams
  JOIN teams ON teams.id = project_teams.teamId
  WHERE project_teams.projectId = ?
  ORDER BY LOWER(teams.name) ASC, teams.name ASC
`);
const deleteProjectTeamsStmt = db.prepare("DELETE FROM project_teams WHERE projectId = ?");
const insertProjectTeamStmt = db.prepare(`
  INSERT INTO project_teams (projectId, teamId, createdAt)
  VALUES (@projectId, @teamId, @createdAt)
  ON CONFLICT DO NOTHING
`);
const selectImageByIdStmt = db.prepare(
  `SELECT ${imageSelectColumns} FROM images WHERE id = ?`,
);
const selectUserAuthByUsernameStmt = db.prepare(
  "SELECT id, username, password, role, status, lastLoginAt, createdAt, updatedAt FROM users WHERE username = ? AND role = 'admin'",
);
const selectScorerByUsernameStmt = db.prepare(
  "SELECT id, username, password, role, status, lastLoginAt, createdAt, updatedAt FROM users WHERE username = ? AND role = 'scorer'",
);
const selectAllScorerNamesStmt = db.prepare(`
  SELECT username
  FROM users
  WHERE role = 'scorer'
  ORDER BY LOWER(username) ASC, username ASC
`);
const selectUserByUsernameStmt = db.prepare(
  `SELECT ${userSelectColumns} FROM users WHERE username = ?`,
);
const selectUserByIdStmt = db.prepare(
  `SELECT ${userSelectColumns} FROM users WHERE id = ?`,
);
const selectScorerUserCountStmt = db.prepare(
  `SELECT COUNT(*) AS total
   FROM users
   WHERE role = 'scorer'`,
);
const insertSessionStmt = db.prepare(`
  INSERT INTO user_sessions (tokenHash, userId, expiresAt, createdAt, lastSeenAt)
  VALUES (@tokenHash, @userId, @expiresAt, @createdAt, @lastSeenAt)
`);
const selectSessionUserStmt = db.prepare(`
  SELECT users.id, users.username, users.role, users.status, users.lastLoginAt, users.createdAt, users.updatedAt
  FROM user_sessions
  JOIN users ON users.id = user_sessions.userId
  WHERE user_sessions.tokenHash = ?
    AND user_sessions.expiresAt > ?
`);
const updateSessionSeenStmt = db.prepare(
  "UPDATE user_sessions SET lastSeenAt = ? WHERE tokenHash = ?",
);
const deleteSessionStmt = db.prepare(
  "DELETE FROM user_sessions WHERE tokenHash = ?",
);
const deleteExpiredSessionsStmt = db.prepare(
  "DELETE FROM user_sessions WHERE expiresAt <= ?",
);
const insertImportJobStmt = db.prepare(`
  INSERT INTO import_jobs (
    uploadId, originalFilename, totalChunks, protocol, uploadLength, uploadOffset,
    metadata, status, stage, progress, message, resultJson, createdAt, updatedAt, expiresAt
  ) VALUES (
    @uploadId, @originalFilename, @totalChunks, @protocol, @uploadLength, @uploadOffset,
    @metadata, @status, @stage, @progress, @message, @resultJson, @createdAt, @updatedAt, @expiresAt
  )
`);
const updateImportJobStmt = db.prepare(`
  UPDATE import_jobs
  SET status = @status,
      stage = @stage,
      progress = @progress,
      message = @message,
      resultJson = @resultJson,
      protocol = @protocol,
      uploadLength = @uploadLength,
      uploadOffset = @uploadOffset,
      metadata = @metadata,
      updatedAt = @updatedAt,
      expiresAt = @expiresAt
  WHERE uploadId = @uploadId
`);
const selectImportJobStmt = db.prepare(
  "SELECT * FROM import_jobs WHERE uploadId = ?",
);
const deleteImportJobStmt = db.prepare(
  "DELETE FROM import_jobs WHERE uploadId = ?",
);
const deleteExpiredImportJobsStmt = db.prepare(
  "DELETE FROM import_jobs WHERE expiresAt <= ?",
);
const insertFeedbackStmt = db.prepare(`
  INSERT INTO feedbacks (
    id, title, type, description, imagePaths, status,
    submitter, submittedAt, reply, repliedBy, repliedAt, updatedAt
  ) VALUES (
    @id, @title, @type, @description, @imagePaths, 'pending',
    @submitter, @submittedAt, NULL, NULL, NULL, @updatedAt
  )
`);
const selectFeedbackByIdStmt = db.prepare(
  "SELECT * FROM feedbacks WHERE id = ?",
);
const selectFeedbackMessagesStmt = db.prepare(`
  SELECT id, feedbackId, author, authorRole, content, createdAt
  FROM feedback_messages
  WHERE feedbackId = ?
  ORDER BY createdAt ASC, id ASC
`);
const selectFeedbackMessageExistsStmt = db.prepare(
  "SELECT 1 FROM feedback_messages WHERE feedbackId = ? LIMIT 1",
);
const insertFeedbackMessageStmt = db.prepare(`
  INSERT INTO feedback_messages (id, feedbackId, author, authorRole, content, createdAt)
  VALUES (@id, @feedbackId, @author, @authorRole, @content, @createdAt)
`);
const updateFeedbackReplyStmt = db.prepare(`
  UPDATE feedbacks
  SET status = @status,
      reply = @reply,
      repliedBy = @repliedBy,
      repliedAt = @repliedAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const selectFeedbackImagePathsBySubmitterStmt = db.prepare(
  "SELECT imagePaths FROM feedbacks WHERE submitter = ?",
);
const selectAssignedTaskForImageStmt = db.prepare(`
  SELECT 1
  FROM rating_task_items
  JOIN rating_tasks ON rating_tasks.id = rating_task_items.taskId
  JOIN images ON images.id = rating_task_items.imageId
  WHERE rating_tasks.scorer = ?
    AND rating_tasks.status IN ('assigned', 'completed')
    AND (images.storagePath = ? OR images.thumbnailPath = ?)
  LIMIT 1
`);
const selectScorerUsersPageStmt = db.prepare(`
  SELECT ${userSelectColumns}
  FROM users
  WHERE role = 'scorer'
  ORDER BY createdAt DESC, LOWER(username) ASC, username ASC
  LIMIT ? OFFSET ?
`);
const updateUserLoginStmt = db.prepare(`
  UPDATE users
  SET lastLoginAt = @lastLoginAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);
const insertScorerUserStmt = db.prepare(`
  INSERT INTO users (id, username, password, role, status, lastLoginAt, createdAt, updatedAt)
  VALUES (@id, @username, @password, 'scorer', 'enabled', @lastLoginAt, @createdAt, @updatedAt)
`);
const updateScorerUserStmt = db.prepare(`
  UPDATE users
  SET password = COALESCE(@password, password),
      status = COALESCE(@status, status),
      updatedAt = @updatedAt
  WHERE id = @id
    AND role = 'scorer'
`);
const deleteScorerUserStmt = db.prepare(
  "DELETE FROM users WHERE id = ? AND role = 'scorer'",
);
const selectAssignedTaskCountByScorerStmt = db.prepare(
  "SELECT COUNT(*) AS total FROM rating_tasks WHERE scorer = ? AND status = 'assigned'",
);
const taskVersion = "v3";
const taskCriteria = [
  "overall",
  "creativity",
  "mood",
  "composition",
  "color",
  "lighting",
  "realism",
  "detail",
  "promptAlignment",
  "textCorrectness",
  "anatomyNormality",
  "informationClarity",
  "designQuality",
  "typography",
];
const taskExclusionCriteria = new Set([
  "realism",
  "textCorrectness",
  "anatomyNormality",
]);
const taskCorrectnessCriteria = new Set([
  "textCorrectness",
  "anatomyNormality",
]);
const taskCriterionLabels = {
  overall: "整体美感总分",
  creativity: "辨识度与创意感",
  mood: "情绪与意境传达",
  composition: "构图与视觉层级",
  color: "色彩配比",
  lighting: "光照/光影",
  realism: "（肖像/摄像）真实感",
  detail: "细节与逻辑分辨率",
  discomfort: "不舒适",
  promptAlignment: "Prompt alignment",
  textCorrectness: "文字：正确性",
  anatomyNormality: "肢体：正常性",
  informationClarity: "信息传达是否突出/明确",
  designQuality: "整体设计感",
  typography: "文字设计感",
};

const selectTaskRowsPageStmt = db.prepare(`
  SELECT id, subjectId, projectId, taskVersion, taskType, status, scorer, ranking, excludedImageIds, correctImageIds, rankingRelations,
         submissionMode, rankingActionCount, startedAt, completedAt, durationMs, editedAt, editCount,
         rollbackCount, lastRolledBackAt, lastRolledBackBy, imageKey, createdAt, updatedAt
  FROM rating_tasks
  WHERE projectId = ? AND taskVersion = ?
  ORDER BY taskType ASC, createdAt ASC, id ASC
  LIMIT ? OFFSET ?
`);
const selectAssignedTaskRowsPageStmt = db.prepare(`
  SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId, rating_tasks.taskVersion,
         rating_tasks.taskType, rating_tasks.status, rating_tasks.scorer, rating_tasks.ranking, rating_tasks.excludedImageIds, rating_tasks.correctImageIds, rating_tasks.rankingRelations,
         rating_tasks.submissionMode, rating_tasks.rankingActionCount,
         rating_tasks.startedAt, rating_tasks.completedAt, rating_tasks.durationMs, rating_tasks.editedAt, rating_tasks.editCount,
         rating_tasks.rollbackCount, rating_tasks.lastRolledBackAt, rating_tasks.lastRolledBackBy,
         rating_tasks.imageKey, rating_tasks.createdAt, rating_tasks.updatedAt,
         projects.name AS subjectName
  FROM rating_tasks
  JOIN projects ON projects.id = rating_tasks.projectId
  WHERE rating_tasks.taskVersion = ?
    AND rating_tasks.scorer = ?
    AND rating_tasks.status = 'assigned'
    AND (?::text IS NULL OR rating_tasks.projectId = ?)
  ORDER BY rating_tasks.updatedAt DESC, rating_tasks.id ASC
  LIMIT ? OFFSET ?
`);
const selectAssignedTaskCountStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM rating_tasks
  WHERE taskVersion = ?
    AND scorer = ?
    AND status = 'assigned'
    AND (?::text IS NULL OR projectId = ?)
`);
const selectScorerTaskStatsStmt = db.prepare(`
  SELECT
    COALESCE(SUM(assigned), 0) AS pendingTasks,
    COALESCE(SUM(completed), 0) AS completedTasks
  FROM scorer_task_stats
  WHERE taskVersion = ?
    AND scorer = ?
    AND (?::text IS NULL OR projectId = ?)
`);
const selectScorerProjectCountStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM scorer_task_stats
  WHERE taskVersion = ?
    AND scorer = ?
    AND projectId <> ''
    AND (assigned + completed) > 0
`);
const selectTaskByIdStmt = db.prepare(`
  SELECT id, subjectId, projectId, taskVersion, taskType, status, scorer, ranking, excludedImageIds, correctImageIds, rankingRelations,
         submissionMode, rankingActionCount, startedAt, completedAt, durationMs, editedAt, editCount,
         rollbackCount, lastRolledBackAt, lastRolledBackBy, imageKey, createdAt, updatedAt
  FROM rating_tasks
  WHERE id = ?
`);
const selectTaskImageIdsStmt = db.prepare(`
  SELECT imageId
  FROM rating_task_items
  WHERE taskId = ?
  ORDER BY position ASC, imageId ASC
`);
const completeAssignedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET status = 'completed',
      ranking = @ranking,
      excludedImageIds = @excludedImageIds,
      correctImageIds = @correctImageIds,
      rankingRelations = @rankingRelations,
      submissionMode = @submissionMode,
      rankingActionCount = @rankingActionCount,
      startedAt = @startedAt,
      completedAt = @completedAt,
      durationMs = @durationMs,
      updatedAt = @updatedAt
  WHERE id = @id
    AND status = 'assigned'
    AND scorer = @scorer
`);
const updateCompletedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET ranking = @ranking,
      excludedImageIds = @excludedImageIds,
      correctImageIds = @correctImageIds,
      rankingRelations = @rankingRelations,
      submissionMode = @submissionMode,
      rankingActionCount = @rankingActionCount,
      editedAt = @editedAt,
      editCount = COALESCE(editCount, 0) + 1,
      updatedAt = @updatedAt
  WHERE id = @id
    AND status = 'completed'
    AND scorer = @scorer
`);
const insertRatingTaskStmt = db.prepare(`
  INSERT INTO rating_tasks (
    id, subjectId, projectId, taskVersion, round, taskType, status, scorer, ranking, assignmentKey, imageKey, createdAt, updatedAt
  ) VALUES (
    @id, @subjectId, @projectId, @taskVersion, @round, @taskType, 'pending', NULL, NULL, @assignmentKey, @imageKey, @createdAt, @updatedAt
  )
  ON CONFLICT DO NOTHING
`);
const insertRatingTaskItemStmt = db.prepare(`
  INSERT INTO rating_task_items (taskId, imageId, position, role)
  VALUES (@taskId, @imageId, @position, @role)
  ON CONFLICT DO NOTHING
`);
const insertSubjectTaskTemplateStmt = db.prepare(`
  INSERT INTO subject_task_templates (
    id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey, createdAt
  ) VALUES (
    @id, @subjectId, @sourceTaskId, @round, @criterion, @imageKey, @selectionKey, @createdAt
  )
`);
const insertSubjectTaskTemplateItemStmt = db.prepare(`
  INSERT INTO subject_task_template_items (templateId, imageId, position, role)
  VALUES (@templateId, @imageId, @position, @role)
`);
const selectSubjectTaskTemplatesStmt = db.prepare(`
  SELECT id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey
  FROM subject_task_templates
  WHERE subjectId = ?
  ORDER BY selectionKey ASC, id ASC
`);
const updateSubjectTaskStatusStmt = db.prepare(`
  UPDATE projects
  SET taskStatus = @taskStatus, updatedAt = @updatedAt
  WHERE id = @id
`);
const selectProjectTaskStatsStmt = db.prepare(`
  SELECT total, pending, assigned, completed
  FROM project_task_stats
  WHERE projectId = ? AND taskVersion = ?
`);
const selectPendingProjectTaskIdsStmt = db.prepare(`
  SELECT id
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'pending'
    AND scorer IS NULL
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const selectSubjectScorerNamesStmt = db.prepare(`
  SELECT DISTINCT scorer
  FROM rating_tasks
  WHERE projectId = ?
    AND scorer IS NOT NULL
    AND TRIM(scorer) <> ''
`);
const selectSubjectAssignedScorerCountsStmt = db.prepare(`
  SELECT scorer, COUNT(*) AS taskCount
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'assigned'
    AND scorer IS NOT NULL
    AND TRIM(scorer) <> ''
  GROUP BY scorer
  ORDER BY LOWER(scorer) ASC, scorer ASC
`);
const selectAvailableSubjectScorersStmt = db.prepare(`
  SELECT ${userSelectColumns}
  FROM users
  WHERE role = 'scorer'
    AND status = 'enabled'
    AND NOT EXISTS (
      SELECT 1
      FROM rating_tasks
      WHERE rating_tasks.projectId = ?
        AND rating_tasks.scorer = users.username
    )
    AND NOT EXISTS (
      SELECT 1
      FROM user_teams
      JOIN teams ON teams.id = user_teams.teamId
      WHERE user_teams.userId = users.id
        AND teams.status = 'disabled'
    )
  ORDER BY LOWER(username) ASC, username ASC
`);
const selectReassignableTaskIdsStmt = db.prepare(`
  SELECT id
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'pending'
    AND scorer IS NULL
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const selectReassignableTaskIdsByScorerStmt = db.prepare(`
  SELECT id
  FROM rating_tasks
  WHERE projectId = ?
    AND taskVersion = ?
    AND status = 'assigned'
    AND scorer = ?
  ORDER BY assignmentKey ASC, id ASC
  LIMIT ?
`);
const reassignTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET scorer = @scorer,
      updatedAt = @updatedAt
  WHERE id = @id
    AND projectId = @projectId
    AND taskVersion = @taskVersion
    AND status = 'assigned'
`);
const assignUnassignedTaskStmt = db.prepare(`
  UPDATE rating_tasks
  SET scorer = @scorer,
      status = 'assigned',
      updatedAt = @updatedAt
  WHERE id = @id
    AND projectId = @projectId
    AND taskVersion = @taskVersion
    AND status = 'pending'
    AND scorer IS NULL
`);
const deleteSubjectTasksStmt = db.prepare(
  "DELETE FROM rating_tasks WHERE subjectId = ?",
);
const markSubjectForDeletionStmt = db.prepare(`
  UPDATE subjects
  SET deletionRequestedAt = @deletionRequestedAt,
      updatedAt = @updatedAt
  WHERE id = @id AND deletionRequestedAt IS NULL
`);
const selectSubjectStoragePathsStmt = db.prepare(
  "SELECT storagePath FROM images WHERE subjectId = ?",
);
const deleteQueuedSubjectStmt = db.prepare(
  "DELETE FROM subjects WHERE id = ? AND deletionRequestedAt IS NOT NULL",
);
const insertImageStmt = db.prepare(`
  INSERT INTO images (
    id, subjectId, filename, originalPath, storagePath, thumbnailPath, mimeType, category, directory, isInfographic, prompt, catalogData, importBatch,
    overall, creativity, mood, composition, color, lighting, realism, detail, discomfort,
    promptAlignment, textCorrectness, anatomyNormality, informationClarity, designQuality, typography,
    comment, ratedAt, createdAt, updatedAt
  ) VALUES (
    @id, @subjectId, @filename, @originalPath, @storagePath, @thumbnailPath, @mimeType, @category, @directory, @isInfographic, @prompt, @catalogData, @importBatch,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, @createdAt, @updatedAt
  )
  ON CONFLICT DO NOTHING
`);
const updateImageScoreStmt = db.prepare(`
  UPDATE images
  SET overall = @overall,
      scorer = @scorer,
      creativity = @creativity,
      mood = @mood,
      composition = @composition,
      color = @color,
      lighting = @lighting,
      realism = @realism,
      detail = @detail,
      discomfort = @discomfort,
      promptAlignment = @promptAlignment,
      promptAlignmentState = @promptAlignmentState,
      textCorrectness = @textCorrectness,
      textCorrectnessState = @textCorrectnessState,
      anatomyNormality = @anatomyNormality,
      anatomyNormalityState = @anatomyNormalityState,
      informationClarity = @informationClarity,
      informationClarityState = @informationClarityState,
      designQuality = @designQuality,
      designQualityState = @designQualityState,
      typography = @typography,
      typographyState = @typographyState,
      comment = @comment,
      ratedAt = @ratedAt,
      updatedAt = @updatedAt
  WHERE id = @id
`);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isUniqueConstraintError(error) {
  return (
    error?.code === "23505" ||
    String(error?.message || "").includes("UNIQUE constraint failed")
  );
}

function archiveImportError(status, message, cause) {
  const error = httpError(status, message);
  error.isArchiveImportError = true;
  if (cause) error.cause = cause;
  return error;
}

function normalizeArchiveImportError(error) {
  if (error?.isArchiveImportError || error?.status) return error;

  if (error?.code === "ENOSPC") {
    return archiveImportError(
      507,
      "服务器磁盘空间不足，无法保存解压后的图片",
      error,
    );
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return archiveImportError(500, "服务器上传目录没有读写权限", error);
  }
  if (error?.code === "SQLITE_BUSY") {
    return archiveImportError(503, "数据库正被其他操作占用，请稍后重试", error);
  }

  return archiveImportError(
    500,
    "导入过程中发生未预期错误，已清理本次上传内容，请重试",
    error,
  );
}

function cleanRelative(value) {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((item) => item.replace(/[^\p{L}\p{N}._-]/gu, "_"))
    .join("/");
}

function decodeZipEntryPath(entry) {
  const rawPath = entry?.pathBuffer;
  if (!Buffer.isBuffer(rawPath) || !rawPath.length)
    return String(entry?.path ?? "");

  const utf8Path = rawPath.toString("utf8");
  const isUtf8Flagged =
    Boolean(Number(entry?.flags ?? 0) & 0x800) || entry?.isUnicode;
  const isValidUtf8 = Buffer.from(utf8Path, "utf8").equals(rawPath);
  if (isUtf8Flagged || isValidUtf8) return utf8Path;

  // 很多 Windows 压缩工具写入中文文件名时没有设置 UTF-8 标记，而是使用 CP936。
  return iconv.decode(rawPath, "cp936");
}

function normalizeCatalogPath(value) {
  return cleanRelative(String(value ?? "")).toLocaleLowerCase();
}

function normalizeCatalogFilename(value) {
  const normalized = normalizeCatalogPath(value);
  return normalized ? path.posix.basename(normalized) : "";
}

function isInfographicPath(relative) {
  const directories = cleanRelative(String(relative ?? ""))
    .split("/")
    .filter(Boolean);
  directories.pop();
  return directories.some((directory) => directory.trim() === "信息图");
}

function catalogRowForManifest(row) {
  if (!row || typeof row !== "object") return null;
  const { catalog_row: nestedCatalogRow, ...manifestRow } = row;
  if (!nestedCatalogRow || typeof nestedCatalogRow !== "object") return row;

  // ZIP manifest 的顶层保存来源和目标文件名，catalog_row 保存原始目录信息。
  // 合并两者，确保详情、Prompt 和文件路径都能保留下来。
  return { ...manifestRow, ...nestedCatalogRow };
}

function addCatalogRowsToIndex(index, catalog) {
  if (!Array.isArray(catalog?.rows)) return false;

  catalog.rows.forEach((row) => {
    const catalogRow = catalogRowForManifest(row);
    if (!catalogRow) return;
    const pathKeys = [
      row.src_rel_path,
      catalogRow.src_rel_path,
    ];
    pathKeys.forEach((value) => {
      const relativePath = normalizeCatalogPath(value);
      if (!relativePath) return;
      const key = `path:${relativePath}`;
      if (!index.has(key)) {
        index.set(key, catalogRow);
        return;
      }
      if (JSON.stringify(index.get(key)) !== JSON.stringify(catalogRow)) {
        index.set(key, null);
      }
    });

    const filenameKeys = [
      row.dest_rel_path,
      row.image_filename,
      catalogRow.dest_rel_path,
      catalogRow.image_filename,
      row.src_rel_path,
      catalogRow.src_rel_path,
    ];
    filenameKeys.forEach((value) => {
      const filename = normalizeCatalogFilename(value);
      if (!filename) return;
      const key = `filename:${filename}`;
      if (!index.has(key)) {
        index.set(key, catalogRow);
        return;
      }
      // A duplicate filename is ambiguous across folders. Do not attach another
      // image's prompt or manifest details to the wrong image.
      if (JSON.stringify(index.get(key)) !== JSON.stringify(catalogRow)) {
        index.set(key, null);
      }
    });
  });

  return true;
}

async function loadArchiveManifests(zip) {
  const manifestEntry = zip.files.find((entry) => {
    if (entry.type === "Directory") return false;
    return normalizeCatalogPath(decodeZipEntryPath(entry)) === "manifest.json";
  });
  if (!manifestEntry) return [];
  const maxManifestBytes = 64 * 1024 * 1024;
  if (archiveEntryUncompressedSize(manifestEntry) > maxManifestBytes) {
    throw archiveImportError(413, "manifest.json 超过允许大小");
  }

  try {
    const manifestBuffer = await manifestEntry.buffer();
    if (manifestBuffer.length > maxManifestBytes) {
      throw archiveImportError(413, "manifest.json 超过允许大小");
    }
    const manifest = JSON.parse(manifestBuffer.toString("utf8"));
    if (!Array.isArray(manifest?.rows)) {
      throw new Error("manifest.json 缺少 rows 数据");
    }
    return [manifest];
  } catch (error) {
    if (error?.isArchiveImportError) throw error;
    throw archiveImportError(422, "压缩包根目录的 manifest.json 无效", error);
  }
}

async function loadArchiveTaskManifest(zip) {
  const taskEntry = zip.files.find((entry) => {
    if (entry.type === "Directory") return false;
    const name = normalizeCatalogPath(decodeZipEntryPath(entry));
    return name === "tasks.json" || name === "task.json";
  });
  if (!taskEntry) return null;

  const maxTaskManifestBytes = 64 * 1024 * 1024;
  if (archiveEntryUncompressedSize(taskEntry) > maxTaskManifestBytes) {
    throw archiveImportError(413, "tasks.json exceeds the allowed size");
  }

  try {
    const taskBuffer = await taskEntry.buffer();
    if (taskBuffer.length > maxTaskManifestBytes) {
      throw archiveImportError(413, "tasks.json exceeds the allowed size");
    }
    const taskManifest = JSON.parse(taskBuffer.toString("utf8"));
    if (!Array.isArray(taskManifest?.tasks)) {
      throw new Error("tasks must be an array");
    }
    return taskManifest;
  } catch (error) {
    if (error?.isArchiveImportError) throw error;
    throw archiveImportError(422, "Invalid root tasks.json", error);
  }
}

async function loadImageCatalogIndex(archiveManifests = []) {
  const index = new Map();
  for (const manifest of archiveManifests) {
    addCatalogRowsToIndex(index, manifest);
  }

  return index;
}

function catalogEntryForImage(catalogIndex, rawRelative, relative) {
  const relativePaths = [rawRelative, relative]
    .map(normalizeCatalogPath)
    .filter(Boolean);
  for (const relativePath of relativePaths) {
    const key = `path:${relativePath}`;
    if (catalogIndex.has(key)) return catalogIndex.get(key);
  }

  const filenames = [rawRelative, relative]
    .map(normalizeCatalogFilename)
    .filter(Boolean);
  for (const filename of filenames) {
    const key = `filename:${filename}`;
    if (catalogIndex.has(key)) return catalogIndex.get(key);
  }
  return null;
}

function addTaskReference(index, key, image) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, image);
    return;
  }
  if (index.get(key)?.id !== image.id) index.set(key, null);
}

function buildTaskImageReferenceIndex(imageRecords) {
  const pathIndex = new Map();
  const filenameIndex = new Map();
  imageRecords.forEach((image) => {
    addTaskReference(
      pathIndex,
      normalizeCatalogPath(image.originalPath),
      image,
    );
    addTaskReference(
      filenameIndex,
      normalizeCatalogFilename(image.filename),
      image,
    );
  });
  return { pathIndex, filenameIndex };
}

function taskImageReference(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return (
      value.src_rel_path ??
      value.originalPath ??
      value.path ??
      value.filename ??
      value.image
    );
  }
  return "";
}

function resolveTaskImage(imageReferenceIndex, reference) {
  const normalizedPath = normalizeCatalogPath(reference);
  if (imageReferenceIndex.pathIndex.has(normalizedPath)) {
    return imageReferenceIndex.pathIndex.get(normalizedPath);
  }

  const normalizedFilename = normalizeCatalogFilename(reference);
  return imageReferenceIndex.filenameIndex.get(normalizedFilename);
}

function taskItemRole(value) {
  const role = String(value?.role ?? "target");
  if (!taskTemplateRoles.has(role)) {
    throw archiveImportError(422, `Unsupported task item role: ${role}`);
  }
  return role;
}

function buildTaskTemplateRecords(subjectId, taskManifest, imageRecords, createdAt) {
  if (!taskManifest) return [];
  if (!taskManifest.tasks.length) {
    throw archiveImportError(422, "tasks.json does not contain any tasks");
  }

  const imageReferenceIndex = buildTaskImageReferenceIndex(imageRecords);
  const sourceTaskIds = new Set();
  const taskKeys = new Set();
  const failedTasks = [];

  const taskTemplates = taskManifest.tasks.map((rawTask, index) => {
    try {
    if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) {
      throw archiveImportError(422, `tasks[${index}] must be an object`);
    }

    const sourceTaskId = String(rawTask.id ?? `task-${index + 1}`).trim();
    if (!sourceTaskId || sourceTaskId.length > 160 || sourceTaskIds.has(sourceTaskId)) {
      throw archiveImportError(422, `tasks[${index}] has an invalid or duplicate id`);
    }
    sourceTaskIds.add(sourceTaskId);

    const criterion = String(rawTask.criterion ?? "").trim();
    if (!taskCriteria.includes(criterion)) {
      throw archiveImportError(422, `tasks[${index}].criterion is not supported`);
    }

    if (!Array.isArray(rawTask.images) || rawTask.images.length < 1 || rawTask.images.length > 5) {
      throw archiveImportError(422, `tasks[${index}].images must contain 1 to 5 images`);
    }

    const usedImageIds = new Set();
    const items = rawTask.images.map((rawItem, itemIndex) => {
      const reference = String(taskImageReference(rawItem) ?? "").trim();
      const image = resolveTaskImage(imageReferenceIndex, reference);
      if (!image) {
        const label = reference || `images[${itemIndex}]`;
        throw archiveImportError(
          422,
          `tasks[${index}] references an unknown or ambiguous image: ${label}`,
        );
      }
      if (usedImageIds.has(image.id)) {
        throw archiveImportError(422, `tasks[${index}] contains the same image more than once`);
      }
      usedImageIds.add(image.id);
      return {
        imageId: image.id,
        position: itemIndex,
        role: taskItemRole(rawItem),
      };
    });

    const imageKey = items.map((item) => item.imageId).sort().join("|");
    const taskKey = `${criterion}|${imageKey}`;
    if (taskKeys.has(taskKey)) {
      throw archiveImportError(422, `tasks[${index}] duplicates another task group`);
    }
    taskKeys.add(taskKey);

      return {
      id: crypto.randomUUID(),
      subjectId,
      sourceTaskId,
      round: 1,
      criterion,
      imageKey,
      selectionKey: crypto.randomInt(1, 2147483647),
      createdAt,
      items,
      };
    } catch (error) {
      const sourceTaskId = rawTask?.id ?? `task-${index + 1}`;
      const message = error?.message || String(error);
      failedTasks.push({
        index,
        id: String(sourceTaskId),
        message,
      });
      console.warn(`Skipping invalid task ${index} (${sourceTaskId}): ${message}`);
      return null;
    }
  }).filter(Boolean);

  return { taskTemplates, failedTasks };
}

function catalogPrompt(entry) {
  const prompt = entry?.actual_input_prompt ?? entry?.prompt;
  const text = typeof prompt === "string" ? prompt.trim() : "";
  return text || null;
}

function parseCatalogData(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function cleanFolderName(value, fallback = "upload") {
  const cleaned = String(value)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("_")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned || fallback;
}

function detectArchiveRoot(entries) {
  const roots = new Set();
  let hasNestedImage = false;

  for (const entry of entries) {
    const relative = cleanRelative(
      decodeZipEntryPath(entry) || entry.entryName,
    );
    if (!relative) continue;
    const parts = relative.split("/");
    roots.add(parts[0]);
    if (parts.length > 1) hasNestedImage = true;
  }

  return roots.size === 1 && hasNestedImage ? [...roots][0] : null;
}

function stripArchiveRoot(relative, root) {
  if (!root) return relative;
  const parts = relative.split("/");
  return parts[0] === root ? parts.slice(1).join("/") : relative;
}

function archiveEntryUncompressedSize(entry) {
  const size = Number(
    entry?.uncompressedSize ??
      entry?.vars?.uncompressedSize ??
      entry?.size ??
      0,
  );
  return Number.isFinite(size) && size > 0 ? size : 0;
}

async function assertArchiveLimits(zip, zipPath) {
  const zipStat = await fs.stat(zipPath);
  if (zipStat.size > maxZipBytes) {
    throw archiveImportError(413, "ZIP 文件超过服务器允许的大小限制");
  }
  if (zip.files.length > maxArchiveEntries) {
    throw archiveImportError(413, "ZIP 文件条目数量超过允许上限");
  }
  const totalUncompressed = zip.files.reduce(
    (total, entry) => total + archiveEntryUncompressedSize(entry),
    0,
  );
  if (totalUncompressed > maxArchiveUncompressedBytes) {
    throw archiveImportError(413, "ZIP 解压后的总大小超过允许上限");
  }
}

function decompressionLimit(maxBytes, relative) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(
          archiveImportError(413, `图片“${relative}”解压后超过允许大小`),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

function openZip64Archive(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, decodeStrings: false, autoClose: false },
      (error, archive) => {
      if (error) {
        reject(error);
        return;
      }
      const entries = [];
      archive.on("entry", (rawEntry) => {
        const pathBuffer = Buffer.isBuffer(rawEntry.fileName)
          ? rawEntry.fileName
          : Buffer.from(rawEntry.fileName);
        const entry = {
          type: pathBuffer[pathBuffer.length - 1] === 47 ? "Directory" : "File",
          path: pathBuffer.toString("utf8"),
          pathBuffer,
          uncompressedSize: rawEntry.uncompressedSize,
          vars: { uncompressedSize: rawEntry.uncompressedSize },
          stream() {
            const output = new PassThrough();
            archive.openReadStream(rawEntry, (streamError, stream) => {
              if (streamError) {
                output.destroy(streamError);
                return;
              }
              stream.on("error", (readError) => output.destroy(readError));
              stream.pipe(output);
            });
            return output;
          },
          async buffer() {
            const chunks = [];
            for await (const chunk of entry.stream()) chunks.push(chunk);
            return Buffer.concat(chunks);
          },
        };
        entries.push(entry);
        archive.readEntry();
      });
      archive.once("end", () => resolve({ files: entries, close: () => archive.close() }));
      archive.once("error", reject);
      archive.readEntry();
      },
    );
  });
}

function isMacMetadataEntry(relative) {
  if (!relative) return true;
  if (relative === ".DS_Store" || relative.endsWith("/.DS_Store")) return true;
  return relative
    .split("/")
    .some((segment) => segment === "__MACOSX" || segment.startsWith("._"));
}

async function allocateSubjectStorageRoot(subjectName, subjectId) {
  const baseName = cleanFolderName(
    subjectName,
    `subject-${subjectId.slice(0, 8)}`,
  );
  let candidate = baseName;
  let attempt = 0;

  while (true) {
    try {
      await fs.access(path.join(uploadDir, candidate));
      attempt += 1;
      candidate = `${baseName}-${subjectId.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ""}`;
    } catch {
      return candidate;
    }
  }
}

function validateUploadId(uploadId) {
  if (!/^[a-z0-9-]{8,128}$/i.test(uploadId)) {
    throw httpError(400, "上传标识不正确");
  }
}

function chunkDir(uploadId) {
  validateUploadId(uploadId);
  return path.join(chunkUploadDir, uploadId);
}

function chunkFilePath(uploadId, index) {
  return path.join(
    chunkDir(uploadId),
    `${String(index).padStart(6, "0")}.part`,
  );
}

function resumableSessionDir(uploadId) {
  validateUploadId(uploadId);
  return path.join(resumableUploadDir, uploadId);
}

function resumableSessionMetaPath(uploadId) {
  return path.join(resumableSessionDir(uploadId), "upload.json");
}

function resumableSessionFilePath(uploadId) {
  return path.join(resumableSessionDir(uploadId), "upload.zip");
}

function resumableUploadExpiresAt() {
  return new Date(Date.now() + resumableUploadExpiryMs).toISOString();
}

function tusMetadataHeaderValue(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function parseTusMetadataHeader(header) {
  const metadata = {};
  const raw = String(header || "").trim();
  if (!raw) return metadata;

  for (const pair of raw.split(",")) {
    const entry = pair.trim();
    if (!entry) continue;
    const separator = entry.indexOf(" ");
    const key = (separator >= 0 ? entry.slice(0, separator) : entry).trim();
    if (!key) continue;
    const encodedValue = separator >= 0 ? entry.slice(separator + 1).trim() : "";
    if (!encodedValue) {
      metadata[key.toLowerCase()] = "";
      continue;
    }
    try {
      metadata[key.toLowerCase()] = Buffer.from(encodedValue, "base64").toString(
        "utf8",
      );
    } catch {
      throw httpError(400, "上传元数据格式不正确");
    }
  }

  return metadata;
}

function requireTusResumableHeader(req) {
  const version = String(req.headers["tus-resumable"] || "");
  if (!version) throw httpError(412, "缺少 Tus-Resumable 请求头");
  if (version !== tusVersion) throw httpError(412, "Tus 版本不受支持");
}

function resumableUploadResponseHeaders(session, offset) {
  return {
    "Cache-Control": "no-store",
    "Location": `/api/import/uploads/${session.uploadId}`,
    "Tus-Resumable": tusVersion,
    "Tus-Version": tusVersion,
    "Tus-Extension": "creation,termination",
    "Tus-Max-Size": String(maxZipBytes),
    "Upload-Expires": session.expiresAt,
    "Upload-Length": String(session.uploadLength),
    "Upload-Metadata": `filename ${tusMetadataHeaderValue(session.originalFilename)}`,
    "Upload-Offset": String(offset),
  };
}

function resumableUploadDto(session, offset) {
  return {
    uploadId: session.uploadId,
    uploadUrl: `/api/import/uploads/${session.uploadId}`,
    originalFilename: session.originalFilename,
    uploadLength: session.uploadLength,
    offset,
    status: session.status,
    expiresAt: session.expiresAt,
  };
}

function writeJsonFileAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  return fs
    .writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    .then(() => fs.rename(tempPath, filePath))
    .catch(async (error) => {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    });
}

async function loadResumableUploadSession(uploadId) {
  validateUploadId(uploadId);
  const dir = resumableSessionDir(uploadId);
  const metaPath = resumableSessionMetaPath(uploadId);
  const filePath = resumableSessionFilePath(uploadId);

  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.uploadId !== uploadId) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const expiresAt = Date.parse(parsed.expiresAt || "");
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const uploadLength = Number(parsed.uploadLength);
    if (!Number.isFinite(uploadLength) || uploadLength <= 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    if (stat.size > uploadLength) {
      throw httpError(409, "上传会话已损坏，请重新上传");
    }

    return {
      uploadId,
      originalFilename: String(parsed.originalFilename || ""),
      uploadLength,
      status: String(parsed.status || "uploading"),
      createdAt: String(parsed.createdAt || ""),
      updatedAt: String(parsed.updatedAt || ""),
      expiresAt: String(parsed.expiresAt || resumableUploadExpiresAt()),
      dir,
      metaPath,
      filePath,
      offset: stat.size,
    };
  } catch (error) {
    if (error?.status) throw error;
    if (error?.code === "ENOENT") {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

async function saveResumableUploadSession(session) {
  await fs.mkdir(resumableSessionDir(session.uploadId), { recursive: true });
  await writeJsonFileAtomic(resumableSessionMetaPath(session.uploadId), {
    uploadId: session.uploadId,
    originalFilename: session.originalFilename,
    uploadLength: session.uploadLength,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
  });
}

async function createResumableUploadSession(originalFilename, uploadLength) {
  const uploadId = crypto.randomUUID();
  const createdAt = nowIso();
  const session = {
    uploadId,
    originalFilename,
    uploadLength,
    status: "uploading",
    createdAt,
    updatedAt: createdAt,
    expiresAt: resumableUploadExpiresAt(),
  };

  await fs.mkdir(resumableSessionDir(uploadId), { recursive: true });
  await fs.writeFile(resumableSessionFilePath(uploadId), "");
  await saveResumableUploadSession(session);
  return session;
}

async function cleanupResumableUploadSession(uploadId) {
  await fs.rm(resumableSessionDir(uploadId), {
    recursive: true,
    force: true,
  });
}

async function sweepResumableUploadSessions() {
  const entries = await fs.readdir(resumableUploadDir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const uploadId = entry.name;
        if (!/^[a-z0-9-]{8,128}$/i.test(uploadId)) {
          await fs.rm(path.join(resumableUploadDir, uploadId), {
            recursive: true,
            force: true,
          }).catch(() => {});
          return;
        }
        const session = await loadResumableUploadSession(uploadId);
        if (!session) return;
        const expiresAt = Date.parse(session.expiresAt || "");
        if (!Number.isFinite(expiresAt) || expiresAt <= now || session.status !== "uploading") {
          await cleanupResumableUploadSession(uploadId).catch(() => {});
        }
      }),
  );
}

function normalizeTusFilename(filename) {
  return path.basename(String(filename || "").replace(/\\/g, "/")).trim();
}

function byteLimitTransform(maxBytes, message) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(httpError(413, message));
        return;
      }
      callback(null, chunk);
    },
  });
}

const resumableUploadLocks = new Map();

async function withResumableUploadLock(uploadId, task) {
  while (resumableUploadLocks.has(uploadId)) {
    await resumableUploadLocks.get(uploadId);
  }

  let release = () => {};
  const lock = new Promise((resolve) => {
    release = resolve;
  });
  resumableUploadLocks.set(uploadId, lock);
  try {
    return await task();
  } finally {
    resumableUploadLocks.delete(uploadId);
    release();
  }
}

async function importZipArchive(
  zipPath,
  originalFilename,
  { removeSource = true, onProgress } = {},
) {
  const batch = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const subjectId = crypto.randomUUID();
  const subjectName =
    path.basename(originalFilename, path.extname(originalFilename)) ||
    originalFilename;
  const createdAt = nowIso();
  let subjectDir;
  let transactionOpen = false;
  let zip;

  try {
    try {
      zip = await openZip64Archive(zipPath);
      await assertArchiveLimits(zip, zipPath);
    } catch (error) {
      if (error?.isArchiveImportError) throw error;
      throw archiveImportError(
        400,
        "无法读取 ZIP 压缩包，请确认文件完整且未损坏",
        error,
      );
    }

    let imageEntries;
    try {
      imageEntries = zip.files.filter((entry) => {
        if (entry.type === "Directory") return false;
        const relative = cleanRelative(decodeZipEntryPath(entry));
        return (
          Boolean(relative) &&
          !isMacMetadataEntry(relative) &&
          imageExts.has(path.extname(relative).toLowerCase())
        );
      });
    } catch (error) {
      throw archiveImportError(
        400,
        "无法解析 ZIP 文件目录，请确认压缩包未损坏",
        error,
      );
    }

    if (!imageEntries.length) {
      throw archiveImportError(
        422,
        "压缩包中未发现可导入图片。仅支持 JPG、JPEG、PNG、WEBP、GIF 文件",
      );
    }

    const archiveManifests = await loadArchiveManifests(zip);
    const archiveTaskManifest = await loadArchiveTaskManifest(zip);
    const catalogIndex = await loadImageCatalogIndex(archiveManifests);
    const storageRoot = await allocateSubjectStorageRoot(
      subjectName,
      subjectId,
    );
    subjectDir = path.join(uploadDir, storageRoot);
    const sourceZipPath = path.posix.join(storageRoot, "source.zip");
    let imported = 0;
    let skipped = 0;
    let catalogMatched = 0;
    const directories = new Set();
    const imageRecords = [];
    const seenOriginalPaths = new Set();

    await fs.mkdir(subjectDir, { recursive: true });
    await fs.copyFile(zipPath, uploadFilePath(uploadDir, sourceZipPath));

    const processImageEntry = async (entry, entryIndex) => {
      if (entry.type === "Directory") return null;
      const rawRelative = cleanRelative(decodeZipEntryPath(entry));
      // Keep the original relative path. Images can appear in any ZIP directory;
      // only root-level JSON files are treated as import metadata.
      const relative = rawRelative;
      if (isMacMetadataEntry(relative)) return null;
      const ext = path.extname(relative).toLowerCase();
      if (!relative || !imageExts.has(ext)) return null;
      if (seenOriginalPaths.has(relative)) return { skipped: 1 };
      seenOriginalPaths.add(relative);

      const catalogEntry = catalogEntryForImage(
        catalogIndex,
        rawRelative,
        relative,
      );
      const isInfographic = isInfographicPath(relative) ? 1 : 0;
      const directory = isInfographic ? "信息图" : "";
      const category = isInfographic ? "信息图" : "未分类";
      const imageId = crypto.randomUUID();
      const relativeDir = path.posix.dirname(relative);
      const storagePath = path.posix.join(
        storageRoot,
        relativeDir === "." ? "" : relativeDir,
        `${imageId}${ext}`,
      );
      let thumbnailPath = thumbnailStoragePath(storagePath);
      const storedPath = uploadFilePath(uploadDir, storagePath);
      let storedThumbnailPath = uploadFilePath(uploadDir, thumbnailPath);

      try {
        await fs.mkdir(path.dirname(storedPath), { recursive: true });
        await pipeline(
          entry.stream(),
          decompressionLimit(maxImageUncompressedBytes, relative),
          createWriteStream(storedPath),
        );
      } catch (error) {
        await fs.unlink(storedPath).catch(() => {});
        await fs.unlink(storedThumbnailPath).catch(() => {});
        if (
          error?.code === "ENOSPC" ||
          error?.code === "EACCES" ||
          error?.code === "EPERM"
        ) {
          throw archiveImportError(
            500,
            `保存图片“${relative}”时失败，请检查服务器上传目录`,
            error,
          );
        }
        return { skipped: 1 };
      }

      try {
        await createThumbnail(storedPath, storedThumbnailPath);
      } catch (error) {
        // A bad extension or unsupported encoding must not discard the original.
        console.warn(`Thumbnail generation failed for ${relative}; using original image`, error);
        thumbnailPath = storagePath;
        storedThumbnailPath = storedPath;
      }
      return { record: {
        id: imageId,
        subjectId,
        filename: path.basename(relative),
        originalPath: relative,
        storagePath,
        thumbnailPath,
        mimeType:
          ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : `image/${ext.slice(1)}`,
        category,
        directory,
        isInfographic,
        prompt: catalogPrompt(catalogEntry),
        catalogData: catalogEntry ? JSON.stringify(catalogEntry) : null,
        importBatch: batch,
        createdAt,
        updatedAt: createdAt,
      }, directory: Boolean(directory), catalogMatched: Boolean(catalogEntry) };
    };

    for (let start = 0; start < imageEntries.length; start += imageImportConcurrency) {
      const settledResults = await Promise.allSettled(
        imageEntries
          .slice(start, start + imageImportConcurrency)
          .map((entry, offset) => processImageEntry(entry, start + offset)),
      );
      const failedResult = settledResults.find((result) => result.status === "rejected");
      if (failedResult) throw failedResult.reason;
      const results = settledResults.map((result) => result.value);
      for (const result of results) {
        skipped += result?.skipped || 0;
        if (!result?.record) continue;
        imageRecords.push(result.record);
        if (result.directory) directories.add(result.record.directory);
        catalogMatched += result.catalogMatched ? 1 : 0;
        imported++;
      }
      await onProgress?.({
        current: Math.min(start + imageImportConcurrency, imageEntries.length),
        total: imageEntries.length,
      });
    }

    if (!imported) {
      throw archiveImportError(422, "压缩包中的图片均无法导入");
    }

    const { taskTemplates, failedTasks } = buildTaskTemplateRecords(
      subjectId,
      archiveTaskManifest,
      imageRecords,
      createdAt,
    );

    // All archive I/O and image validation has completed before this write
    // transaction. Keep read indexes in place so imports do not rebuild the
    // entire images table while holding a write transaction.
    await db.exec("BEGIN");
    transactionOpen = true;
    await insertSubjectStmt.run({
      id: subjectId,
      name: subjectName,
      originalFilename,
      importBatch: batch,
      storageRoot,
      sourceZipPath,
      createdAt,
      updatedAt: createdAt,
    });
    for (const imageRecord of imageRecords) {
      const result = await insertImageStmt.run(imageRecord);
      if (result.changes === 0) {
        throw archiveImportError(
          409,
          `图片“${imageRecord.originalPath}”重复，无法导入`,
        );
      }
    }
    for (const taskTemplate of taskTemplates) {
      const { items: _items, ...templateRecord } = taskTemplate;
      await insertSubjectTaskTemplateStmt.run(templateRecord);
      for (const item of taskTemplate.items) {
        await insertSubjectTaskTemplateItemStmt.run({
          templateId: taskTemplate.id,
          ...item,
        });
      }
    }

    const updatedAt = nowIso();
    await updateSubjectCountsStmt.run({
      id: subjectId,
      imageCount: imported,
      categoryCount: directories.size,
      status: "imported",
      updatedAt,
    });

    await db.exec("COMMIT");
    transactionOpen = false;
    const subject = await selectSubjectByIdStmt.get(subjectId);
    return {
      subject: subjectDto(subject),
      batch,
      imported,
      skipped,
      catalogMatched,
      catalogUnmatched: imported - catalogMatched,
      taskTemplateCount: taskTemplates.length,
      taskFailedCount: failedTasks.length,
      taskFailures: failedTasks,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("Failed to roll back ZIP import", rollbackError);
      }
    }

    // Covers failures after a commit as well as older databases with partial imports.
    try {
      await db.prepare("DELETE FROM subjects WHERE id = ?").run(subjectId);
    } catch (cleanupError) {
      console.error("Failed to clean up ZIP import record", cleanupError);
    }
    if (subjectDir) {
      await fs.rm(subjectDir, { recursive: true, force: true }).catch(() => {});
    }
    throw normalizeArchiveImportError(error);
  } finally {
    zip?.close();
    if (removeSource) await fs.unlink(zipPath).catch(() => {});
  }
}

async function runResumableImportJob(job) {
  try {
    job.status = "importing";
    job.stage = "正在解析并导入图片";
    job.progress = 0;
    await persistImportJob(job);

    job.result = await importZipArchive(job.zipPath, job.originalFilename, {
      onProgress: async ({ current, total }) => {
        job.progress = Math.min(99, Math.round((current / total) * 100));
        if (job.progress !== job.lastPersistedProgress) {
          job.lastPersistedProgress = job.progress;
          await persistImportJob(job);
        }
      },
    });

    job.status = "completed";
    job.stage = "导入完成";
    job.progress = 100;
    await persistImportJob(job);
  } catch (error) {
    const normalized = normalizeArchiveImportError(error);
    job.status = "failed";
    job.stage = "导入失败";
    job.message = normalized.message || "导入失败，请重试";
    await persistImportJob(job);
    console.error(`Resumable ZIP import failed (${job.uploadId})`, error);
  } finally {
    await cleanupResumableUploadSession(job.uploadId).catch(() => {});

    // 保留结果一段时间，允许前端在短暂断线后继续查询本次任务。
    setTimeout(
      async () => {
        importJobs.delete(job.uploadId);
        await deleteImportJobStmt.run(job.uploadId);
      },
      24 * 60 * 60 * 1000,
    ).unref();
  }
}

function importJobExpiry() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function importJobDto(job) {
  const payload = {
    uploadId: job.uploadId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
  };
  if (job.result) payload.result = job.result;
  return payload;
}

function importJobFromRow(row) {
  if (!row) return null;
  let result = null;
  if (row.resultJson) {
    try {
      result = JSON.parse(row.resultJson);
    } catch {
      result = null;
    }
  }
  return {
    uploadId: row.uploadId,
    originalFilename: row.originalFilename,
    totalChunks: row.totalChunks,
    protocol: row.protocol || "chunked",
    uploadLength: row.uploadLength,
    uploadOffset: row.uploadOffset,
    metadata: row.metadata,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    message: row.message,
    result,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

async function persistImportJob(job) {
  job.expiresAt = job.expiresAt || importJobExpiry();
  const updatedAt = nowIso();
  await updateImportJobStmt.run({
    uploadId: job.uploadId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message || null,
    resultJson: job.result ? JSON.stringify(job.result) : null,
    protocol: job.protocol || "chunked",
    uploadLength: job.uploadLength ?? null,
    uploadOffset: job.uploadOffset ?? 0,
    metadata: job.metadata ?? null,
    updatedAt,
    expiresAt: job.expiresAt,
  });
}

async function mergeChunkedZip(job) {
  let totalBytes = 0;
  const partPaths = [];

  for (let index = 0; index < job.totalChunks; index++) {
    const partPath = chunkFilePath(job.uploadId, index);
    let stat;
    try {
      stat = await fs.stat(partPath);
    } catch {
      throw httpError(400, `缺少第 ${index + 1} 个分片`);
    }
    if (!stat.isFile() || stat.size <= 0) {
      throw httpError(400, `第 ${index + 1} 个分片无效`);
    }
    totalBytes += stat.size;
    if (totalBytes > maxZipBytes) {
      throw httpError(413, "ZIP 文件超过服务器允许的大小限制");
    }
    partPaths.push(partPath);
  }

  const output = await fs.open(job.zipPath, "w");
  let mergedBytes = 0;
  try {
    for (const partPath of partPaths) {
      for await (const chunk of createReadStream(partPath)) {
        await output.write(chunk);
        mergedBytes += chunk.length;
        job.progress = Math.min(
          15,
          Math.round((mergedBytes / totalBytes) * 15),
        );
      }
    }
  } finally {
    await output.close();
  }
}

async function runChunkedImportJob(job) {
  try {
    job.status = "merging";
    job.stage = "正在合并上传分片";
    job.progress = 0;
    await persistImportJob(job);
    await mergeChunkedZip(job);

    job.status = "importing";
    job.stage = "正在解析并导入图片";
    job.progress = 15;
    await persistImportJob(job);
    job.result = await importZipArchive(job.zipPath, job.originalFilename, {
      onProgress: async ({ current, total }) => {
        job.progress = Math.min(99, 15 + Math.round((current / total) * 84));
        if (job.progress !== job.lastPersistedProgress) {
          job.lastPersistedProgress = job.progress;
          await persistImportJob(job);
        }
      },
    });
    job.status = "completed";
    job.stage = "导入完成";
    job.progress = 100;
    await persistImportJob(job);
  } catch (error) {
    const normalized = normalizeArchiveImportError(error);
    job.status = "failed";
    job.stage = "导入失败";
    job.message = normalized.message || "导入失败，请重试";
    await persistImportJob(job);
    console.error(`Chunked ZIP import failed (${job.uploadId})`, error);
  } finally {
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    await fs.unlink(job.zipPath).catch(() => {});

    // 保留结果一段时间，允许前端在短暂断线后继续查询本次任务。
    setTimeout(
      async () => {
        importJobs.delete(job.uploadId);
        await deleteImportJobStmt.run(job.uploadId);
      },
      24 * 60 * 60 * 1000,
    ).unref();
  }
}

// 时间统一存储为 UTC；业务展示和按小时统计固定使用 Asia/Shanghai（UTC+8）。
function nowIso() {
  return new Date().toISOString();
}

function clampScore(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.round(number);
  return Math.max(1, Math.min(10, rounded));
}

function parseScoreValue(value, key) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > 10
  ) {
    throw httpError(400, `${key} 必须是 1-10 的整数`);
  }
  return number;
}

function scoreStateColumn(key) {
  return `${key}State`;
}

function parseScoreState(value, key) {
  if (value === null || value === undefined || value === "") return null;
  const state = String(value);
  if (!["unrated", "rated", "not_applicable"].includes(state)) {
    throw httpError(400, `${key} 状态不正确`);
  }
  return state;
}

function parseScoreRange(value) {
  if (!Array.isArray(value)) return [1, 10];
  const min = clampScore(value[0], 1);
  const max = clampScore(value[1], 10);
  return [Math.min(min, max), Math.max(min, max)];
}

function parseNullableBoolean(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === 1 || value === "1" || value === "true") return 1;
  if (value === 0 || value === "0" || value === "false") return 0;
  throw httpError(400, "不舒适字段格式不正确");
}

function parseComment(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (text.length > 2000) throw httpError(400, "备注不能超过 2000 字");
  return text;
}

const feedbackTypes = new Set(["platform_bug", "scoring_rule", "other"]);
const feedbackStatuses = new Set(["pending", "processing", "resolved"]);

function parseFeedbackText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, `${label}不能为空`);
  if (text.length > maxLength)
    throw httpError(400, `${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function parseFeedbackType(value) {
  const type = String(value ?? "").trim();
  if (!feedbackTypes.has(type)) throw httpError(400, "问题类型不正确");
  return type;
}

function parseFeedbackStatus(value) {
  const status = String(value ?? "").trim();
  if (!feedbackStatuses.has(status)) throw httpError(400, "处理状态不正确");
  return status;
}

function parseFeedbackImagePaths(value) {
  try {
    const paths = JSON.parse(value || "[]");
    return Array.isArray(paths)
      ? paths.filter(
          (item) => typeof item === "string" && item.startsWith("feedback/"),
        )
      : [];
  } catch {
    return [];
  }
}

async function feedbackDto(row, messages = null) {
  if (!row) return null;
  const imagePaths = parseFeedbackImagePaths(row.imagePaths);
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    description: row.description,
    status: row.status,
    submitter: row.submitter,
    submittedAt: row.submittedAt,
    reply: row.reply ?? "",
    repliedBy: row.repliedBy ?? null,
    repliedAt: row.repliedAt ?? null,
    updatedAt: row.updatedAt,
    messages: (messages ?? (await selectFeedbackMessagesStmt.all(row.id))).map((message) => ({
      id: message.id,
      author: message.author,
      authorRole: message.authorRole,
      content: message.content,
      createdAt: message.createdAt,
    })),
    images: imagePaths.map((imagePath) => ({
      path: imagePath,
      url: `/files/${imagePath}`,
    })),
  };
}

async function feedbackMessagesByIds(ids) {
  if (!ids.length) return new Map();
  const rows = await db
    .prepare(`
      SELECT id, feedbackId, author, authorRole, content, createdAt
      FROM feedback_messages
      WHERE feedbackId IN (${placeholders(ids.length)})
      ORDER BY feedbackId ASC, createdAt ASC, id ASC
    `)
    .all(...ids);
  const messagesByFeedbackId = new Map();
  rows.forEach((message) => {
    const messages = messagesByFeedbackId.get(message.feedbackId) || [];
    messages.push(message);
    messagesByFeedbackId.set(message.feedbackId, messages);
  });
  return messagesByFeedbackId;
}

async function listFeedbacks(query = {}) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 10, 1), 100);
  const clauses = [];
  const params = [];
  const status = query.status ? parseFeedbackStatus(query.status) : null;

  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const total = (await db
    .prepare(`SELECT COUNT(*) AS total FROM feedbacks${where}`)
    .get(...params)).total;
  const rows = await db
    .prepare(
      `SELECT * FROM feedbacks${where} ORDER BY submittedAt DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  const messagesByFeedbackId = await feedbackMessagesByIds(rows.map((row) => row.id));
  const items = await Promise.all(rows.map(
    async row => await feedbackDto(row, messagesByFeedbackId.get(row.id) || [])
  ));
  return { total, page, pageSize, items };
}

async function createFeedback(user, body = {}, files = []) {
  const title = parseFeedbackText(body.title, "问题标题", 200);
  const type = parseFeedbackType(body.type);
  const description = parseFeedbackText(body.description, "问题描述", 5000);
  const id = crypto.randomUUID();
  const submittedAt = nowIso();
  const storedPaths = [];

  try {
    for (const file of files) {
      const extension = path.extname(file.originalname || "").toLowerCase();
      if (!feedbackImageExts.has(extension))
        throw httpError(400, "反馈图片仅支持 JPG、PNG、WebP 格式");
      try {
        await sharp(file.buffer).metadata();
      } catch {
        throw httpError(400, "反馈图片文件无法识别");
      }
      const filename = `${crypto.randomUUID()}${extension}`;
      const relativePath = `feedback/${filename}`;
      await fs.writeFile(path.join(feedbackUploadDir, filename), file.buffer);
      storedPaths.push(relativePath);
    }

    await insertFeedbackStmt.run({
      id,
      title,
      type,
      description,
      imagePaths: JSON.stringify(storedPaths),
      submitter: user.username,
      submittedAt,
      updatedAt: submittedAt,
    });
    return await feedbackDto(await selectFeedbackByIdStmt.get(id));
  } catch (error) {
    await Promise.all(
      storedPaths.map((relativePath) =>
        fs.unlink(path.join(uploadDir, relativePath)).catch(() => {}),
      ),
    );
    throw error;
  }
}

function assertFeedbackAccess(feedback, user) {
  if (!feedback) throw httpError(404, "问题反馈不存在");
  if (user?.role !== "admin" && feedback.submitter !== user?.username) {
    throw httpError(403, "无权访问该反馈");
  }
}

async function addFeedbackMessage(id, body, user) {
  const feedback = await selectFeedbackByIdStmt.get(id);
  if (!feedback) throw httpError(404, "问题反馈不存在");
  if (feedback.status === "resolved") {
    throw httpError(409, "该反馈已解决，不能继续回复");
  }
  const content = parseFeedbackText(
    body?.content ?? body?.reply,
    "回复内容",
    5000,
  );
  const requestedStatus = body?.status
    ? parseFeedbackStatus(body.status)
    : null;
  if (requestedStatus === "pending") {
    throw httpError(400, "反馈回复后不能恢复为未处理");
  }
  const status =
    requestedStatus ||
    (feedback.status === "pending" ? "processing" : feedback.status);
  const repliedAt = nowIso();
  await db.exec("BEGIN");
  try {
    await insertFeedbackMessageStmt.run({
      id: crypto.randomUUID(),
      feedbackId: feedback.id,
      author: user.username,
      authorRole: user.role,
      content,
      createdAt: repliedAt,
    });
    await updateFeedbackReplyStmt.run({
      id,
      status,
      reply: content,
      repliedBy: user.username,
      repliedAt,
      updatedAt: repliedAt,
    });
    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  return await feedbackDto(await selectFeedbackByIdStmt.get(id));
}

async function updateFeedbackStatus(id, statusValue, user) {
  const feedback = await selectFeedbackByIdStmt.get(id);
  assertFeedbackAccess(feedback, user);
  const status = parseFeedbackStatus(statusValue);
  if (status === "pending") throw httpError(400, "反馈状态不能恢复为未处理");
  if (
    status === "resolved" &&
    feedback.status !== "resolved" &&
    !(await selectFeedbackMessageExistsStmt.get(feedback.id))
  ) {
    throw httpError(400, "至少回复一次后才能标记为已解决");
  }
  const updatedAt = nowIso();
  await db.prepare("UPDATE feedbacks SET status = ?, updatedAt = ? WHERE id = ?").run(status, updatedAt, id);
  return await feedbackDto(await selectFeedbackByIdStmt.get(id));
}

async function legacyReplyFeedback(id, body, admin) {
  const feedback = await selectFeedbackByIdStmt.get(id);
  if (!feedback) throw httpError(404, "问题反馈不存在");
  const status = parseFeedbackStatus(body?.status);
  const reply = parseFeedbackText(body?.reply, "答复内容", 5000);
  const repliedAt = nowIso();
  await updateFeedbackReplyStmt.run({
    id,
    status,
    reply,
    repliedBy: admin.username,
    repliedAt,
    updatedAt: repliedAt,
  });
  return await feedbackDto(await selectFeedbackByIdStmt.get(id));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function parseScorerName(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 100) throw httpError(400, "打分人不能超过 100 字");
  return text;
}

function normalizeScorePayload(body) {
  const payload = {};
  const criterionStates =
    body.criterionStates && typeof body.criterionStates === "object"
      ? body.criterionStates
      : {};

  for (const key of scoreNumericFields) {
    const isSkippable = skippableScoreFields.includes(key);
    const stateKey = scoreStateColumn(key);
    const requestedState = isSkippable
      ? parseScoreState(criterionStates[key] ?? body[stateKey], key)
      : null;

    if (requestedState === "not_applicable") {
      payload[key] = null;
      payload[stateKey] = "not_applicable";
      continue;
    }

    payload[key] = parseScoreValue(body[key], key);
    if (isSkippable) {
      payload[stateKey] = payload[key] === null ? "unrated" : "rated";
    }
  }
  payload.discomfort = parseNullableBoolean(body.discomfort);
  payload.comment = parseComment(body.comment);
  payload.scorer = parseScorerName(body.scorer);
  payload.ratedAt = nowIso();
  return payload;
}

function scoreFromRow(row) {
  if (!row) return null;
  const criterionStates = Object.fromEntries(
    skippableScoreFields.map((key) => {
      const state = row[scoreStateColumn(key)];
      return [
        key,
        ["unrated", "rated", "not_applicable"].includes(state)
          ? state
          : row[key] == null
            ? "unrated"
            : "rated",
      ];
    }),
  );

  return {
    overall: row.overall,
    creativity: row.creativity,
    mood: row.mood,
    composition: row.composition,
    color: row.color,
    lighting: row.lighting,
    realism: row.realism,
    detail: row.detail,
    discomfort:
      row.discomfort === null || row.discomfort === undefined
        ? null
        : Boolean(row.discomfort),
    promptAlignment: row.promptAlignment,
    textCorrectness: row.textCorrectness,
    anatomyNormality: row.anatomyNormality,
    informationClarity: row.informationClarity,
    designQuality: row.designQuality,
    typography: row.typography,
    criterionStates,
    scorer: row.scorer ?? null,
    comment: row.comment ?? "",
    ratedAt: row.ratedAt ?? null,
  };
}

function imageAssetUrl(storagePath) {
  return storagePath ? `/files/${storagePath}` : null;
}

function imageDto(row) {
  return {
    _id: row._id,
    subjectId: row.subjectId,
    filename: row.filename,
    originalPath: row.originalPath,
    category: row.category,
    directory: row.directory || "",
    isInfographic: Boolean(row.isInfographic),
    prompt: row.prompt ?? null,
    catalog: parseCatalogData(row.catalogData),
    imageUrl: imageAssetUrl(row.storagePath),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath),
    score: scoreFromRow(row),
  };
}

function imageListDto(row) {
  return {
    _id: row._id,
    subjectId: row.subjectId,
    filename: row.filename,
    category: row.category,
    directory: row.directory || "",
    isInfographic: Boolean(row.isInfographic),
    imageUrl: imageAssetUrl(row.storagePath),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath),
  };
}

function taskImageDto(row) {
  return {
    _id: row._id,
    subjectId: row.subjectId,
    filename: row.filename,
    originalPath: row.originalPath,
    category: row.category,
    directory: row.directory || "",
    isInfographic: Boolean(row.isInfographic),
    prompt: row.prompt ?? null,
    imageUrl: imageAssetUrl(row.storagePath),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath),
  };
}

function taskListImageDto(row) {
  return {
    _id: row._id,
    filename: row.filename,
    imageUrl: imageAssetUrl(row.storagePath),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath),
  };
}

function subjectDto(row) {
  return row
    ? {
        _id: row._id,
        name: row.name,
        originalFilename: row.originalFilename,
        importBatch: row.importBatch,
        imageCount: row.imageCount,
        categoryCount: row.categoryCount,
        taskTemplateCount: Number(row.taskTemplateCount || 0),
        status: row.status,
        taskStatus: row.taskStatus || "task_pending",
        deletionRequestedAt: row.deletionRequestedAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

function teamDto(row) {
  return row
    ? {
        id: row.id,
        name: row.name,
        status: row.status || "enabled",
        userCount: Number(row.userCount || 0),
        projectCount: Number(row.projectCount || 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

async function getProjectTaskStats(projectId, version = taskVersion) {
  const row = await selectProjectTaskStatsStmt.get(projectId, version);
  return {
    total: Number(row?.total || 0),
    pending: Number(row?.pending || 0),
    assigned: Number(row?.assigned || 0),
    completed: Number(row?.completed || 0),
  };
}

function invalidateTaskSummaryCaches(projectId) {
  subjectTaskReportCache.delete(projectId);
}

const queuedProjectTaskSummaries = new Set();
const dirtyProjectTaskSummaries = new Set();

function queueProjectTaskSummary(projectId) {
  if (queuedProjectTaskSummaries.has(projectId)) {
    dirtyProjectTaskSummaries.add(projectId);
    return;
  }
  queuedProjectTaskSummaries.add(projectId);
  setImmediate(async () => {
    try {
      const taskStats = await getProjectTaskStats(projectId);
      if (taskStats.pending + taskStats.assigned !== 0) return;
      await updateSubjectTaskStatusStmt.run({
        id: projectId,
        taskStatus: "task_completed",
        updatedAt: nowIso(),
      });
    } catch (error) {
      // ponytail: eventual-consistency summary update; use a durable job if
      // recovery after process loss becomes a requirement.
      console.error("failed to update project task summary", error);
    } finally {
      queuedProjectTaskSummaries.delete(projectId);
      if (dirtyProjectTaskSummaries.delete(projectId)) {
        queueProjectTaskSummary(projectId);
      }
    }
  });
}

async function projectStatsByIds(projectIds, version = taskVersion) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db
    .prepare(
      `SELECT projectId, total, pending, assigned, completed
       FROM project_task_stats
       WHERE taskVersion = ?
         AND projectId IN (${placeholders(ids.length)})`,
    )
    .all(version, ...ids);
  return new Map(
    rows.map((row) => [
      row.projectId,
      {
        total: Number(row.total || 0),
        pending: Number(row.pending || 0),
        assigned: Number(row.assigned || 0),
        completed: Number(row.completed || 0),
      },
    ]),
  );
}

async function projectRelatedRowsByIds(projectIds) {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (!ids.length) return new Map();

  const packageRows = await db
    .prepare(
      `SELECT project_packages.projectId AS _projectId,
              subjects.id AS _id,
              subjects.name,
              subjects.originalFilename,
              subjects.imageCount,
              subjects.categoryCount,
              subjects.status,
              subjects.createdAt,
              subjects.updatedAt,
              COUNT(subject_task_templates.id) AS taskTemplateCount
       FROM project_packages
       JOIN subjects ON subjects.id = project_packages.packageId
       LEFT JOIN subject_task_templates
         ON subject_task_templates.subjectId = subjects.id
       WHERE project_packages.projectId IN (${placeholders(ids.length)})
         AND subjects.deletionRequestedAt IS NULL
       GROUP BY project_packages.projectId,
                project_packages.packageId,
                project_packages.createdAt,
                subjects.id,
                subjects.name,
                subjects.originalFilename,
                subjects.imageCount,
                subjects.categoryCount,
                subjects.status,
                subjects.createdAt,
                subjects.updatedAt
       ORDER BY project_packages.projectId ASC,
                project_packages.createdAt ASC,
                subjects.createdAt ASC,
                subjects.id ASC`,
    )
    .all(...ids);
  const teamRows = await db
    .prepare(
      `SELECT project_teams.projectId AS _projectId,
              teams.id,
              teams.name,
              teams.status
       FROM project_teams
       JOIN teams ON teams.id = project_teams.teamId
       WHERE project_teams.projectId IN (${placeholders(ids.length)})
       ORDER BY project_teams.projectId ASC, LOWER(teams.name) ASC, teams.name ASC`,
    )
    .all(...ids);
  const relatedByProjectId = new Map();
  ids.forEach((id) => {
    relatedByProjectId.set(id, { packageRows: [], teamRows: [] });
  });
  packageRows.forEach((row) => {
    relatedByProjectId.get(row._projectId)?.packageRows.push(row);
  });
  teamRows.forEach((row) => {
    relatedByProjectId.get(row._projectId)?.teamRows.push(row);
  });
  return relatedByProjectId;
}

async function mapProjectRows(rows) {
  const statsByProjectId = await projectStatsByIds(rows.map((row) => row._id));
  const relatedByProjectId = await projectRelatedRowsByIds(rows.map((row) => row._id));
  return await Promise.all(rows.map(
    async row => await projectDto(row, statsByProjectId.get(row._id), relatedByProjectId.get(row._id))
  ));
}

async function projectDto(row, taskStats = null, related = null) {
  if (!row) return null;
  const packageRows = related?.packageRows?.length
    ? related.packageRows
    : await selectProjectPackagesStmt.all(row._id);
  const fallbackPackage = row.packageId
    ? [{
        _id: row.packageId,
        name: row.packageName,
        originalFilename: row.packageFilename,
        imageCount: Number(row.imageCount || 0),
        categoryCount: Number(row.categoryCount || 0),
        status: row.packageStatus,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        taskTemplateCount: Number(row.taskTemplateCount || 0),
      }]
    : [];
  const packages = packageRows.length ? packageRows : fallbackPackage;
  const primaryPackage =
    packages.find((item) => item._id === row.packageId) || packages[0] || null;
  const taskTemplateCount = packages.reduce(
    (total, item) => total + Number(item.taskTemplateCount || 0),
    0,
  );
  const stats = taskStats || (await getProjectTaskStats(row._id));
  const generatedTaskCount = stats.total;
  const pendingTaskCount = stats.pending;
  const remainingTemplateCount = Math.max(taskTemplateCount - generatedTaskCount, 0);
  return {
    _id: row._id,
    name: row.name,
    packageId: primaryPackage?._id || row.packageId,
    packageIds: packages.map((item) => item._id),
    packages,
    packageName: primaryPackage?.name || row.packageName,
    packageNames: packages.map((item) => item.name),
    packageFilename: primaryPackage?.originalFilename || row.packageFilename,
    packageStatus: packages.every((item) => item.status === "imported")
      ? "imported"
      : packages.some((item) => item.status === "failed")
        ? "failed"
        : "importing",
    imageCount: packages.reduce(
      (total, item) => total + Number(item.imageCount || 0),
      0,
    ),
    categoryCount: packages.reduce(
      (total, item) => total + Number(item.categoryCount || 0),
      0,
    ),
    taskTemplateCount,
    generatedTaskCount,
    pendingTaskCount,
    remainingTemplateCount,
    availableTaskCount: pendingTaskCount + remainingTemplateCount,
    taskStatus: row.taskStatus || "task_pending",
    deletionRequestedAt: row.deletionRequestedAt ?? null,
    teams: (related?.teamRows || (await selectProjectTeamsStmt.all(row._id))).map(teamDto),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function projectSubjectDto(project, projectView = null) {
  const view = projectView || (await projectDto(project));
  if (!view) return null;
  return {
    _id: view._id,
    name: view.name,
    originalFilename: view.packageNames.join("、"),
    importBatch: view.packageIds.join(","),
    imageCount: view.imageCount,
    categoryCount: view.categoryCount,
    taskTemplateCount: view.taskTemplateCount,
    status: view.packageStatus,
    taskStatus: view.taskStatus,
    deletionRequestedAt: view.deletionRequestedAt,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

async function listProjects() {
  return await mapProjectRows(await selectProjectsStmt.all());
}

async function listProjectsPage(query = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const total = (await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM projects
       JOIN subjects ON subjects.id = projects.packageId
       WHERE projects.deletionRequestedAt IS NULL`,
    )
    .get()).total;
  const projectRows = await db
    .prepare(
      `SELECT ${projectSelectColumns}
       FROM projects
       JOIN subjects ON subjects.id = projects.packageId
       WHERE projects.deletionRequestedAt IS NULL
       ORDER BY projects.createdAt DESC, projects.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(pageSize, (page - 1) * pageSize);
  const projects = await mapProjectRows(projectRows);
  return { total, page, pageSize, projects };
}

function normalizeTeamNames(value) {
  if (!Array.isArray(value)) return [];
  const names = [];
  const seen = new Set();
  for (const item of value) {
    const name = String(item ?? "").trim();
    if (!name) continue;
    if (name.length > 60) throw httpError(400, "团队名称不能超过 60 字");
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length > 20) throw httpError(400, "每个账号最多关联 20 个团队");
  return names;
}

async function normalizeTeamIds(value, { required = false, enabledOnly = false } = {}) {
  if (!Array.isArray(value)) {
    if (required) throw httpError(400, "请选择标注团队");
    return [];
  }
  const ids = [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (required && !ids.length) throw httpError(400, "请选择标注团队");
  if (ids.length > 20) throw httpError(400, "最多选择 20 个团队");
  const teams = await Promise.all(ids.map(async id => await selectTeamByIdStmt.get(id)));
  const missing = ids.filter((_, index) => !teams[index]);
  if (missing.length) throw httpError(400, "存在已删除的团队，请刷新后重试");
  const disabled = teams.filter((team) => team.status === "disabled");
  if (enabledOnly && disabled.length) {
    throw httpError(
      400,
      `以下团队已禁用：${disabled.map((team) => team.name).join("、")}`,
    );
  }
  return ids;
}

async function ensureTeams(teamNames, now) {
  return await Promise.all(teamNames.map(async name => {
    let team = await selectTeamByNameStmt.get(name);
    if (!team) {
      const id = crypto.randomUUID();
      await insertTeamStmt.run({ id, name, createdAt: now, updatedAt: now });
      team = await selectTeamByIdStmt.get(id);
    }
    return team.id;
  }));
}

function parseEnabledStatus(value, label, { optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) {
    return null;
  }
  const status = String(value ?? "").trim();
  if (status !== "enabled" && status !== "disabled") {
    throw httpError(400, `${label}状态不正确`);
  }
  return status;
}

function parseTeamName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw httpError(400, "请输入团队名称");
  if (name.length > 60) throw httpError(400, "团队名称不能超过 60 字");
  return name;
}

async function listTeams(query = {}) {
  const status = parseEnabledStatus(query.status, "团队", { optional: true });
  if (!status) return (await selectTeamsStmt.all()).map(teamDto);

  return (await db
    .prepare(
      `SELECT teams.id, teams.name, teams.status, teams.createdAt, teams.updatedAt,
              COUNT(DISTINCT user_teams.userId) AS userCount,
              COUNT(DISTINCT project_teams.projectId) AS projectCount
       FROM teams
       LEFT JOIN user_teams ON user_teams.teamId = teams.id
       LEFT JOIN project_teams ON project_teams.teamId = teams.id
       WHERE teams.status = ?
       GROUP BY teams.id
       ORDER BY LOWER(teams.name) ASC, teams.name ASC`,
    )
    .all(status))
    .map(teamDto);
}

async function createTeam(body = {}) {
  const name = parseTeamName(body.name);
  const now = nowIso();
  const id = crypto.randomUUID();
  try {
    await insertTeamStmt.run({ id, name, createdAt: now, updatedAt: now });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "团队已存在");
    }
    throw error;
  }
  return teamDto(await selectTeamByIdStmt.get(id));
}

async function updateTeam(id, body = {}) {
  const team = await selectTeamByIdStmt.get(String(id));
  if (!team) throw httpError(404, "团队不存在");
  const name = Object.hasOwn(body, "name") ? parseTeamName(body.name) : null;
  const status = parseEnabledStatus(body.status, "团队", { optional: true });
  if (!name && !status) return teamDto(await selectTeamByIdStmt.get(team.id));

  try {
    await updateTeamStmt.run({
      id: team.id,
      name,
      status,
      updatedAt: nowIso(),
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "团队已存在");
    }
    throw error;
  }
  return teamDto(await selectTeamByIdStmt.get(team.id));
}

async function syncUserTeams(userId, teamNames, now) {
  const teamIds = await ensureTeams(teamNames, now);
  await deleteUserTeamsStmt.run(userId);
  await Promise.all(teamIds.map(async teamId => {
    await insertUserTeamStmt.run({ userId, teamId, createdAt: now });
  }));
}

async function syncProjectTeams(projectId, teamIds, now) {
  await deleteProjectTeamsStmt.run(projectId);
  await Promise.all(teamIds.map(async teamId => {
    await insertProjectTeamStmt.run({ projectId, teamId, createdAt: now });
  }));
}

async function deleteTeam(id) {
  const team = await selectTeamByIdStmt.get(String(id));
  if (!team) throw httpError(404, "团队不存在");
  const usage = await selectTeamUsageStmt.get(team.id, team.id);
  if (usage.userCount > 0 || usage.projectCount > 0) {
    throw httpError(409, "团队仍有关联账号或项目，不能删除");
  }
  await deleteTeamStmt.run(team.id);
  return { deleted: true };
}

function parseProjectName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw httpError(400, "请输入项目名称");
  if (name.length > 120) throw httpError(400, "项目名称不能超过 120 字");
  return name;
}

async function assertProjectNameAvailable(name, excludeId = null) {
  const existing = await selectProjectByNameStmt.get(name);
  if (existing && existing.id !== excludeId) {
    throw httpError(409, "项目名称已存在");
  }
}

async function projectPackageIds(project) {
  const packageRows = await selectProjectPackagesStmt.all(project._id);
  if (packageRows.length) return packageRows.map((row) => row._id);
  return project.packageId ? [project.packageId] : [];
}

async function normalizeProjectPackageIds(body = {}, fallback = []) {
  const raw = Array.isArray(body.packageIds)
    ? body.packageIds
    : body.packageId != null
      ? [body.packageId]
      : fallback;
  const packageIds = [
    ...new Set(
      raw
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ];
  if (!packageIds.length) throw httpError(400, "请选择至少一个图包");
  if (packageIds.length > 100) throw httpError(400, "一个项目最多关联 100 个图包");

  const packageRows = await Promise.all(packageIds.map(async id => await selectSubjectByIdStmt.get(id)));
  const missing = packageIds.filter((_, index) => !packageRows[index]);
  if (missing.length) throw httpError(400, "存在不存在的图包，请刷新后重试");
  const unavailable = packageRows.filter((row) => row.status !== "imported");
  if (unavailable.length) {
    throw httpError(
      400,
      `以下图包尚未处理完成：${unavailable.map((row) => row.name).join("、")}`,
    );
  }
  return packageIds;
}

async function getProjectOrThrow(projectId) {
  const project = await selectProjectByIdStmt.get(String(projectId));
  if (!project) throw httpError(404, "项目不存在");
  const packageStatuses = await Promise.all((await projectPackageIds(project)).map(async (packageId) => {
    const packageRow = await selectSubjectByIdStmt.get(packageId);
    return !packageRow || packageRow.status !== "imported";
  }));
  if (packageStatuses.some(Boolean)) {
    throw httpError(409, "关联图包尚未处理完成");
  }
  return project;
}

async function createProject(body = {}) {
  const name = parseProjectName(body.name);
  const icon = "archive";
  const packageIds = await normalizeProjectPackageIds(body);
  const packageId = packageIds[0];
  const now = nowIso();
  const id = crypto.randomUUID();
  await db.exec("BEGIN");
  try {
    await assertProjectNameAvailable(name);
    await insertProjectStmt.run({ id, name, icon, packageId, createdAt: now, updatedAt: now });
    await Promise.all(packageIds.map(async linkedPackageId => {
      await insertProjectPackageStmt.run({
        projectId: id,
        packageId: linkedPackageId,
        createdAt: now,
      });
    }));
    await db.exec("COMMIT");
  } catch (error) {
    try { await db.exec("ROLLBACK"); } catch {}
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "项目名称已存在");
    }
    throw error;
  }
  return await projectDto(await selectProjectByIdStmt.get(id));
}

async function updateProject(id, body = {}) {
  const current = await getProjectOrThrow(id);
  const name = parseProjectName(body.name ?? current.name);
  const icon = "archive";
  const packageIds = await normalizeProjectPackageIds(body, await projectPackageIds(current));
  const packageId = packageIds[0];
  const currentPackageIds = await projectPackageIds(current);
  const packageChanged =
    packageIds.length !== currentPackageIds.length ||
    packageIds.some((item) => !currentPackageIds.includes(item));
  if (packageChanged && (await selectProjectTaskCountStmt.get(id)).total) {
    throw httpError(409, "项目已生成任务，不能更换关联图包");
  }
  const now = nowIso();
  await db.exec("BEGIN");
  try {
    await assertProjectNameAvailable(name, id);
    await updateProjectStmt.run({ id, name, icon, packageId, updatedAt: now });
    await deleteProjectPackagesStmt.run(id);
    await Promise.all(packageIds.map(async linkedPackageId => {
      await insertProjectPackageStmt.run({
        projectId: id,
        packageId: linkedPackageId,
        createdAt: now,
      });
    }));
    await db.exec("COMMIT");
  } catch (error) {
    try { await db.exec("ROLLBACK"); } catch {}
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "项目名称已存在");
    }
    throw error;
  }
  invalidateScorerQueryCaches();
  return await projectDto(await selectProjectByIdStmt.get(id));
}

async function listVisibleProjects(user, query = {}) {
  if (user?.role === "admin") {
    return hasPaginationQuery(query) ? await listProjectsPage(query) : await listProjects();
  }
  const rows = await db
    .prepare(`
      SELECT DISTINCT ${projectSelectColumns}
      FROM projects
      JOIN subjects ON subjects.id = projects.packageId
      JOIN rating_tasks ON rating_tasks.projectId = projects.id
      WHERE projects.deletionRequestedAt IS NULL
        AND rating_tasks.taskVersion = ?
        AND rating_tasks.scorer = ?
        AND rating_tasks.status IN ('assigned', 'completed')
      ORDER BY projects.createdAt DESC, projects.id ASC
    `)
    .all(taskVersion, user?.username || "");
  return await mapProjectRows(rows);
}

async function deleteProject(id) {
  const project = await getProjectOrThrow(id);
  const activeJobId = activeTaskGenerationBySubject.get(project._id);
  const activeJob = activeJobId ? taskGenerationJobs.get(activeJobId) : null;
  if (activeJob && ["queued", "running"].includes(activeJob.status)) {
    throw httpError(409, "任务正在生成，请等待生成完成后再删除项目");
  }

  await db.exec("BEGIN");
  try {
    const deletedTaskCount = (await deleteUncompletedProjectTasksStmt.run(project._id)).changes;
    await deleteProjectUserLinksStmt.run(project._id);
    if (!(await deleteProjectStmt.run(project._id)).changes) {
      throw httpError(404, "项目不存在");
    }
    await db.exec("COMMIT");
    invalidateTaskSummaryCaches(project._id);
    invalidateScorerQueryCaches();
    return { deleted: true, deletedTaskCount };
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

const queuedSubjectDeletionIds = new Set();

function queueSubjectDeletion(subjectId) {
  if (queuedSubjectDeletionIds.has(subjectId)) return;

  queuedSubjectDeletionIds.add(subjectId);
  setImmediate(async () => {
    void (await runWithDatabaseContext(() => deleteQueuedSubject(subjectId)));
  });
}

async function deleteQueuedSubject(subjectId) {
  try {
    const subject = await selectSubjectPendingDeletionStmt.get(subjectId);
    if (!subject) return;

    const images = await selectSubjectStoragePathsStmt.all(subjectId);
    if (subject.storageRoot) {
      await fs
        .rm(path.join(uploadDir, subject.storageRoot), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    } else {
      await Promise.all(
        images.map((row) =>
          fs.unlink(path.join(uploadDir, row.storagePath)).catch(() => {}),
        ),
      );
    }

    await db.exec("BEGIN");
    try {
      await deleteQueuedSubjectStmt.run(subjectId);
      await db.exec("COMMIT");
      invalidateScorerQueryCaches();
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } catch (error) {
    console.error(`Failed to delete queued subject ${subjectId}`, error);
  } finally {
    queuedSubjectDeletionIds.delete(subjectId);
  }
}

async function assertPackageCanBeDeleted(packageId) {
  const projectCount = (await selectPackageProjectCountStmt.get(packageId)).total;
  if (projectCount) {
    throw httpError(409, "该图包已关联项目，无法删除；请先删除未开始的项目");
  }
}

async function userDto(row) {
  return row
    ? {
        id: row.id,
        username: row.username,
        role: row.role,
        teams: row.role === "scorer" ? (await selectUserTeamsStmt.all(row.id)).map(teamDto) : [],
        status: row.status || "enabled",
        disabledByTeam: row.role === "scorer"
          ? Boolean(await selectDisabledTeamForUserStmt.get(row.id))
          : false,
        lastLoginAt: row.lastLoginAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    : null;
}

function normalizeUsername(value) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, "请输入用户名");
  if (text.length > 100) throw httpError(400, "用户名不能超过 100 字");
  return text;
}

function parseUserPassword(value) {
  const text = String(value ?? "").trim();
  if (!text) return "123456";
  if (text.length > 100) throw httpError(400, "密码不能超过 100 字");
  return text;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedPassword) {
  const value = String(storedPassword || "");
  const parts = value.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const expected = Buffer.from(parts[2], "hex");
  if (!expected.length) return false;
  const actual = crypto.scryptSync(password, parts[1], expected.length);
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

async function scorerAvailabilityError(user) {
  if (!user || user.role !== "scorer") return null;
  if ((user.status || "enabled") !== "enabled") {
    return httpError(403, "账号已禁用，请联系管理员");
  }
  const disabledTeam = await selectDisabledTeamForUserStmt.get(user.id);
  if (disabledTeam) {
    return httpError(403, `所属团队“${disabledTeam.name}”已禁用，无法登录`);
  }
  return null;
}

async function assertScorerAssignable(user, scorerName = user?.username) {
  const error = await scorerAvailabilityError(user);
  if (!error) return;
  const message = String(error.message || "账号不可用").replace("，无法登录", "");
  throw httpError(400, `打分人 ${scorerName || ""}${message ? `：${message}` : "不可用"}`);
}

function cookieValue(header, name) {
  const prefix = `${name}=`;
  const entry = String(header || "")
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(prefix.length));
  } catch {
    return null;
  }
}

function sessionTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSession(user) {
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString();
  await deleteExpiredSessionsStmt.run(createdAt);
  await insertSessionStmt.run({
    tokenHash: sessionTokenHash(token),
    userId: user.id,
    createdAt,
    expiresAt,
    lastSeenAt: createdAt,
  });
  return { token, expiresAt };
}

function setSessionCookie(res, token, expiresAt) {
  res.cookie("image_rating_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: sessionDurationMs,
    expires: new Date(expiresAt),
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie("image_rating_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
  });
}

async function touchSessionSeenAt(tokenHash) {
  const now = Date.now();
  const lastWriteAt = sessionSeenWriteAt.get(tokenHash) || 0;
  if (now - lastWriteAt < sessionSeenWriteIntervalMs) return;

  await updateSessionSeenStmt.run(new Date(now).toISOString(), tokenHash);
  sessionSeenWriteAt.set(tokenHash, now);

  if (sessionSeenWriteAt.size > 10000) {
    for (const [hash, seenAt] of sessionSeenWriteAt) {
      if (now - seenAt >= sessionSeenWriteIntervalMs) {
        sessionSeenWriteAt.delete(hash);
      }
    }
  }
}

async function requireAuth(req, _res, next) {
  try {
    if (req.method === "OPTIONS") return next();
    const token = cookieValue(req.headers.cookie, "image_rating_session");
    if (!token) return next(httpError(401, "请先登录"));

    const tokenHash = sessionTokenHash(token);
    const user = await selectSessionUserStmt.get(tokenHash, nowIso());
    if (!user) {
      await deleteSessionStmt.run(tokenHash);
      sessionSeenWriteAt.delete(tokenHash);
      return next(httpError(401, "登录已过期，请重新登录"));
    }
    const availabilityError = await scorerAvailabilityError(user);
    if (availabilityError) {
      await deleteSessionStmt.run(tokenHash);
      sessionSeenWriteAt.delete(tokenHash);
      return next(availabilityError);
    }

    await touchSessionSeenAt(tokenHash);
    req.auth = await userDto(user);
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, _res, next) {
  if (req.method === "OPTIONS") return next();
  if (req.auth?.role !== "admin") return next(httpError(403, "需要管理员权限"));
  return next();
}

function requireScorer(req, _res, next) {
  if (req.method === "OPTIONS") return next();
  if (req.auth?.role !== "scorer")
    return next(httpError(403, "需要打分账号权限"));
  return next();
}

async function assertSubjectAccess(subjectId, user) {
  const project = await selectProjectByIdStmt.get(subjectId);
  if (!project) {
    const subject = await selectSubjectByIdStmt.get(subjectId);
    if (!subject) throw httpError(404, "项目不存在");
    if (user?.role === "admin") return subject;
    const assignedToPackage = await db
      .prepare(
        `SELECT 1 FROM rating_tasks
         WHERE subjectId = ? AND scorer = ? AND status IN ('assigned', 'completed')
         LIMIT 1`,
      )
      .get(subjectId, user?.username || "");
    if (!assignedToPackage) throw httpError(403, "无权访问该项目");
    return subject;
  }
  if (user?.role === "admin") return project;

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

async function listVisibleSubjects(user) {
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
       WHERE subjects.deletionRequestedAt IS NULL
         AND rating_tasks.taskVersion = ?
         AND rating_tasks.scorer = ?
         AND rating_tasks.status IN ('assigned', 'completed')
       ORDER BY subjects.createdAt DESC`,
    )
    .all(taskVersion, user?.username || "");
}

function ensureFileAccess(req, _res, next) {
  let storagePath;
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

async function parseProjectId(value) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, "请选择项目");
  return (await getProjectOrThrow(text))._id;
}

async function loginUser(body = {}) {
  const username = normalizeUsername(body.username);
  const password = String(body.password ?? "");
  if (!password) throw httpError(401, "用户名或密码不正确");

  const now = nowIso();
  if (username === "admin") {
    const admin = await selectUserAuthByUsernameStmt.get(username);
    if (
      !admin ||
      admin.role !== "admin" ||
      !verifyPassword(password, admin.password)
    )
      throw httpError(401, "用户名或密码不正确");
    await updateUserLoginStmt.run({ id: admin.id, lastLoginAt: now, updatedAt: now });
    return await userDto(await selectUserByUsernameStmt.get(username));
  }

  const scorer = await selectScorerByUsernameStmt.get(username);
  if (
    !scorer ||
    scorer.role !== "scorer" ||
    !verifyPassword(password, scorer.password)
  )
    throw httpError(401, "用户名或密码不正确");
  const availabilityError = await scorerAvailabilityError(scorer);
  if (availabilityError) throw availabilityError;
  await updateUserLoginStmt.run({ id: scorer.id, lastLoginAt: now, updatedAt: now });
  return await userDto(await selectUserByIdStmt.get(scorer.id));
}

async function listScorerUsers(query = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const username = String(query.username ?? "").trim();
  const teamIds = await normalizeTeamIds(parseQueryList(query.teamIds ?? query.teamId));
  const lastLoginStart = parseOptionalDateFilter(
    query.lastLoginStart ?? query.loginStart,
    "登录开始日期",
  );
  const lastLoginEnd = parseOptionalDateFilter(
    query.lastLoginEnd ?? query.loginEnd,
    "登录结束日期",
  );
  if (lastLoginStart && lastLoginEnd && lastLoginStart > lastLoginEnd) {
    throw httpError(400, "登录开始日期不能晚于结束日期");
  }

  const clauses = ["users.role = 'scorer'"];
  const params = [];
  if (username) {
    clauses.push("users.username LIKE ? ESCAPE '\\'");
    params.push(`%${escapeSqlLike(username)}%`);
  }
  if (teamIds.length) {
    clauses.push(
      `EXISTS (
        SELECT 1
        FROM user_teams
        WHERE user_teams.userId = users.id
          AND user_teams.teamId IN (${placeholders(teamIds.length)})
      )`,
    );
    params.push(...teamIds);
  }
  if (lastLoginStart) {
    clauses.push("users.lastLoginAt >= ?");
    params.push(lastLoginStart);
  }
  if (lastLoginEnd) {
    clauses.push("users.lastLoginAt <= ?");
    params.push(lastLoginEnd);
  }

  const where = `WHERE ${clauses.join(" AND ")}`;
  const total = (await db
    .prepare(`SELECT COUNT(*) AS total FROM users ${where}`)
    .get(...params)).total;
  const rows = await db
    .prepare(
      `SELECT ${userSelectColumns}
       FROM users
       ${where}
       ORDER BY createdAt DESC, LOWER(username) ASC, username ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return {
    total,
    page,
    pageSize,
    users: await Promise.all(rows.map(async user => await userDto(user))),
  };
}

async function createScorerUser(body = {}) {
  const username = normalizeUsername(body.username);
  const password = parseUserPassword(body.password);
  const teamNames = normalizeTeamNames(body.teamNames);
  if (username === "admin") throw httpError(409, "admin 是管理员账号");
  const now = nowIso();
  await db.exec("BEGIN");
  try {
    if (await selectUserByUsernameStmt.get(username)) {
      throw httpError(409, "账号已存在");
    }
    const id = crypto.randomUUID();
    await insertScorerUserStmt.run({
      id,
      username,
      password: hashPassword(password),
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await syncUserTeams(id, teamNames, now);
    const user = await selectScorerByUsernameStmt.get(username);
    await db.exec("COMMIT");
    return await userDto(await selectUserByIdStmt.get(user.id));
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "账号已存在");
    }
    throw error;
  }
}

function normalizeBatchUsernames(value) {
  if (!Array.isArray(value)) throw httpError(400, "请输入打分人名单");
  const usernames = [];
  const seen = new Set();
  for (const item of value) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const username = normalizeUsername(raw);
    if (username === "admin") continue;
    if (seen.has(username)) continue;
    seen.add(username);
    usernames.push(username);
  }
  if (!usernames.length) throw httpError(400, "请输入至少一个有效的打分人");
  if (usernames.length > 1000) throw httpError(400, "一次最多添加 1000 个账号");
  return usernames;
}

async function createScorerUsers(body = {}) {
  const usernames = normalizeBatchUsernames(body.usernames);
  const password = parseUserPassword(body.password);
  const teamNames = normalizeTeamNames(body.teamNames);
  const skipped = [];
  const created = [];
  const now = nowIso();

  await db.exec("BEGIN");
  try {
    for (const username of usernames) {
      if (await selectUserByUsernameStmt.get(username)) {
        skipped.push({ username, reason: "账号已存在" });
        continue;
      }

      const id = crypto.randomUUID();
      await insertScorerUserStmt.run({
        id,
        username,
        password: hashPassword(password),
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await syncUserTeams(id, teamNames, now);
      created.push(await userDto(await selectUserByIdStmt.get(id)));
    }
    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    if (isUniqueConstraintError(error)) {
      throw httpError(409, "账号已存在，请刷新后重试");
    }
    throw error;
  }

  return {
    users: created,
    createdCount: created.length,
    skipped,
    skippedCount: skipped.length,
  };
}

async function updateScorerUser(id, body = {}) {
  const user = await selectUserByIdStmt.get(String(id));
  if (!user || user.role !== "scorer") throw httpError(404, "打分账号不存在");
  const passwordValue = String(body.password ?? "").trim();
  if (passwordValue.length > 100) throw httpError(400, "密码不能超过 100 字");
  const status = parseEnabledStatus(body.status, "账号", { optional: true });
  const shouldSyncTeams = Object.hasOwn(body, "teamNames");
  const teamNames = shouldSyncTeams ? normalizeTeamNames(body.teamNames) : [];
  const now = nowIso();
  await db.exec("BEGIN");
  try {
    await updateScorerUserStmt.run({
      id: user.id,
      password: passwordValue ? hashPassword(passwordValue) : null,
      status,
      updatedAt: now,
    });
    if (shouldSyncTeams) await syncUserTeams(user.id, teamNames, now);
    await db.exec("COMMIT");
  } catch (error) {
    try { await db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return await userDto(await selectUserByIdStmt.get(user.id));
}

function normalizeTeamMatchMode(value) {
  const mode = String(value ?? "all").trim().toLowerCase();
  if (mode !== "all" && mode !== "any") {
    throw httpError(400, "团队匹配方式无效");
  }
  return mode;
}

async function listScorersByTeamIds(teamIds, matchMode = "all") {
  if (!teamIds.length) return [];
  const normalizedMatchMode = normalizeTeamMatchMode(matchMode);
  const matchClause = normalizedMatchMode === "all"
    ? `HAVING COUNT(DISTINCT user_teams.teamId) = ?`
    : "";
  const params = normalizedMatchMode === "all"
    ? [...teamIds, teamIds.length]
    : teamIds;
  return (await db
    .prepare(
      `SELECT users.id, users.username
       FROM users
       JOIN user_teams ON user_teams.userId = users.id
       WHERE users.role = 'scorer'
         AND users.status = 'enabled'
         AND user_teams.teamId IN (${placeholders(teamIds.length)})
         AND NOT EXISTS (
           SELECT 1
           FROM user_teams AS disabled_user_teams
           JOIN teams ON teams.id = disabled_user_teams.teamId
           WHERE disabled_user_teams.userId = users.id
             AND teams.status = 'disabled'
         )
       GROUP BY users.id, users.username
       ${matchClause}
       ORDER BY LOWER(users.username) ASC, users.username ASC`,
    )
    .all(...params))
    .map((user) => ({ id: user.id, username: user.username }));
}

async function deleteScorerUser(id) {
  const user = await selectUserByIdStmt.get(String(id));
  if (!user || user.role !== "scorer") throw httpError(404, "打分账号不存在");
  const assignedTaskCount = (await selectAssignedTaskCountByScorerStmt.get(user.username)).total;
  if (assignedTaskCount > 0) {
    throw httpError(
      409,
      `该账号仍有 ${assignedTaskCount} 个未完成任务，请先重新分配任务`,
    );
  }
  const result = await deleteScorerUserStmt.run(String(id));
  if (result.changes === 0) throw httpError(404, "打分账号不存在");
  return { deleted: true };
}

function deterministicTaskId(projectId, taskType, imageIds) {
  const imageKey = [...imageIds].sort().join("|");
  return crypto
    .createHash("sha256")
    .update(`${projectId}|${taskVersion}|${taskType}|${imageKey}`)
    .digest("hex");
}

function seededShuffle(items, seedText) {
  const output = [...items];
  const seedBytes = crypto.createHash("sha256").update(seedText).digest();
  let state = seedBytes.readUInt32BE(0) || 1;

  const nextRandom = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  for (let index = output.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return output;
}

function dimensionTaskType(projectId, packageId, criterion) {
  const baseType = `dimension:${criterion}`;
  // Legacy projects use the original key. New projects can safely share a
  // package because the legacy unique index also sees the project suffix.
  return projectId === packageId ? baseType : `${baseType}:project:${projectId}`;
}

async function hydrateSubjectTaskTemplates(templates) {
  if (!templates.length) return [];

  const templateIds = templates.map((template) => template.id);
  // Keep large imports bounded by loading template items in batches.
  const itemRows = [];
  const itemRowsStmtCache = new Map();
  for (let start = 0; start < templateIds.length; start += 500) {
    const batch = templateIds.slice(start, start + 500);
    let stmt = itemRowsStmtCache.get(batch.length);
    if (!stmt) {
      stmt = db.prepare(
        `SELECT templateId, imageId, position, role
         FROM subject_task_template_items
         WHERE templateId IN (${placeholders(batch.length)})
         ORDER BY templateId ASC, position ASC, imageId ASC`,
      );
      itemRowsStmtCache.set(batch.length, stmt);
    }
    itemRows.push(...(await stmt.all(...batch)));
    if (start + batch.length < templateIds.length) {
      await yieldToEventLoop();
    }
  }
  const itemsByTemplateId = new Map();
  itemRows.forEach((item) => {
    const items = itemsByTemplateId.get(item.templateId) || [];
    items.push(item);
    itemsByTemplateId.set(item.templateId, items);
  });

  return templates.map((template) => ({
    ...template,
    items: itemsByTemplateId.get(template.id) || [],
  }));
}

async function loadSubjectTaskTemplates(subjectId, limit = null) {
  const templates = limit == null
    ? await selectSubjectTaskTemplatesStmt.all(subjectId)
    : await db.prepare(`
        SELECT id, subjectId, sourceTaskId, round, criterion, imageKey, selectionKey
        FROM subject_task_templates
        WHERE subjectId = ?
        ORDER BY selectionKey ASC, id ASC
        LIMIT ?
      `).all(subjectId, limit);
  return hydrateSubjectTaskTemplates(templates);
}

async function loadProjectTaskTemplates(projectId) {
  const project = await selectProjectByIdStmt.get(projectId);
  if (!project) throw httpError(404, "项目不存在");
  const packageIds = await projectPackageIds(project);
  if (!packageIds.length) return [];

  const templates = [];
  for (const packageId of packageIds) {
    const packageTemplates = await loadSubjectTaskTemplates(packageId);
    templates.push(...packageTemplates.map((template) => ({
      ...template,
      packageId,
    })));
    await yieldToEventLoop();
  }
  return templates;
}

async function loadUnmaterializedProjectTaskTemplates(projectId, limit) {
  const requestedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!requestedLimit) return [];

  const project = await selectProjectByIdStmt.get(projectId);
  if (!project) throw httpError(404, "项目不存在");
  const packageIds = await projectPackageIds(project);
  if (!packageIds.length) return [];

  const templates = await db.prepare(`
    SELECT
      subject_task_templates.id,
      subject_task_templates.subjectId,
      subject_task_templates.sourceTaskId,
      subject_task_templates.round,
      subject_task_templates.criterion,
      subject_task_templates.imageKey
    FROM subject_task_templates
    LEFT JOIN rating_tasks
      ON rating_tasks.projectId = ?
     AND rating_tasks.taskVersion = ?
     AND rating_tasks.subjectId = subject_task_templates.subjectId
     AND rating_tasks.round = subject_task_templates.round
     AND rating_tasks.taskType = CASE
       WHEN subject_task_templates.subjectId = ?
         THEN 'dimension:' || subject_task_templates.criterion
       ELSE 'dimension:' || subject_task_templates.criterion || ':project:' || ?
     END
     AND rating_tasks.imageKey = subject_task_templates.imageKey
    WHERE subject_task_templates.subjectId IN (${placeholders(packageIds.length)})
      AND rating_tasks.id IS NULL
    ORDER BY subject_task_templates.selectionKey ASC,
             subject_task_templates.id ASC
    LIMIT ?
  `).all(
    projectId,
    taskVersion,
    projectId,
    projectId,
    ...packageIds,
    requestedLimit
  );

  return (await hydrateSubjectTaskTemplates(templates)).map((template) => ({
    ...template,
    packageId: template.subjectId,
  }));
}

function buildGeneratedTaskRecord(projectId, template, scorer) {
  const imageIds = template.items.map((item) => item.imageId);
  const taskType = dimensionTaskType(projectId, template.packageId, template.criterion);
  const id = deterministicTaskId(projectId, taskType, imageIds);
  const now = nowIso();
  return {
    id,
    subjectId: template.packageId,
    projectId,
    taskVersion,
    round: Number(template.round || 1),
    taskType,
    status: scorer ? "assigned" : "pending",
    scorer: scorer || null,
    ranking: null,
    assignmentKey: crypto.randomInt(1, 2147483647),
    imageKey: template.imageKey,
    createdAt: now,
    updatedAt: now,
    items: template.items.map((item) => ({
      taskId: id,
      imageId: item.imageId,
      position: item.position,
      role: item.role,
    })),
  };
}

async function bulkInsertRatingTasks(taskRows) {
  if (!taskRows.length) return 0;
  const sql = `
    INSERT INTO rating_tasks (
      id, subjectId, projectId, taskVersion, round, taskType, status, scorer, ranking, assignmentKey, imageKey, createdAt, updatedAt
    ) VALUES ${taskRows.map(() => `(${placeholders(13)})`).join(", ")}
    ON CONFLICT DO NOTHING
  `;
  const params = [];
  taskRows.forEach((row) => {
    params.push(
      row.id,
      row.subjectId,
      row.projectId,
      row.taskVersion,
      row.round,
      row.taskType,
      row.status,
      row.scorer,
      row.ranking,
      row.assignmentKey,
      row.imageKey,
      row.createdAt,
      row.updatedAt,
    );
  });
  return (await db.prepare(sql).run(...params)).changes;
}

async function bulkInsertRatingTaskItems(itemRows) {
  if (!itemRows.length) return 0;
  const sql = `
    INSERT INTO rating_task_items (taskId, imageId, position, role)
    VALUES ${itemRows.map(() => "(?, ?, ?, ?)").join(", ")}
    ON CONFLICT DO NOTHING
  `;
  const params = [];
  itemRows.forEach((row) => {
    params.push(row.taskId, row.imageId, row.position, row.role);
  });
  return (await db.prepare(sql).run(...params)).changes;
}

function compressTaskAllocations(plan) {
  const allocations = [];
  for (const scorer of plan) {
    const last = allocations[allocations.length - 1];
    if (last && last.scorer === scorer) {
      last.taskCount += 1;
    } else {
      allocations.push({ scorer, taskCount: 1 });
    }
  }
  return allocations;
}

function parseTaskPagination(query = {}) {
  const page = Math.max(Math.floor(Number(query.page) || 1), 1);
  const pageSize = Math.min(
    Math.max(Math.floor(Number(query.pageSize) || 10), 1),
    100,
  );
  return { page, pageSize };
}

function hasPaginationQuery(query = {}) {
  return Object.hasOwn(query, "page") || Object.hasOwn(query, "pageSize");
}

function parseTaskCursor(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw httpError(400, "浠诲姟鍒嗛〉游标格式不正确");
  }
  const taskType = String(parsed?.taskType ?? "");
  const createdAt = String(parsed?.createdAt ?? "");
  const id = String(parsed?.id ?? "");
  const criterionOrder = Number(parsed?.criterionOrder);
  if (!taskType || !createdAt || !id) {
    throw httpError(400, "浠诲姟鍒嗛〉游标格式不正确");
  }
  return {
    taskType,
    createdAt,
    id,
    criterionOrder: Number.isFinite(criterionOrder) ? criterionOrder : null,
  };
}

function serializeTaskCursor(row, criterionOrder = null) {
  return JSON.stringify({
    taskType: row.taskType,
    createdAt: row.createdAt,
    id: row.id,
    ...(criterionOrder == null ? {} : { criterionOrder }),
  });
}

function includeTaskTotal(query = {}) {
  return ["1", "true", "yes"].includes(
    String(query.includeTotal ?? "").toLowerCase(),
  );
}

function escapeSqlLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

function parseOptionalDateFilter(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw httpError(400, `${label}不正确`);
  return date.toISOString();
}

function parseQueryList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => String(item ?? "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function placeholders(length) {
  return Array.from({ length }, () => "?").join(", ");
}

function parseStoredTaskImageIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.map((item) => String(item ?? "").trim()).filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

function parseStoredTaskRankingRelations(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => ![">", "="].includes(item))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function hydrateTaskRows(rows) {
  const taskIds = rows.map((row) => row.id);
  const itemsByTaskId = new Map();

  if (taskIds.length) {
    const taskIdPlaceholders = placeholders(taskIds.length);
    const itemRows = await db
      .prepare(
        `
      SELECT taskId, imageId, position, role
      FROM rating_task_items
      WHERE taskId IN (${taskIdPlaceholders})
      ORDER BY taskId ASC, position ASC
    `,
      )
      .all(...taskIds);
    const imageIds = [...new Set(itemRows.map((item) => item.imageId))];
    const imageById = new Map();

    if (imageIds.length) {
      const imageRows = await db
        .prepare(
          `
        SELECT ${taskImageSelectColumns}
        FROM images
        WHERE id IN (${placeholders(imageIds.length)})
      `,
      )
      .all(...imageIds);
      imageRows.forEach((image) =>
        imageById.set(image._id, taskImageDto(image)),
      );
    }

    itemRows.forEach((item) => {
      const image = imageById.get(item.imageId);
      if (!image) return;
      const currentItems = itemsByTaskId.get(item.taskId) || [];
      currentItems.push({
        imageId: item.imageId,
        position: item.position,
        role: item.role,
        image,
      });
      itemsByTaskId.set(item.taskId, currentItems);
    });
  }

  return rows.map((row) => ({
    id: row.id,
    subjectId: row.subjectId,
    projectId: row.projectId || row.subjectId,
    subjectName: row.subjectName ?? null,
    taskVersion: row.taskVersion,
    taskType: row.taskType,
    criterion: row.taskType.split(":")[1] || null,
    status: row.status,
    scorer: row.scorer,
    ranking: row.ranking ? JSON.parse(row.ranking) : null,
    excludedImageIds: parseStoredTaskImageIds(row.excludedImageIds),
    correctImageIds: parseStoredTaskImageIds(row.correctImageIds),
    rankingRelations: parseStoredTaskRankingRelations(row.rankingRelations),
    submissionMode: row.submissionMode || null,
    rankingActionCount: Number(row.rankingActionCount || 0),
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    durationMs: row.durationMs ?? null,
    editedAt: row.editedAt ?? null,
    editCount: Number(row.editCount || 0),
    rollbackCount: Number(row.rollbackCount || 0),
    lastRolledBackAt: row.lastRolledBackAt ?? null,
    lastRolledBackBy: row.lastRolledBackBy ?? null,
    imageKey: row.imageKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    items: itemsByTaskId.get(row.id) || [],
  }));
}

const adminDashboardService = createAdminDashboardService({
  db,
  taskVersion,
  httpError,
  nowIso,
  normalizeTeamIds,
  parseProjectId,
  parseTaskPagination,
  hydrateTaskRows,
  selectUserByIdStmt,
  selectScorerByUsernameStmt,
  selectTeamByIdStmt,
});
const {
  listAdminDashboard,
  getDashboardStats,
  getDashboardProjectSection,
  getDashboardCharts,
  getDashboardAverageDuration,
  getDashboardWorkloadSection,
  exportCompletedTasks,
  exportScorerTaskSummary,
  exportTeamTaskSummary,
} = adminDashboardService;

const adminScoringService = createAdminScoringService({
  db,
  taskVersion,
  httpError,
  nowIso,
  parseProjectId,
  parseTaskPagination,
  onTasksChanged: () => invalidateScorerQueryCaches(),
});
const {
  listScoringSummary,
  listScoringTaskRecords,
  previewRollback,
  startRollbackJob,
  getRollbackJob,
  rollbackJobDto,
} = adminScoringService;

async function hydrateTaskListRows(rows) {
  const taskIds = rows.map((row) => row.id);
  const itemsByTaskId = new Map();

  if (taskIds.length) {
    const taskIdPlaceholders = placeholders(taskIds.length);
    const itemRows = await db
      .prepare(
        `
      SELECT taskId, imageId, position
      FROM rating_task_items
      WHERE taskId IN (${taskIdPlaceholders})
      ORDER BY taskId ASC, position ASC
    `,
      )
      .all(...taskIds);
    const imageIds = [...new Set(itemRows.map((item) => item.imageId))];
    const imageById = new Map();

    if (imageIds.length) {
      const imageRows = await db
        .prepare(
          `
        SELECT ${taskListImageSelectColumns}
        FROM images
        WHERE id IN (${placeholders(imageIds.length)})
      `,
        )
        .all(...imageIds);
      imageRows.forEach((image) =>
        imageById.set(image._id, taskListImageDto(image)),
      );
    }

    itemRows.forEach((item) => {
      const image = imageById.get(item.imageId);
      if (!image) return;
      const currentItems = itemsByTaskId.get(item.taskId) || [];
      currentItems.push({
        position: item.position,
        image,
      });
      itemsByTaskId.set(item.taskId, currentItems);
    });
  }

  return rows.map((row) => ({
    ...row,
    items: itemsByTaskId.get(row.id) || [],
  }));
}

function buildSubjectTaskFilter(projectId, query = {}) {
  const clauses = ["projectId = ?", "taskVersion = ?"];
  const params = [projectId, taskVersion];
  const status = String(query.status || "");
  const scorer = parseScorerName(query.scorer);
  const criterion = String(query.criterion || "");

  if (["pending", "assigned", "completed"].includes(status)) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (scorer) {
    clauses.push("scorer = ?");
    params.push(scorer);
  }
  if (taskCriteria.includes(criterion)) {
    const taskType = `dimension:${criterion}`;
    clauses.push("(taskType = ? OR taskType LIKE ?)");
    params.push(taskType, `${taskType}:%`);
  }

  return {
    where: `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

async function listSubjectTaskOptions(projectId) {
  const scorers = (await db
    .prepare(
      `SELECT scorer
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ? AND scorer IS NOT NULL AND scorer <> ''
       GROUP BY scorer
       ORDER BY LOWER(scorer) ASC, scorer ASC`,
    )
    .all(projectId, taskVersion))
    .map((row) => row.scorer);

  return { scorers };
}

async function listSubjectTasks(projectId, query = {}) {
  const { page, pageSize } = parseTaskPagination(query);
  const filter = buildSubjectTaskFilter(projectId, query);
  const cursor = parseTaskCursor(query.cursor);
  const cursorWhere = cursor
    ? ` AND (
         taskType > ?
         OR (
           taskType = ?
           AND (
             createdAt > ?
             OR (createdAt = ? AND id > ?)
           )
         )
       )`
    : "";
  const statusKey = ["pending", "assigned", "completed"].includes(query.status)
    ? query.status
    : "total";
  const statsTotal =
    !query.scorer && !query.criterion
      ? (await getProjectTaskStats(projectId))[statusKey]
      : null;
  const total = statsTotal != null
    ? statsTotal
    : includeTaskTotal(query)
      ? (await db
        .prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${filter.where}`)
        .get(...filter.params)).total
      : null;
  const rows = await db
    .prepare(
      `SELECT id, taskType, status, scorer, createdAt
       FROM rating_tasks
       ${filter.where}
       ${cursorWhere}
       ORDER BY taskType ASC, createdAt ASC, id ASC
       LIMIT ?${cursor ? "" : " OFFSET ?"}`,
    )
    .all(...filter.params, ...(cursor
    ? [cursor.taskType, cursor.taskType, cursor.createdAt, cursor.createdAt, cursor.id]
    : []), pageSize + 1, ...(cursor ? [] : [(page - 1) * pageSize]));
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows[pageRows.length - 1];

  return {
    total,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && lastRow ? serializeTaskCursor(lastRow) : null,
    tasks: (await hydrateTaskListRows(pageRows)).map((row) => ({
      id: row.id,
      criterion: row.taskType.split(":")[1] || null,
      status: row.status,
      scorer: row.scorer,
      createdAt: row.createdAt,
      items: row.items,
    })),
  };
}

function taskCriterionLabel(taskType) {
  const criterion = String(taskType || "").split(":")[1] || "";
  return taskCriterionLabels[criterion] || criterion || "未指定维度";
}

function orderedTaskItems(task) {
  const itemByImageId = new Map(task.items.map((item) => [item.imageId, item]));
  const excludedImageIds = new Set(task.excludedImageIds || []);
  const ordered = [];
  const used = new Set();

  if (Array.isArray(task.ranking)) {
    task.ranking.forEach((imageId) => {
      if (excludedImageIds.has(imageId)) return;
      const item = itemByImageId.get(imageId);
      if (!item || used.has(imageId)) return;
      ordered.push(item);
      used.add(imageId);
    });
  }

  task.items
    .slice()
    .sort((left, right) => left.position - right.position)
    .forEach((item) => {
      if (excludedImageIds.has(item.imageId)) return;
      if (used.has(item.imageId)) return;
      ordered.push(item);
      used.add(item.imageId);
    });
  return ordered;
}

function reportCompletionRate(completed, total) {
  return total ? completed / total : 0;
}

function addReportSheet(workbook, name, headers, rows, widths) {
  const worksheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  worksheet.columns = headers.map((header, index) => ({
    header,
    width: widths?.[index] || 16,
  }));
  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E293B" },
    };
  });

  rows.forEach((values) => {
    const row = worksheet.addRow(values.map((value) => value ?? ""));
    row.alignment = { vertical: "middle", wrapText: true };
  });
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };
  return worksheet;
}

async function getSubjectTaskReportSummary(subjectId) {
  const cached = subjectTaskReportCache.get(subjectId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const project = await getProjectOrThrow(subjectId);
  const packageIds = await projectPackageIds(project);

  const imageStats = await db
    .prepare(
      `SELECT COUNT(*) AS imageCount,
               COUNT(DISTINCT category) AS categoryCount
       FROM images
       WHERE subjectId IN (${placeholders(packageIds.length)})`,
    )
    .get(...packageIds);
  const taskStats = await getProjectTaskStats(subjectId);
  const statusCounts = {
    pending: taskStats.pending,
    assigned: taskStats.assigned,
    completed: taskStats.completed,
  };

  const dimensionRows = await db
    .prepare(
      `SELECT taskType, status, COUNT(*) AS count
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       GROUP BY taskType, status
       ORDER BY taskType ASC`,
    )
    .all(subjectId, taskVersion);
  const dimensionMap = new Map();
  dimensionRows.forEach((row) => {
    const key = row.taskType;
    const item = dimensionMap.get(key) || {
      key: row.taskType,
      criterion: String(row.taskType || "").split(":")[1] || "",
      label: taskCriterionLabel(row.taskType),
      total: 0,
      pending: 0,
      assigned: 0,
      completed: 0,
    };
    item[row.status] = (item[row.status] || 0) + row.count;
    item.total += row.count;
    dimensionMap.set(key, item);
  });

  const scorerRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(scorer), ''), '未分配') AS scorer,
              status, COUNT(*) AS count,
              AVG(CASE WHEN durationMs >= 0 THEN durationMs END) AS averageDurationMs
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       GROUP BY COALESCE(NULLIF(TRIM(scorer), ''), '未分配'), status`,
    )
    .all(subjectId, taskVersion);
  const scorerCriteriaRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(scorer), ''), '未分配') AS scorer,
              taskType
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       GROUP BY COALESCE(NULLIF(TRIM(scorer), ''), '未分配'), taskType
       ORDER BY LOWER(COALESCE(NULLIF(TRIM(scorer), ''), '未分配')) ASC,
                COALESCE(NULLIF(TRIM(scorer), ''), '未分配') ASC,
                taskType ASC`,
    )
    .all(subjectId, taskVersion);
  const scorerMap = new Map();
  scorerRows.forEach((row) => {
    const item = scorerMap.get(row.scorer) || {
      scorer: row.scorer,
      total: 0,
      pending: 0,
      assigned: 0,
      completed: 0,
      averageDurationMs: null,
      criteria: new Set(),
    };
    item[row.status] = (item[row.status] || 0) + row.count;
    item.total += row.count;
    if (row.averageDurationMs != null)
      item.averageDurationMs = row.averageDurationMs;
    scorerMap.set(row.scorer, item);
  });
  scorerCriteriaRows.forEach((row) => {
    const item = scorerMap.get(row.scorer);
    if (item) item.criteria.add(String(row.taskType || "").split(":")[1] || "");
  });

  const totalTasks = taskStats.total;
  const completedTasks = statusCounts.completed;
  const dimensions = [...dimensionMap.values()].map((item) => ({
    ...item,
    completionRate: reportCompletionRate(item.completed, item.total),
  }));
  const scorers = [...scorerMap.values()]
    .sort((left, right) => left.scorer.localeCompare(right.scorer))
    .map((item) => ({
      scorer: item.scorer,
      total: item.total,
      pending: item.pending,
      assigned: item.assigned,
      uncompleted: item.pending + item.assigned,
      completed: item.completed,
      completionRate: reportCompletionRate(item.completed, item.total),
      dimensions: [...item.criteria].filter(Boolean).map((criterion) => ({
        key: criterion,
        label: taskCriterionLabel(`dimension:${criterion}`),
      })),
      averageDurationSeconds:
        item.averageDurationMs == null ? null : item.averageDurationMs / 1000,
    }));

  const report = {
    subject: { _id: project._id, name: project.name },
    imageCount: imageStats.imageCount,
    categoryCount: imageStats.categoryCount,
    criterionCount: new Set(
      dimensions.map((item) => item.criterion).filter(Boolean),
    ).size,
    totalTasks,
    statusCounts,
    completedTasks,
    completionRate: reportCompletionRate(completedTasks, totalTasks),
    scorerCount: scorers.filter((item) => item.scorer !== "未分配").length,
    dimensions,
    scorers,
  };
  subjectTaskReportCache.set(subjectId, {
    value: report,
    expiresAt: Date.now() + subjectTaskReportCacheTtlMs,
  });
  return report;
}

async function exportSubjectTaskReport(subjectId, res) {
  const report = await getSubjectTaskReportSummary(subjectId);
  const subject = report.subject;
  const imageStats = {
    imageCount: report.imageCount,
    categoryCount: report.categoryCount,
  };
  const statusCounts = report.statusCounts;
  const totalTasks = report.totalTasks;
  const completedTasks = report.completedTasks;
  const dimensionStats = report.dimensions;
  const scorerStats = report.scorers;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "评分平台";
  workbook.created = new Date();

  addReportSheet(
    workbook,
    "项目总览",
    ["统计项", "数值"],
    [
      ["项目名称", subject.name],
      ["项目 ID", subject._id],
      ["图片总数", imageStats.imageCount],
      ["目录分类数", imageStats.categoryCount],
      ["评分维度数", report.criterionCount],
      ["任务总数", totalTasks],
      ["待分配任务", statusCounts.pending],
      ["未完成任务", statusCounts.assigned],
      ["已完成任务", completedTasks],
      ["任务完成率", reportCompletionRate(completedTasks, totalTasks)],
      ["打分人数量", report.scorerCount],
      ["导出时间", new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })],
    ],
    [24, 46],
  ).getCell(11, 2).numFmt = "0.00%";

  addReportSheet(
    workbook,
    "状态汇总",
    ["任务状态", "任务数量", "占比"],
    [
      [
        "待分配",
        statusCounts.pending,
        reportCompletionRate(statusCounts.pending, totalTasks),
      ],
      [
        "未完成",
        statusCounts.assigned,
        reportCompletionRate(statusCounts.assigned, totalTasks),
      ],
      [
        "已完成",
        completedTasks,
        reportCompletionRate(completedTasks, totalTasks),
      ],
    ],
    [18, 16, 16],
  ).getColumn(3).numFmt = "0.00%";

  const dimensionRows = dimensionStats.map((item) => [
    item.label,
    item.criterion,
    item.total,
    item.pending,
    item.assigned,
    item.completed,
    reportCompletionRate(item.completed, item.total),
  ]);
  addReportSheet(
    workbook,
    "维度统计",
    [
      "评分维度",
      "维度键",
      "任务总数",
      "待分配",
      "未完成",
      "已完成",
      "完成率",
    ],
    dimensionRows,
    [28, 24, 10, 14, 14, 14, 14],
  ).getColumn(7).numFmt = "0.00%";

  const scorerRows = scorerStats.map((item) => [
    item.scorer,
    item.total,
    item.pending,
    item.assigned,
    item.pending + item.assigned,
    item.completed,
    reportCompletionRate(item.completed, item.total),
    item.dimensions.map((dimension) => dimension.label).join("、"),
    item.averageDurationSeconds,
  ]);
  addReportSheet(
    workbook,
    "打分人统计",
    [
      "打分人",
      "任务总数",
      "待分配",
      "已分配未完成",
      "未完成合计",
      "已完成",
      "完成率",
      "涉及维度",
      "平均打分时长(秒)",
    ],
    scorerRows,
    [18, 14, 14, 18, 16, 14, 14, 52, 22],
  ).getColumn(7).numFmt = "0.00%";

  const filename = `task-report-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.xlsx`;
  const file = Buffer.from(await workbook.xlsx.writeBuffer());
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(file);
}

async function scorerTaskScope(query = {}) {
  const scorer = parseScorerName(query.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const projectId = query.projectId ? await parseProjectId(query.projectId) : null;
  if (!(await selectScorerByUsernameStmt.get(scorer)))
    throw httpError(404, "打分账号不存在");
  return { scorer, projectId };
}

async function buildScorerTaskFilter(query = {}) {
  const { scorer, projectId } = await scorerTaskScope(query);
  const clauses = ["rating_tasks.taskVersion = ?", "rating_tasks.scorer = ?"];
  const params = [taskVersion, scorer];
  const status = String(query.status || "");
  const criterion = String(query.criterion || "");

  if (["assigned", "completed"].includes(status)) {
    clauses.push("rating_tasks.status = ?");
    params.push(status);
  } else {
    clauses.push("rating_tasks.status IN ('assigned', 'completed')");
  }
  if (projectId) {
    clauses.push("rating_tasks.projectId = ?");
    params.push(projectId);
  }
  if (taskCriteria.includes(criterion)) {
    const taskType = `dimension:${criterion}`;
    clauses.push("(rating_tasks.taskType = ? OR rating_tasks.taskType LIKE ?)");
    params.push(taskType, `${taskType}:%`);
  }
  const excludeTaskId = String(query.excludeTaskId || "").trim();
  if (excludeTaskId) {
    clauses.push("rating_tasks.id <> ?");
    params.push(excludeTaskId);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function taskCriterionOrderSql(column) {
  const cases = taskCriteria
    .map((criterion, index) => {
      const taskType = `dimension:${criterion}`;
      return `WHEN ${column} = '${taskType}' OR ${column} LIKE '${taskType}:%' THEN ${index}`;
    })
    .join(" ");
  return `CASE ${cases} ELSE ${taskCriteria.length} END`;
}

const assignedTaskListCache = new Map();
const assignedTaskListCacheTtlMs = 1000;

function invalidateAssignedTaskListCache() {
  assignedTaskListCache.clear();
}

function invalidateScorerQueryCaches() {
  invalidateAssignedTaskListCache();
  scorerDashboardCache.clear();
}

async function assignedTaskOptions(query = {}) {
  const scorer = String(query.scorer || "").trim();
  if (!scorer) throw httpError(400, "缺少打分人");
  if (!(await selectScorerByUsernameStmt.get(scorer))) {
    throw httpError(404, "打分账号不存在");
  }
  const rows = await db.prepare(`
    SELECT projects.id AS _id, projects.name
    FROM scorer_task_stats
    JOIN projects ON projects.id = scorer_task_stats.projectId
    WHERE scorer_task_stats.taskVersion = ?
      AND scorer_task_stats.scorer = ?
      AND scorer_task_stats.projectId <> ''
      AND (scorer_task_stats.assigned + scorer_task_stats.completed) > 0
      AND projects.deletionRequestedAt IS NULL
    ORDER BY projects.createdAt DESC, projects.id ASC
  `).all(taskVersion, scorer);
  return { projects: rows.map(({ _id, name }) => ({ _id, name })) };
}

async function listAssignedTasks(query = {}) {
  const cacheKey = JSON.stringify({
    scorer: query.scorer || null,
    projectId: query.projectId || null,
    page: query.page || 1,
    pageSize: query.pageSize || 10,
    cursor: query.cursor || null,
    status: query.status || null,
    criterion: query.criterion || null,
    excludeTaskId: query.excludeTaskId || null,
    summaryOnly: query.summaryOnly || null,
    includeTotal: includeTaskTotal(query),
  });
  const cached = assignedTaskListCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const filter = await buildScorerTaskFilter(query);
  const { page, pageSize } = parseTaskPagination(query);
  const criterionOrder = taskCriterionOrderSql("rating_tasks.taskType");
  const cursor = parseTaskCursor(query.cursor);
  const cursorOrder = cursor?.criterionOrder;
  const useCursor = Boolean(cursor && cursorOrder != null);
  const cursorWhere = useCursor
    ? ` AND (
         (${criterionOrder}) > ?
         OR (
           (${criterionOrder}) = ?
           AND (
             rating_tasks.createdAt > ?
             OR (rating_tasks.createdAt = ? AND rating_tasks.id > ?)
           )
         )
       )`
    : "";
  const total = includeTaskTotal(query)
    ? (await db
      .prepare(`SELECT COUNT(*) AS total FROM rating_tasks ${filter.where}`)
      .get(...filter.params)).total
    : null;
  const rows = await db
    .prepare(
      `SELECT rating_tasks.id, rating_tasks.subjectId, rating_tasks.projectId,
              rating_tasks.taskType, rating_tasks.status,
              rating_tasks.createdAt,
              ${criterionOrder} AS criterionOrder,
              projects.name AS subjectName
       FROM rating_tasks
       JOIN projects ON projects.id = rating_tasks.projectId
       ${filter.where}
       ${cursorWhere}
       ORDER BY ${criterionOrder} ASC,
                rating_tasks.createdAt ASC,
                rating_tasks.id ASC
       LIMIT ?${useCursor ? "" : " OFFSET ?"}`,
    )
    .all(...filter.params, ...(!useCursor
    ? []
    : [cursorOrder, cursorOrder, cursor.createdAt, cursor.createdAt, cursor.id]), pageSize + 1, ...(useCursor ? [] : [(page - 1) * pageSize]));
  const hasMore = rows.length > pageSize;
  const pageRows = rows.slice(0, pageSize);
  const lastRow = pageRows[pageRows.length - 1];
  const summaryOnly = ["1", "true", "yes"].includes(
    String(query.summaryOnly ?? "").toLowerCase(),
  );
  const hydratedRows = summaryOnly
    ? pageRows.map((row) => ({ ...row, items: [] }))
    : await hydrateTaskListRows(pageRows);

  const value = {
    total,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && lastRow
      ? serializeTaskCursor(lastRow, Number(lastRow.criterionOrder))
      : null,
    tasks: hydratedRows.map((row) => ({
      id: row.id,
      subjectId: row.projectId || row.subjectId,
      projectId: row.projectId || row.subjectId,
      subjectName: row.subjectName ?? null,
      criterion: row.taskType.split(":")[1] || null,
      status: row.status,
      items: row.items,
    })),
  };
  if (assignedTaskListCache.size >= 256) {
    assignedTaskListCache.delete(assignedTaskListCache.keys().next().value);
  }
  assignedTaskListCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + assignedTaskListCacheTtlMs,
  });
  return value;
}

async function getTaskDetail(taskId, { projectId = null, scorer = null } = {}) {
  const task = await selectTaskByIdStmt.get(taskId);
  if (!task || task.taskVersion !== taskVersion) {
    throw httpError(404, "任务不存在");
  }
  if (projectId && (task.projectId || task.subjectId) !== projectId) {
    throw httpError(404, "任务不存在");
  }
  if (scorer && task.scorer !== scorer) {
    throw httpError(403, "无权查看该任务");
  }
  if (scorer && !["assigned", "completed"].includes(task.status)) {
    throw httpError(403, "当前任务不可查看");
  }
  return (await hydrateTaskRows([task]))[0];
}

const scorerDashboardCache = new Map();
const scorerDashboardCacheTtlMs = 2 * 1000;

async function getScorerDashboard(query = {}) {
  const scorer = parseScorerName(query.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const projectId = query.projectId ? await parseProjectId(query.projectId) : null;
  if (!(await selectScorerByUsernameStmt.get(scorer)))
    throw httpError(404, "打分账号不存在");

  const cacheKey = `${scorer}:${projectId || "all"}`;
  const cached = scorerDashboardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const stats = await selectScorerTaskStatsStmt.get(taskVersion, scorer, projectId, projectId);
  const pendingTasks = Number(stats.pendingTasks || 0);
  const completedTasks = Number(stats.completedTasks || 0);
  const totalTasks = pendingTasks + completedTasks;

  const value = {
    pendingTasks,
    completedTasks,
    totalTasks,
    projectCount: (await selectScorerProjectCountStmt.get(taskVersion, scorer)).total,
    progress: totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0,
  };
  scorerDashboardCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + scorerDashboardCacheTtlMs,
  });
  return value;
}

function parseTaskExcludedImageIds(value, taskImageIds, taskType) {
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) return [];
    throw httpError(400, "Invalid excluded image list");
  }

  const excludedImageIds = value
    .map((imageId) => String(imageId ?? "").trim())
    .filter(Boolean);
  const expectedIds = new Set(taskImageIds);
  const criterion = String(taskType || "").split(":")[1] || "";
  if (excludedImageIds.length && !taskExclusionCriteria.has(criterion)) {
    throw httpError(400, "This criterion does not support image exclusion");
  }
  if (new Set(excludedImageIds).size !== excludedImageIds.length) {
    throw httpError(400, "Excluded image list contains duplicates");
  }
  if (excludedImageIds.some((imageId) => !expectedIds.has(imageId))) {
    throw httpError(
      400,
      "Excluded image list contains an image outside this task",
    );
  }
  return excludedImageIds;
}

function parseTaskCorrectImageIds(
  value,
  taskImageIds,
  taskType,
  excludedImageIds = [],
) {
  const criterion = String(taskType || "").split(":")[1] || "";
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw httpError(400, "确认正确的图片列表格式不正确");
  }

  const correctImageIds = value
    .map((imageId) => String(imageId ?? "").trim())
    .filter(Boolean);
  if (correctImageIds.length && !taskCorrectnessCriteria.has(criterion)) {
    throw httpError(400, "当前评分维度不支持确认正确");
  }
  if (new Set(correctImageIds).size !== correctImageIds.length) {
    throw httpError(400, "确认正确的图片列表包含重复图片");
  }
  const expectedIds = new Set(taskImageIds);
  if (correctImageIds.some((imageId) => !expectedIds.has(imageId))) {
    throw httpError(400, "确认正确的图片列表包含不属于该任务的图片");
  }
  const excluded = new Set(excludedImageIds);
  if (correctImageIds.some((imageId) => excluded.has(imageId))) {
    throw httpError(400, "同一图片不能同时确认正确和无需评价");
  }
  return correctImageIds;
}

function parseTaskRanking(
  value,
  taskImageIds,
  excludedImageIds = [],
  taskType = "",
) {
  if (!Array.isArray(value)) throw httpError(400, "请完成图片排序");
  const ranking = value
    .map((imageId) => String(imageId ?? "").trim())
    .filter(Boolean);
  const excluded = new Set(excludedImageIds);
  const expectedIds = new Set(
    taskImageIds.filter((imageId) => !excluded.has(imageId)),
  );
  if (
    ranking.length !== expectedIds.size ||
    new Set(ranking).size !== ranking.length
  )
    throw httpError(400, "排序结果不完整，请按任务图片完成排序");
  if (ranking.some((imageId) => !expectedIds.has(imageId)))
    throw httpError(400, "排序结果包含不属于该任务的图片");
  return ranking;
}

function parseTaskRankingRelations(value, ranking) {
  const expectedLength = Math.max(ranking.length - 1, 0);
  if (value === undefined || value === null) {
    return Array.from({ length: expectedLength }, () => ">");
  }
  if (
    !Array.isArray(value) ||
    value.length !== expectedLength ||
    value.some((relation) => relation !== ">" && relation !== "=")
  ) {
    throw httpError(400, "排序关系不完整，只支持 > 或 =");
  }
  return value;
}

function parseTaskDuration(value) {
  const durationMs = Math.round(Number(value));
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw httpError(400, "打分时长不正确");
  return Math.min(durationMs, 24 * 60 * 60 * 1000);
}

function parseRankingActionCount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count < 0)
    throw httpError(400, "排序操作次数不正确");
  return Math.min(count, 100000);
}

function parseTaskSubmissionMode(value, rankingActionCount, trackingProvided = false) {
  const requested = String(value || "").trim();
  if (requested && !["direct", "ranked"].includes(requested)) {
    throw httpError(400, "提交方式不正确");
  }
  if (rankingActionCount > 0) return "ranked";
  if (requested) return requested;
  return trackingProvided ? "direct" : null;
}

async function completeAssignedTask(taskId, body = {}) {
  const scorer = parseScorerName(body.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const task = await selectTaskByIdStmt.get(taskId);
  if (!task) throw httpError(404, "任务不存在");
  if (task.status === "completed") {
    if (task.scorer === scorer) return (await hydrateTaskRows([task]))[0];
    throw httpError(409, "该任务已完成");
  }
  if (task.status !== "assigned" || task.scorer !== scorer)
    throw httpError(403, "该任务未分配给当前打分人");
  if (body.projectId && String(body.projectId) !== (task.projectId || task.subjectId))
    throw httpError(400, "任务项目不匹配");

  const taskImageIds = (await selectTaskImageIdsStmt
    .all(task.id))
    .map((item) => item.imageId);
  const excludedImageIds = parseTaskExcludedImageIds(
    body.excludedImageIds,
    taskImageIds,
    task.taskType,
  );
  const correctImageIds = parseTaskCorrectImageIds(
    body.correctImageIds,
    taskImageIds,
    task.taskType,
    excludedImageIds,
  );
  const ranking = parseTaskRanking(
    body.ranking,
    taskImageIds,
    excludedImageIds,
    task.taskType,
  );
  const rankingRelations = parseTaskRankingRelations(
    body.rankingRelations,
    ranking,
  );
  const durationMs = parseTaskDuration(body.durationMs);
  const rankingActionCount = parseRankingActionCount(body.rankingActionCount);
  const submissionMode = parseTaskSubmissionMode(
    body.submissionMode,
    rankingActionCount,
    Object.hasOwn(body, "submissionMode") ||
      Object.hasOwn(body, "rankingActionCount"),
  );
  const completedAt = nowIso();
  const startedAt = new Date(Date.now() - durationMs).toISOString();
  const projectId = task.projectId || task.subjectId;

  await db.exec("BEGIN");
  try {
    const result = await completeAssignedTaskStmt.run({
      id: task.id,
      scorer,
      ranking: JSON.stringify(ranking),
      excludedImageIds: JSON.stringify(excludedImageIds),
      correctImageIds: JSON.stringify(correctImageIds),
      rankingRelations: JSON.stringify(rankingRelations),
      submissionMode,
      rankingActionCount,
      startedAt,
      completedAt,
      durationMs,
      updatedAt: completedAt,
    });
    if (result.changes === 0)
      throw httpError(409, "任务状态已变更，请刷新后重试");
    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTaskSummaryCaches(projectId);
  invalidateScorerQueryCaches();
  queueProjectTaskSummary(projectId);
  const updated = await selectTaskByIdStmt.get(task.id);
  return (await hydrateTaskRows([updated]))[0];
}

async function updateCompletedTask(taskId, body = {}) {
  const scorer = parseScorerName(body.scorer);
  if (!scorer) throw httpError(400, "缺少打分人");
  const task = await selectTaskByIdStmt.get(taskId);
  if (!task) throw httpError(404, "任务不存在");
  if (task.status !== "completed" || task.scorer !== scorer)
    throw httpError(403, "只能修改已分配给当前打分人的已完成任务");
  if (body.projectId && String(body.projectId) !== (task.projectId || task.subjectId))
    throw httpError(400, "任务项目不匹配");

  const taskImageIds = (await selectTaskImageIdsStmt
    .all(task.id))
    .map((item) => item.imageId);
  const excludedImageIds = parseTaskExcludedImageIds(
    body.excludedImageIds,
    taskImageIds,
    task.taskType,
  );
  const correctImageIds = parseTaskCorrectImageIds(
    body.correctImageIds,
    taskImageIds,
    task.taskType,
    excludedImageIds,
  );
  const ranking = parseTaskRanking(
    body.ranking,
    taskImageIds,
    excludedImageIds,
    task.taskType,
  );
  const rankingRelations = parseTaskRankingRelations(
    body.rankingRelations,
    ranking,
  );
  parseTaskDuration(body.durationMs);
  const rankingActionCount = parseRankingActionCount(body.rankingActionCount);
  const submissionMode = parseTaskSubmissionMode(
    body.submissionMode,
    rankingActionCount,
    Object.hasOwn(body, "submissionMode") ||
      Object.hasOwn(body, "rankingActionCount"),
  );
  const editedAt = nowIso();

  await db.exec("BEGIN");
  try {
    const result = await updateCompletedTaskStmt.run({
      id: task.id,
      scorer,
      ranking: JSON.stringify(ranking),
      excludedImageIds: JSON.stringify(excludedImageIds),
      correctImageIds: JSON.stringify(correctImageIds),
      rankingRelations: JSON.stringify(rankingRelations),
      submissionMode,
      rankingActionCount,
      editedAt,
      updatedAt: editedAt,
    });
    if (result.changes === 0)
      throw httpError(409, "任务状态已变更，请刷新后重试");

    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTaskSummaryCaches(task.projectId || task.subjectId);
  invalidateScorerQueryCaches();
  const updated = await selectTaskByIdStmt.get(task.id);
  return (await hydrateTaskRows([updated]))[0];
}

function normalizeTaskAssigneeNames(value) {
  const rawNames = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  return [
    ...new Set(
      rawNames
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .map(normalizeUsername),
    ),
  ];
}

async function parseTaskAssignees(value) {
  const names = normalizeTaskAssigneeNames(value);
  if (!names.length) throw httpError(400, "请选择打分人");

  const users = await Promise.all(names.map(async name => await selectScorerByUsernameStmt.get(name)));
  const missing = names.filter((_, index) => !users[index]);
  if (missing.length)
    throw httpError(400, `打分人不存在：${missing.join("、")}`);
  await Promise.all(users.map(async (user, index) => {
    await assertScorerAssignable(user, names[index]);
  }));
  return { names };
}

async function parseTaskGenerationAssignees(body = {}) {
  const teamIds = await normalizeTeamIds(body.teamIds, {
    required: true,
    enabledOnly: true,
  });
  const teamMatchMode = normalizeTeamMatchMode(body.teamMatchMode);
  const availableUsers = await listScorersByTeamIds(teamIds, teamMatchMode);
  if (!availableUsers.length) throw httpError(400, "所选团队没有可用的打分账号");

  if (!Array.isArray(body.allocations)) {
    throw httpError(400, "请设置打分人任务数量");
  }

  const availableNames = new Set(availableUsers.map((user) => user.username));
  const allocations = [];
  const seen = new Set();
  for (const item of body.allocations) {
    const scorer = normalizeUsername(item?.scorer);
    const taskCount = Number(item?.taskCount);
    if (seen.has(scorer)) throw httpError(400, `打分人 ${scorer} 重复设置`);
    seen.add(scorer);
    if (!availableNames.has(scorer)) {
      throw httpError(400, `打分人 ${scorer} 不属于所选团队`);
    }
    if (!Number.isInteger(taskCount) || taskCount < 0) {
      throw httpError(400, `打分人 ${scorer} 的任务数量必须是非负整数`);
    }
    if (taskCount > 0) allocations.push({ scorer, taskCount });
  }

  return { teamIds, teamMatchMode, allocations };
}

function normalizedAllocationHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-:：]/g, "");
}

function taskAllocationCellText(cell) {
  if (!cell) return "";
  const text = String(cell.text ?? "").trim();
  if (text) return text;
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if ("result" in value) return String(value.result ?? "").trim();
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text || "").join("").trim();
    }
  }
  return String(value).trim();
}

function parseAllocationTaskCount(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) return null;
  const count = Number(text);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    return null;
  }
  return count;
}

async function parseTaskAllocationWorkbook(file) {
  if (!file) throw httpError(400, "请选择分配表");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer);
  } catch (error) {
    throw httpError(422, "分配表无法读取，请确认文件为 XLSX 格式", error);
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw httpError(422, "分配表没有可读取的工作表");

  const scorerHeaders = new Set([
    "打分人",
    "打分人名字",
    "打分账号",
    "账号",
    "用户名",
    "姓名",
    "名字",
    "name",
    "username",
    "user",
    "scorer",
  ].map(normalizedAllocationHeader));
  const countHeaders = new Set([
    "数量",
    "任务数量",
    "任务数",
    "分配数量",
    "分配任务数",
    "count",
    "taskcount",
    "tasks",
    "number",
  ].map(normalizedAllocationHeader));

  let scorerColumn = 1;
  let countColumn = 2;
  let firstDataRow = 1;
  let hasHeader = false;

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    rows.push({ row, rowNumber });
  });

  for (const { row, rowNumber } of rows.slice(0, 10)) {
    const cells = [];
    for (let index = 1; index <= Math.max(row.cellCount, 8); index += 1) {
      cells.push({
        index,
        header: normalizedAllocationHeader(taskAllocationCellText(row.getCell(index))),
      });
    }
    const scorer = cells.find((cell) => scorerHeaders.has(cell.header));
    const count = cells.find((cell) => countHeaders.has(cell.header));
    if (scorer && count && scorer.index !== count.index) {
      scorerColumn = scorer.index;
      countColumn = count.index;
      firstDataRow = rowNumber + 1;
      hasHeader = true;
      break;
    }
  }

  const parsedRows = [];
  const errors = [];
  for (const { row, rowNumber } of rows) {
    if (rowNumber < firstDataRow) continue;
    const scorer = taskAllocationCellText(row.getCell(scorerColumn));
    const rawCount = taskAllocationCellText(row.getCell(countColumn));
    if (!scorer && !rawCount) continue;
    if (!scorer) {
      errors.push(`第 ${rowNumber} 行缺少打分人`);
      continue;
    }
    const taskCount = parseAllocationTaskCount(rawCount);
    if (taskCount == null) {
      errors.push(`第 ${rowNumber} 行任务数量无效`);
      continue;
    }
    parsedRows.push({ rowNumber, scorer, taskCount });
    if (parsedRows.length > 1000) {
      throw httpError(413, "分配表最多读取 1000 行");
    }
  }

  return {
    filename: file.originalname,
    hasHeader,
    scorerColumn,
    countColumn,
    rows: parsedRows,
    errors,
  };
}

async function getTaskReassignmentOptions(subjectId) {
  await getProjectOrThrow(subjectId);
  const stats = await getProjectTaskStats(subjectId);

  return {
    users: await Promise.all(
      (await selectAvailableSubjectScorersStmt.all(subjectId)).map(userDto),
    ),
    availableTaskCount: stats.pending,
    sourceScorers: (await selectSubjectAssignedScorerCountsStmt
      .all(subjectId, taskVersion))
      .map((row) => ({ username: row.scorer, taskCount: row.taskCount })),
  };
}

async function reassignSubjectTasks(subjectId, body = {}) {
  await getProjectOrThrow(subjectId);

  const source = String(body.source || "");
  if (source !== "assigned_uncompleted" && source !== "selected_scorers") {
    throw httpError(400, "任务来源不正确");
  }

  const assignees = await parseTaskAssignees(body.scorers);
  const existingScorers = new Set(
    (await selectSubjectScorerNamesStmt.all(subjectId)).map((row) => row.scorer),
  );
  const existingAssignees = assignees.names.filter((name) =>
    existingScorers.has(name),
  );
  if (existingAssignees.length) {
    throw httpError(
      400,
      `以下账号已属于当前项目：${existingAssignees.join("、")}`,
    );
  }

  let taskCount = Number(body.taskCount);
  if (!Number.isInteger(taskCount) || taskCount < 1) {
    throw httpError(400, "任务数量必须为正整数");
  }
  if (source === "assigned_uncompleted" && taskCount < assignees.names.length) {
    throw httpError(400, "任务数量不能少于所选打分人数");
  }

  const availableTaskCount = source === "assigned_uncompleted"
    ? (await getProjectTaskStats(subjectId)).pending
    : (await getProjectTaskStats(subjectId)).assigned;
  let assignmentPlan = null;
  if (source === "assigned_uncompleted") {
    if (!Array.isArray(body.allocations)) {
      throw httpError(400, "请按打分人分别设置任务数量");
    }
    const allocationMap = new Map();
    body.allocations.forEach((item) => {
      const scorer = normalizeUsername(item?.scorer);
      const count = Number(item?.taskCount);
      if (!assignees.names.includes(scorer)) {
        throw httpError(400, `打分人 ${scorer} 不在本次新增账号列表中`);
      }
      if (allocationMap.has(scorer)) {
        throw httpError(400, `打分人 ${scorer} 重复设置`);
      }
      if (!Number.isInteger(count) || count < 0) {
        throw httpError(400, `打分人 ${scorer} 的任务数量必须是非负整数`);
      }
      allocationMap.set(scorer, count);
    });
    const allocations = assignees.names.map((scorer) => ({
      scorer,
      taskCount: allocationMap.get(scorer) ?? 0,
    }));
    taskCount = allocations.reduce(
      (total, allocation) => total + allocation.taskCount,
      0,
    );
    if (!taskCount) {
      throw httpError(400, "请至少为一名打分人设置任务数量");
    }
    assignmentPlan = allocations.flatMap(({ scorer, taskCount: count }) =>
      Array.from({ length: count }, () => scorer),
    );
  }
  let selectedTasks;
  if (source === "assigned_uncompleted") {
    const candidates = await selectReassignableTaskIdsStmt.all(subjectId, taskVersion, taskCount);
    if (taskCount > candidates.length) {
      throw httpError(400, `任务数量不能超过 ${candidates.length}`);
    }

    selectedTasks = candidates;
  } else {
    const sourceScorers = [
      ...new Set(
        (Array.isArray(body.sourceScorers)
          ? body.sourceScorers
          : String(body.sourceScorers || "").split(",")
        )
          .filter(Boolean)
          .map(normalizeUsername),
      ),
    ];
    if (!sourceScorers.length) {
      throw httpError(400, "请选择已分配打分人");
    }

    const sourceCounts = new Map(
      (await selectSubjectAssignedScorerCountsStmt
        .all(subjectId, taskVersion))
        .map((row) => [row.scorer, row.taskCount]),
    );
    const invalidScorers = sourceScorers.filter(
      (scorer) => !sourceCounts.has(scorer),
    );
    if (invalidScorers.length) {
      throw httpError(
        400,
        `以下打分人没有可领取的未完成任务：${invalidScorers.join("、")}`,
      );
    }

    selectedTasks = (await Promise.all(sourceScorers.map(async scorer => {
      const candidates = await selectReassignableTaskIdsByScorerStmt.all(subjectId, taskVersion, scorer, taskCount);
      if (taskCount > candidates.length) {
        throw httpError(
          400,
          `打分人 ${scorer} 的未完成任务不足 ${taskCount} 个`,
        );
      }
      return candidates;
    }))).flat();
  }

  if (selectedTasks.length < assignees.names.length) {
    throw httpError(400, "任务数量不能少于所选打分人数");
  }
  const updatedAt = nowIso();
  const distribution = Object.fromEntries(
    assignees.names.map((name) => [name, 0]),
  );

  await db.exec("BEGIN");
  try {
    await Promise.all(selectedTasks.map(async (task, index) => {
      const scorer = assignmentPlan?.[index]
        || assignees.names[index % assignees.names.length];
      const result = source === "assigned_uncompleted"
        ? await assignUnassignedTaskStmt.run({
          id: task.id,
          projectId: subjectId,
          taskVersion,
          scorer,
          updatedAt,
        })
        : await reassignTaskStmt.run({
          id: task.id,
          projectId: subjectId,
          taskVersion,
          scorer,
          updatedAt,
        });
      if (result.changes !== 1) {
        throw httpError(409, "任务状态已变更，请刷新后重试");
      }
      distribution[scorer]++;
    }));
    await db.exec("COMMIT");
  } catch (error) {
    try {
      await db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  invalidateTaskSummaryCaches(subjectId);
  invalidateScorerQueryCaches();
  return {
    reassignedCount: selectedTasks.length,
    remainingTaskCount: availableTaskCount - selectedTasks.length,
    distribution,
  };
}

async function assignGeneratedTasks(projectId, allocations, onProgress) {
  const requestedTaskCount = allocations.reduce(
    (total, allocation) => total + allocation.taskCount,
    0,
  );
  if (!requestedTaskCount) {
    return {
      assignedCount: 0,
      taskIds: [],
    };
  }

  const pendingTasks = await selectPendingProjectTaskIdsStmt.all(projectId, taskVersion, requestedTaskCount);
  if (requestedTaskCount > pendingTasks.length) {
    throw httpError(400, `分配数量不能超过 ${pendingTasks.length} 个可用任务`);
  }

  const selectedTasks = pendingTasks;
  const assigneePlan = allocations.flatMap(({ scorer, taskCount }) =>
    Array.from({ length: taskCount }, () => scorer),
  );
  const updatedAt = nowIso();
  const assignedTaskIds = [];

  for (let start = 0; start < selectedTasks.length; start += TASK_ASSIGN_BATCH_SIZE) {
    const batch = selectedTasks.slice(start, start + TASK_ASSIGN_BATCH_SIZE);
    await db.exec("BEGIN");
    try {
      const whenClauses = batch.map(() => "WHEN ? THEN ?");
      const taskIds = batch.map((task) => task.id);
      const assignmentParams = [];
      batch.forEach((task, index) => {
        assignmentParams.push(task.id, assigneePlan[start + index]);
      });
      assignmentParams.push(updatedAt, ...taskIds);
      const result = await db
        .prepare(
          `UPDATE rating_tasks
           SET scorer = CASE id ${whenClauses.join(" ")} ELSE scorer END,
               status = 'assigned',
               updatedAt = ?
           WHERE status = 'pending'
             AND id IN (${placeholders(batch.length)})`,
        )
        .run(...assignmentParams);
      if (result.changes !== batch.length) {
        throw httpError(409, "任务状态已变更，请刷新后重试");
      }
      await db.exec("COMMIT");
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    assignedTaskIds.push(...batch.map((task) => task.id));
    const processed = start + batch.length;
    onProgress?.(processed, selectedTasks.length);
    if (processed < selectedTasks.length) await yieldToEventLoop();
  }

  invalidateTaskSummaryCaches(projectId);
  invalidateScorerQueryCaches();
  return {
    assignedCount: selectedTasks.length,
    taskIds: assignedTaskIds,
  };
}

async function rollbackGeneratedTasks(projectId, taskIds, previousTaskStatus, assignedTaskIds = []) {
  try {
    for (let start = 0; start < assignedTaskIds.length; start += TASK_ASSIGN_BATCH_SIZE) {
      const batch = assignedTaskIds.slice(start, start + TASK_ASSIGN_BATCH_SIZE);
      await db.exec("BEGIN");
      try {
        await db.prepare(
          `UPDATE rating_tasks
           SET status = 'pending',
               scorer = NULL,
               updatedAt = ?
           WHERE projectId = ?
             AND id IN (${placeholders(batch.length)})
             AND status = 'assigned'`,
        ).run(nowIso(), projectId, ...batch);
        await db.exec("COMMIT");
      } catch (error) {
        try {
          await db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    }
    for (let start = 0; start < taskIds.length; start += TASK_WRITE_BATCH_SIZE) {
      const batch = taskIds.slice(start, start + TASK_WRITE_BATCH_SIZE);
      await db.exec("BEGIN");
      try {
        await db.prepare(
          `DELETE FROM rating_tasks
           WHERE projectId = ?
             AND id IN (${placeholders(batch.length)})`,
        ).run(projectId, ...batch);
        await db.exec("COMMIT");
      } catch (error) {
        try {
          await db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    }
    await updateProjectTaskStatusStmt.run({
      id: projectId,
      taskStatus: previousTaskStatus,
      updatedAt: nowIso(),
    });
    invalidateTaskSummaryCaches(projectId);
    invalidateScorerQueryCaches();
  } catch (cleanupError) {
    console.error(`Failed to roll back generated tasks for ${projectId}`, cleanupError);
  }
}

async function generateSubjectTasks(projectId, assignment, onProgress) {
  const project = await getProjectOrThrow(projectId);
  const requestedTaskCount = assignment.allocations.reduce(
    (total, allocation) => total + allocation.taskCount,
    0,
  );
  if (!requestedTaskCount) {
    throw httpError(400, "请至少为一名打分人分配任务");
  }
  const previousTaskStatus = project.taskStatus;
  const generatedTaskIds = [];
  const assignedTaskIds = [];

  try {
    let createdCount = 0;
    let assignedCount = 0;
    const pendingBefore = (await getProjectTaskStats(projectId)).pending;
    const templatesNeeded = Math.max(0, requestedTaskCount - pendingBefore);
    const templates = templatesNeeded
      ? await loadUnmaterializedProjectTaskTemplates(projectId, templatesNeeded)
      : [];

    if (templates.length < templatesNeeded) {
      const availableTaskCount = pendingBefore + templates.length;
      throw httpError(400, `本次最多还能下发 ${availableTaskCount} 个任务`);
    }

    const assigneePlan = assignment.allocations.flatMap(({ scorer, taskCount }) =>
      Array.from({ length: taskCount }, () => scorer),
    );
    const createdAssigneePlan = assigneePlan.slice(0, templates.length);
    const pendingAssigneePlan = assigneePlan.slice(templates.length);

    onProgress?.({
      stage: templates.length ? "正在生成并分配本次任务" : "正在分配已有任务",
      progress: templates.length ? 5 : 70,
    });

    for (let start = 0; start < templates.length; start += TASK_WRITE_BATCH_SIZE) {
      const batch = templates.slice(start, start + TASK_WRITE_BATCH_SIZE);
      const taskRows = batch.map((template, index) =>
        buildGeneratedTaskRecord(
          projectId,
          template,
          createdAssigneePlan[start + index] || null,
        ),
      );
      const itemRows = taskRows.flatMap((task) => task.items);

      await db.exec("BEGIN");
      try {
        const result = await bulkInsertRatingTasks(taskRows);
        await bulkInsertRatingTaskItems(itemRows);
        await db.exec("COMMIT");
        createdCount += result;
        generatedTaskIds.push(...taskRows.map((task) => task.id));
      } catch (error) {
        try {
          await db.exec("ROLLBACK");
        } catch {}
        throw error;
      }

      onProgress?.({
        stage: "正在生成并分配本次任务",
        progress: 5 + Math.round((Math.min(start + batch.length, templates.length) / templates.length) * 65),
      });
      if (start + batch.length < templates.length) await yieldToEventLoop();
    }

    if (pendingAssigneePlan.length) {
      onProgress?.({ stage: "正在分配已有任务", progress: templates.length ? 75 : 70 });
      const pendingAllocations = compressTaskAllocations(pendingAssigneePlan);
      const assignedResult = await assignGeneratedTasks(
        projectId,
        pendingAllocations,
        (current, total) => onProgress?.({
          stage: "正在分配已有任务",
          progress: (templates.length ? 75 : 70) + (total ? Math.round((current / total) * 20) : 0),
        }),
      );
      assignedCount = createdCount + assignedResult.assignedCount;
      assignedTaskIds.push(...assignedResult.taskIds);
    } else {
      assignedCount = createdCount;
    }

    await syncProjectTeams(projectId, assignment.teamIds, nowIso());
    await updateSubjectTaskStatusStmt.run({
      id: projectId,
      taskStatus: "scoring",
      updatedAt: nowIso(),
    });
    invalidateTaskSummaryCaches(projectId);
    const updatedProject = await selectProjectByIdStmt.get(projectId);
    const taskStats = await getProjectTaskStats(projectId);
    const taskCount = taskStats.total;
    const unassignedCount = taskStats.pending;
    onProgress?.({ stage: "任务生成完成", progress: 100 });

    return {
      project: await projectDto(updatedProject, taskStats),
      taskCount,
      createdCount,
      assignedCount,
      unassignedCount,
      taskVersion,
    };
  } catch (error) {
    await rollbackGeneratedTasks(projectId, generatedTaskIds, previousTaskStatus, assignedTaskIds);
    throw error;
  }
}

async function startSubjectTaskGeneration(subjectId, assigneesInput = {}) {
  const project = await getProjectOrThrow(subjectId);
  if (!["task_pending", "scoring"].includes(project.taskStatus)) {
    throw httpError(409, "当前项目已完成任务，不能继续下发");
  }
  const assignment = await parseTaskGenerationAssignees(assigneesInput);

  const activeJobId = activeTaskGenerationBySubject.get(subjectId);
  if (activeJobId) {
    const activeJob = taskGenerationJobs.get(activeJobId);
    if (activeJob && ["queued", "running"].includes(activeJob.status)) {
      return activeJob;
    }
  }

  const job = {
    jobId: crypto.randomUUID(),
    subjectId,
    status: "queued",
    stage: "等待导入任务模板",
    progress: 0,
    message: null,
    result: null,
  };
  taskGenerationJobs.set(job.jobId, job);
  activeTaskGenerationBySubject.set(subjectId, job.jobId);

  const worker = fork(
    fileURLToPath(new URL("./task-generation-worker.js", import.meta.url)),
    [],
    {
      env: process.env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  job.worker = worker;
  const invalidateGenerationCaches = () => {
    invalidateTaskSummaryCaches(subjectId);
    invalidateScorerQueryCaches();
  };
  worker.on("message", (message) => {
    if (message?.type === "progress") {
      job.status = "running";
      job.stage = message.stage || job.stage;
      job.progress = Math.max(0, Math.min(100, Number(message.progress) || 0));
      return;
    }
    if (message?.type === "completed") {
      invalidateGenerationCaches();
      job.result = message.result;
      job.status = "completed";
      job.stage = "任务导入完成";
      job.progress = 100;
      worker.disconnect();
      return;
    }
    if (message?.type === "failed") {
      invalidateGenerationCaches();
      job.status = "failed";
      job.stage = "任务导入失败";
      job.message = message.message || "任务导入失败，请重试";
      worker.disconnect();
    }
  });
  worker.on("error", (error) => {
    if (["queued", "running"].includes(job.status)) {
      invalidateGenerationCaches();
      job.status = "failed";
      job.stage = "任务导入失败";
      job.message = error.message || "任务生成进程启动失败";
    }
    console.error(`Task generation worker failed (${job.jobId})`, error);
  });
  worker.on("exit", (code) => {
    if (["queued", "running"].includes(job.status)) {
      invalidateGenerationCaches();
      job.status = "failed";
      job.stage = "任务导入失败";
      job.message = `任务生成进程异常退出（code ${code}）`;
    }
    activeTaskGenerationBySubject.delete(subjectId);
    delete job.worker;
    setTimeout(() => taskGenerationJobs.delete(job.jobId), 24 * 60 * 60 * 1000).unref();
  });
  worker.send({ type: "start", subjectId, assignment });

  return job;
}

function buildImageFilter(query) {
  const clauses = [];
  const params = [];

  if (query.subjectId) {
    clauses.push("subjectId = ?");
    params.push(String(query.subjectId));
  }

  if (query.category) {
    clauses.push("category = ?");
    params.push(String(query.category));
  }

  if (query.filename) {
    clauses.push("filename LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query.filename)}%`);
  }

  if (query.scorer) {
    clauses.push("scorer = ?");
    params.push(String(query.scorer));
  }

  if (query.status === "rated") {
    clauses.push("overall IS NOT NULL");
  } else if (query.status === "unrated") {
    clauses.push("overall IS NULL");
  }

  const keys = String(query.scoreCriteria || "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => scoreFilterKeys.has(key));

  let scoreRanges = {};
  try {
    scoreRanges = JSON.parse(String(query.scoreRanges || "{}"));
  } catch {
    scoreRanges = {};
  }

  for (const key of keys) {
    const [min, max] = parseScoreRange(scoreRanges[key]);
    if (skippableScoreFields.includes(key)) {
      clauses.push(`${scoreStateColumn(key)} = 'rated'`);
    }
    clauses.push(`${key} BETWEEN ? AND ?`);
    params.push(min, max);
  }

  return {
    where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

async function listImages(query) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 20, 1), 100);
  const { where, params } = buildImageFilter(query);
  const includeTotal = ["1", "true", "yes"].includes(
    String(query.includeTotal ?? "").toLowerCase(),
  );
  const includeDetails = ["1", "true", "yes"].includes(
    String(query.includeDetails ?? "").toLowerCase(),
  );
  const total = includeTotal
    ? (await db.prepare(`SELECT COUNT(*) AS total FROM images${where}`).get(...params)).total
    : null;
  const selectColumns = includeDetails ? imageSelectColumns : imageListSelectColumns;
  const toDto = includeDetails ? imageDto : imageListDto;
  const items = (await db
    .prepare(
      `SELECT ${selectColumns} FROM images${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize))
    .map(toDto);

  return { total, page, pageSize, items };
}

async function getCategories(subjectId) {
  const rows = subjectId
    ? await db
        .prepare(
          "SELECT category FROM images WHERE subjectId = ? GROUP BY category ORDER BY LOWER(category) ASC, category ASC",
        )
        .all(String(subjectId))
    : await db
        .prepare(
          "SELECT category FROM images GROUP BY category ORDER BY LOWER(category) ASC, category ASC",
        )
        .all();
  return rows.map((row) => row.category);
}

async function getScorers(subjectId) {
  const where = subjectId
    ? "subjectId = ? AND scorer IS NOT NULL AND scorer <> '' AND overall IS NOT NULL"
    : "scorer IS NOT NULL AND scorer <> '' AND overall IS NOT NULL";
  const rows = subjectId
    ? await db
        .prepare(
          `SELECT scorer FROM images WHERE ${where} GROUP BY scorer ORDER BY LOWER(scorer) ASC, scorer ASC`,
        )
        .all(String(subjectId))
    : await db
        .prepare(
          `SELECT scorer FROM images WHERE ${where} GROUP BY scorer ORDER BY LOWER(scorer) ASC, scorer ASC`,
        )
        .all();
  return rows.map((row) => row.scorer);
}

app.use(
  "/files",
  ensureFileAccess,
  express.static(uploadDir, {
    maxAge: "7d",
    immutable: true,
    index: false,
  }),
);

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const user = await loginUser(req.body);
    const session = await createSession(user);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.use("/api", requireAuth);

app.get("/api/auth/session", (req, res) => {
  res.json({ user: req.auth });
});

app.post("/api/auth/logout", async (req, res) => {
  const token = cookieValue(req.headers.cookie, "image_rating_session");
  if (token) {
    const tokenHash = sessionTokenHash(token);
    await deleteSessionStmt.run(tokenHash);
    sessionSeenWriteAt.delete(tokenHash);
  }
  clearSessionCookie(res);
  res.status(204).end();
});

app.use("/api/admin", requireAdmin);
app.use("/api/users", requireAdmin);
app.use("/api/import", requireAdmin);
app.use("/api/scorer", requireScorer);
app.use("/api/tasks/assigned", requireScorer);

app.get("/api/admin/dashboard", async (req, res, next) => {
  try {
    res.json(await listAdminDashboard(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/stats", async (req, res, next) => {
  try {
    res.json(await getDashboardStats());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/project-summary", async (req, res, next) => {
  try {
    res.json(await getDashboardProjectSection(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/charts", async (req, res, next) => {
  try {
    res.json(await getDashboardCharts());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/average-duration", async (req, res, next) => {
  try {
    res.json(await getDashboardAverageDuration());
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/dashboard/workload", async (req, res, next) => {
  try {
    res.json(await getDashboardWorkloadSection(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/tasks/completed/export", async (req, res, next) => {
  try {
    await exportCompletedTasks(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scorers/task-summary/export", async (req, res, next) => {
  try {
    await exportScorerTaskSummary(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scorers/completed/export", async (req, res, next) => {
  try {
    await exportScorerTaskSummary(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/teams/task-summary/export", async (req, res, next) => {
  try {
    await exportTeamTaskSummary(req, res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scoring/summary", async (req, res, next) => {
  try {
    res.json(await listScoringSummary(req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scoring/tasks", async (req, res, next) => {
  try {
    res.json(await listScoringTaskRecords(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/scoring/rollback/preview", async (req, res, next) => {
  try {
    res.json(await previewRollback(req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/scoring/rollback", async (req, res, next) => {
  try {
    res.status(202).json(rollbackJobDto(startRollbackJob(req.body, req.auth)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/scoring/rollback/:jobId", async (req, res, next) => {
  try {
    const job = getRollbackJob(req.params.jobId);
    if (!job) throw httpError(404, "任务回退作业不存在或已过期");
    res.json(rollbackJobDto(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/users/scorers", async (req, res, next) => {
  try {
    res.json(await listScorerUsers(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/users/scorers", async (req, res, next) => {
  try {
    res.status(201).json({ user: await createScorerUser(req.body) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/users/scorers/batch", async (req, res, next) => {
  try {
    res.status(201).json(await createScorerUsers(req.body));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/users/scorers/:id", async (req, res, next) => {
  try {
    res.json({ user: await updateScorerUser(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/teams", requireAdmin, async (req, res, next) => {
  try {
    res.json(await listTeams(req.query));
  } catch (error) {
    next(error);
  }
});

app.post("/api/teams", requireAdmin, async (req, res, next) => {
  try {
    res.status(201).json({ team: await createTeam(req.body) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/teams/scorers", requireAdmin, async (req, res, next) => {
  try {
    const rawTeamIds = String(req.query.teamIds || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const teamIds = await normalizeTeamIds(rawTeamIds, {
      required: true,
      enabledOnly: true,
    });
    const teamMatchMode = normalizeTeamMatchMode(req.query.teamMatchMode);
    res.json({ users: await listScorersByTeamIds(teamIds, teamMatchMode) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/teams/:id", requireAdmin, async (req, res, next) => {
  try {
    res.json({ team: await updateTeam(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/teams/:id", requireAdmin, async (req, res, next) => {
  try {
    res.json(await deleteTeam(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/users/scorers/:id", async (req, res, next) => {
  try {
    res.json(await deleteScorerUser(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/assigned/options", async (req, res, next) => {
  try {
    setShortApiCache(res);
    res.json(await assignedTaskOptions({
      scorer: req.auth.username,
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks/assigned", async (req, res, next) => {
  try {
    setShortApiCache(res);
    res.json(await listAssignedTasks({
      ...req.query,
      scorer: req.auth.username,
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scorer/dashboard", async (req, res, next) => {
  try {
    setShortApiCache(res);
    res.json(await getScorerDashboard({
      ...req.query,
      scorer: req.auth.username,
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/feedbacks", async (req, res, next) => {
  try {
    setShortApiCache(res);
    res.json(await listFeedbacks(req.query));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/feedbacks",
  requireScorer,
  feedbackUpload.array("images", 5),
  async (req, res, next) => {
    try {
      res.status(201).json({
        feedback: await createFeedback(req.auth, req.body, req.files || []),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.put("/api/feedbacks/:id/reply", requireAdmin, async (req, res, next) => {
  try {
    res.json({
      feedback: await addFeedbackMessage(req.params.id, req.body, req.auth),
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/feedbacks/:id/messages",
  requireScorer,
  async (req, res, next) => {
    try {
      res.json({
        feedback: await addFeedbackMessage(req.params.id, req.body, req.auth),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.put("/api/feedbacks/:id/status", async (req, res, next) => {
  try {
    res.json({
      feedback: await updateFeedbackStatus(req.params.id, req.body?.status, req.auth),
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/tasks/:id/complete",
  requireScorer,
  async (req, res, next) => {
    try {
      res.json({
        task: await completeAssignedTask(req.params.id, {
          ...req.body,
          scorer: req.auth.username,
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.put(
  "/api/tasks/:id/complete",
  requireScorer,
  async (req, res, next) => {
    try {
      res.json({
        task: await updateCompletedTask(req.params.id, {
          ...req.body,
          scorer: req.auth.username,
        }),
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/tasks/:id", requireScorer, async (req, res, next) => {
  try {
    res.json({
      task: await getTaskDetail(req.params.id, { scorer: req.auth.username }),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/subjects", async (req, res, next) => {
  try {
    res.json((await listVisibleSubjects(req.auth)).map(subjectDto));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects", async (req, res, next) => {
  try {
    res.json(await listVisibleProjects(req.auth, req.query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id", async (req, res, next) => {
  try {
    const project = await getProjectOrThrow(req.params.id);
    if (req.auth.role !== "admin") {
      const allowed = await db.prepare(
        `SELECT 1 FROM rating_tasks
         WHERE projectId = ? AND scorer = ?
           AND status IN ('assigned', 'completed')
         LIMIT 1`,
      ).get(project._id, req.auth.username);
      if (!allowed) throw httpError(403, "无权访问该项目");
    }
    res.json({ project: await projectDto(project) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", requireAdmin, async (req, res, next) => {
  try {
    res.status(201).json({ project: await createProject(req.body) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id", requireAdmin, async (req, res, next) => {
  try {
    res.json({ project: await updateProject(req.params.id, req.body) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id", requireAdmin, async (req, res, next) => {
  try {
    res.json(await deleteProject(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/categories", async (req, res, next) => {
  try {
    if (req.auth.role !== "admin" && !req.query.subjectId)
      throw httpError(400, "请选择项目");
    if (req.query.subjectId)
      await assertSubjectAccess(String(req.query.subjectId), req.auth);
    res.json(await getCategories(req.query.subjectId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/scorers", async (req, res, next) => {
  try {
    if (req.auth.role !== "admin" && !req.query.subjectId)
      throw httpError(400, "请选择项目");
    if (req.query.subjectId)
      await assertSubjectAccess(String(req.query.subjectId), req.auth);
    res.json(await getScorers(req.query.subjectId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/images", async (req, res, next) => {
  try {
    if (req.auth.role !== "admin" && !req.query.subjectId)
      throw httpError(400, "请选择项目");
    if (req.query.subjectId)
      await assertSubjectAccess(String(req.query.subjectId), req.auth);
    setShortApiCache(res);
    res.json(await listImages(req.query));
  } catch (error) {
    next(error);
  }
});

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

app.post("/api/projects/:id/tasks/generate", requireAdmin, async (req, res, next) => {
  try {
    res.status(202).json(taskGenerationJobDto(
      await startSubjectTaskGeneration(req.params.id, req.body),
    ));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/generate/:jobId", requireAdmin, async (req, res, next) => {
  try {
    const job = taskGenerationJobs.get(req.params.jobId);
    if (!job || job.subjectId !== req.params.id) throw httpError(404, "任务生成作业不存在或已过期");
    res.json(taskGenerationJobDto(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/tasks/:taskId", requireAdmin, async (req, res, next) => {
  try {
    res.json({ task: await getTaskDetail(req.params.taskId, { projectId: req.params.id }) });
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
        task: await getTaskDetail(req.params.taskId, { projectId: req.params.id }),
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

app.post("/api/import", upload.single("file"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ message: "请选择 ZIP 文件" });
  if (path.extname(req.file.originalname).toLowerCase() !== ".zip") {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ message: "仅支持 ZIP 文件" });
  }

  try {
    res
      .status(201)
      .json(await importZipArchive(req.file.path, req.file.originalname));
  } catch (error) {
    next(error);
  }
});

app.options("/api/import/uploads", (_req, res) => {
  res
    .set({
      "Tus-Resumable": tusVersion,
      "Tus-Version": tusVersion,
      "Tus-Extension": "creation,termination",
      "Tus-Max-Size": String(maxZipBytes),
    })
    .status(204)
    .end();
});

app.options("/api/import/uploads/:uploadId", (_req, res) => {
  res
    .set({
      "Tus-Resumable": tusVersion,
      "Tus-Version": tusVersion,
      "Tus-Extension": "creation,termination",
      "Tus-Max-Size": String(maxZipBytes),
    })
    .status(204)
    .end();
});

app.post("/api/import/uploads", async (req, res, next) => {
  try {
    requireTusResumableHeader(req);
    const uploadLength = Number(req.headers["upload-length"]);
    if (!Number.isInteger(uploadLength) || uploadLength <= 0) {
      throw httpError(400, "上传文件大小不正确");
    }
    if (uploadLength > maxZipBytes) {
      throw httpError(413, "ZIP 文件超过服务器允许的大小限制");
    }

    const metadata = parseTusMetadataHeader(req.headers["upload-metadata"]);
    const originalFilename = normalizeTusFilename(metadata.filename);
    if (
      !originalFilename ||
      path.extname(originalFilename).toLowerCase() !== ".zip"
    ) {
      throw httpError(400, "仅支持 ZIP 文件");
    }

    const session = await createResumableUploadSession(
      originalFilename,
      uploadLength,
    );
    res
      .set(resumableUploadResponseHeaders(session, 0))
      .status(201)
      .json(resumableUploadDto(session, 0));
  } catch (error) {
    next(error);
  }
});

app.head("/api/import/uploads/:uploadId", async (req, res, next) => {
  try {
    requireTusResumableHeader(req);
    const uploadId = req.params.uploadId;
    const session = await loadResumableUploadSession(uploadId);
    if (!session) throw httpError(404, "上传任务不存在或已过期");
    if (session.status !== "uploading") {
      throw httpError(409, "上传任务已开始处理");
    }
    res
      .set(resumableUploadResponseHeaders(session, session.offset))
      .status(204)
      .end();
  } catch (error) {
    next(error);
  }
});

app.patch(
  "/api/import/uploads/:uploadId",
  express.raw({
    type: "application/offset+octet-stream",
    limit: resumableUploadMaxChunkBytes,
  }),
  async (req, res, next) => {
    const uploadId = req.params.uploadId;
    try {
      await withResumableUploadLock(uploadId, async () => {
        requireTusResumableHeader(req);

        const session = await loadResumableUploadSession(uploadId);
        if (!session) throw httpError(404, "上传任务不存在或已过期");
        if (session.status !== "uploading") {
          throw httpError(409, "上传任务状态不允许继续写入");
        }

        const requestedOffset = Number(req.headers["upload-offset"]);
        if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
          throw httpError(400, "上传偏移量不正确");
        }
        if (requestedOffset !== session.offset) {
          return res
            .set(resumableUploadResponseHeaders(session, session.offset))
            .status(409)
            .json({ message: "上传偏移量不匹配，请按服务器返回位置续传" });
        }

        const chunkBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!chunkBuffer.length) throw httpError(400, "上传数据为空");
        const nextOffset = session.offset + chunkBuffer.length;
        if (nextOffset > session.uploadLength) {
          throw httpError(413, "上传数据超过声明的文件大小");
        }

        await fs.appendFile(session.filePath, chunkBuffer);

        const updatedSession = {
          ...session,
          offset: nextOffset,
          updatedAt: nowIso(),
          expiresAt: resumableUploadExpiresAt(),
        };

        if (nextOffset === session.uploadLength) {
          updatedSession.status = "queued";
          await saveResumableUploadSession(updatedSession);
          const job = {
            uploadId,
            dir: session.dir,
            zipPath: session.filePath,
            originalFilename: session.originalFilename,
            totalChunks: 1,
            protocol: "tus",
            uploadLength: session.uploadLength,
            uploadOffset: nextOffset,
            status: "queued",
            stage: "等待处理",
            progress: 0,
            message: null,
            result: null,
            createdAt: nowIso(),
            expiresAt: importJobExpiry(),
          };
          await insertImportJobStmt.run({
            uploadId: job.uploadId,
            originalFilename: job.originalFilename,
            totalChunks: job.totalChunks,
            protocol: job.protocol,
            uploadLength: job.uploadLength,
            uploadOffset: job.uploadOffset,
            metadata: JSON.stringify({
              filename: job.originalFilename,
              uploadLength: job.uploadLength,
            }),
            status: job.status,
            stage: job.stage,
            progress: job.progress,
            message: null,
            resultJson: null,
            createdAt: job.createdAt,
            updatedAt: job.createdAt,
            expiresAt: job.expiresAt,
          });
          importJobs.set(uploadId, job);
          setImmediate(async () => void (await runResumableImportJob(job)));
        } else {
          await saveResumableUploadSession(updatedSession);
        }

        res
          .set(resumableUploadResponseHeaders(updatedSession, nextOffset))
          .status(204)
          .end();
      });
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/import/uploads/:uploadId/status", async (req, res, next) => {
  try {
    const uploadId = req.params.uploadId;
    validateUploadId(uploadId);
    const job =
      importJobs.get(uploadId) || importJobFromRow(await selectImportJobStmt.get(uploadId));
    if (job) return res.json(importJobDto(job));

    const session = await loadResumableUploadSession(uploadId);
    if (!session) throw httpError(404, "上传任务不存在或已过期");
    res.json({
      uploadId,
      status: "uploading",
      stage: "上传中",
      progress: Math.min(
        99,
        Math.round((session.offset / session.uploadLength) * 100),
      ),
      message: null,
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/import/uploads/:uploadId", async (req, res, next) => {
  try {
    requireTusResumableHeader(req);
    const uploadId = req.params.uploadId;
    const job =
      importJobs.get(uploadId) || importJobFromRow(await selectImportJobStmt.get(uploadId));
    if (job && !["failed", "completed"].includes(job.status)) {
      throw httpError(409, "导入任务已开始，无法取消");
    }

    await cleanupResumableUploadSession(uploadId);
    await deleteImportJobStmt.run(uploadId);
    importJobs.delete(uploadId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/import/chunks/:uploadId/parts/:index",
  chunkUpload.single("chunk"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ message: "缺少上传分片" });
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0 || index >= maxChunkCount)
        throw httpError(400, "分片序号不正确");
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/import/chunks/:uploadId/complete", async (req, res, next) => {
  try {
    const uploadId = req.params.uploadId;
    const dir = chunkDir(uploadId);
    const existingJob = importJobs.get(uploadId);
    if (existingJob) {
      return res.status(202).json(importJobDto(existingJob));
    }
    const persistedJob = importJobFromRow(await selectImportJobStmt.get(uploadId));
    if (persistedJob) {
      return res.status(202).json(importJobDto(persistedJob));
    }

    const originalFilename = String(req.body?.filename || "").trim();
    const totalChunks = Number(req.body?.totalChunks);
    if (
      !originalFilename ||
      path.extname(originalFilename).toLowerCase() !== ".zip"
    ) {
      throw httpError(400, "仅支持 ZIP 文件");
    }
    if (
      !Number.isInteger(totalChunks) ||
      totalChunks <= 0 ||
      totalChunks > maxChunkCount
    ) {
      throw httpError(400, "分片总数不正确");
    }

    const job = {
      uploadId,
      dir,
      zipPath: path.join(zipUploadDir, `${uploadId}.zip`),
      originalFilename,
      totalChunks,
      status: "queued",
      stage: "等待处理",
      progress: 0,
      message: null,
      result: null,
      createdAt: nowIso(),
      expiresAt: importJobExpiry(),
    };
    await insertImportJobStmt.run({
      uploadId: job.uploadId,
      originalFilename: job.originalFilename,
      totalChunks: job.totalChunks,
      protocol: "chunked",
      uploadLength: null,
      uploadOffset: 0,
      metadata: null,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: null,
      resultJson: null,
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      expiresAt: job.expiresAt,
    });
    importJobs.set(uploadId, job);
    setImmediate(async () => void (await runChunkedImportJob(job)));
    res.status(202).json(importJobDto(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/import/chunks/:uploadId/status", async (req, res, next) => {
  try {
    validateUploadId(req.params.uploadId);
    const job =
      importJobs.get(req.params.uploadId) ||
      importJobFromRow(await selectImportJobStmt.get(req.params.uploadId));
    if (!job) throw httpError(404, "上传任务不存在或已过期");
    res.json(importJobDto(job));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/import/chunks/:uploadId", async (req, res, next) => {
  try {
    await fs.rm(chunkDir(req.params.uploadId), {
      recursive: true,
      force: true,
    });
    await deleteImportJobStmt.run(req.params.uploadId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.delete("/api/subjects/:id", requireAdmin, async (req, res, next) => {
  try {
    const subject = await selectSubjectByIdStmt.get(req.params.id);
    if (!subject) return res.status(404).json({ message: "项目不存在" });
    await assertPackageCanBeDeleted(subject._id);

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
    queueSubjectDeletion(subject._id);
  } catch (error) {
    next(error);
  }
});

app.put("/api/images/:id/score", async (req, res, next) => {
  try {
    const current = await selectImageByIdStmt.get(req.params.id);
    if (!current) return res.status(404).json({ message: "图片不存在" });
    if (
      req.auth.role !== "admin" &&
      !(await selectAssignedTaskForImageStmt.get(req.auth.username, current.storagePath, current.storagePath))
    ) {
      throw httpError(403, "无权为该图片评分");
    }

    const score = normalizeScorePayload({
      ...(req.body || {}),
      scorer: req.auth.role === "scorer" ? req.auth.username : current.scorer,
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

app.use((error, req, res, _next) => {
  const timedOut = error?.code === "57014" || error?.cause?.code === "57014";
  const poolQueueTimedOut = error?.message === "timeout exceeded when trying to connect";
  let status = timedOut || poolQueueTimedOut ? 503 : error.status || 500;
  if (status >= 500) console.error(error);
  let message = timedOut
    ? "查询执行超时，请稍后重试"
    : poolQueueTimedOut
      ? "请求较多，请稍后重试"
      : error.message || "服务异常";
  const code = timedOut
    ? "QUERY_TIMEOUT"
    : poolQueueTimedOut
      ? "QUERY_QUEUE_TIMEOUT"
      : error.code || "REQUEST_FAILED";

  if (error instanceof multer.MulterError) {
    status = 400;
    message =
      error.code === "LIMIT_FILE_SIZE"
        ? req.path.includes("/chunks/")
          ? "上传分片超过大小限制，请重新上传该文件"
          : "ZIP 文件超过服务器允许的大小限制"
        : "上传文件数据不完整，请重新上传";
  }

  if (error.retryAfterSeconds != null) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
  res.status(status).json({ message, code });
});

const queuedSubjects = await db
  .prepare("SELECT id FROM subjects WHERE deletionRequestedAt IS NOT NULL")
  .all();
for (const subject of queuedSubjects) queueSubjectDeletion(subject.id);

const startupNow = nowIso();
await deleteExpiredSessionsStmt.run(startupNow);
await deleteExpiredImportJobsStmt.run(startupNow);
await sweepResumableUploadSessions();
await db.prepare(
  `UPDATE import_jobs
   SET status = 'failed',
       stage = '导入失败',
       message = '服务端在导入过程中重启，请重新上传',
       updatedAt = @updatedAt
   WHERE status IN ('queued', 'merging', 'importing')`,
).run({ updatedAt: startupNow });

export { generateSubjectTasks, importZipArchive };
export default app;
