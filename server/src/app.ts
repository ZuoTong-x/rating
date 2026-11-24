import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { ErrorRequestHandler, Response } from "express";
import cors from "cors";
import multer from "multer";
import ExcelJS from "exceljs";
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
} from "./postgres.ts";
import { createAdminDashboardService } from "./services/admin-dashboard.ts";
import { createProjectService } from "./services/projects.ts";
import { importZipArchive as importArchive } from "./services/import-archive.ts";
import { createTaskGenerationJobService } from "./services/task-generation-job.ts";
import { createTaskGenerationPlanService } from "./services/task-generation-plan.ts";
import { createTaskGenerationExecutionService } from "./services/task-generation-execution.ts";
import { parseTaskGenerationAssignees as parseGenerationAssignees } from "./services/task-generation-assignment.ts";
import { createTaskSubmissionValidation } from "./services/task-submission-validation.ts";
import { createTaskSubmissionService } from "./services/task-submission.ts";
import { createCatalogService } from "./services/catalog.ts";
import { createTaskQueryCore } from "./services/task-query-core.ts";
import { createAdminTaskListService } from "./services/admin-task-list.ts";
import { createTaskReportService } from "./services/task-report.ts";
import { createAdminExportJobService } from "./services/admin-export-job.ts";
import { createScorerTaskFilterService } from "./services/scorer-task-filter.ts";
import { createScorerTaskListService } from "./services/scorer-task-list.ts";
import { createTaskAssignmentInputService } from "./services/task-assignment-input.ts";
import { createTaskReassignmentService } from "./services/task-reassignment.ts";
import { createTaskGenerationOperations } from "./services/task-generation-operations.ts";
import { createTaskGenerationTemplatesService } from "./services/task-generation-templates.ts";
import { createImportManifestService } from "./services/import-manifest.ts";
import { createImportJobsService } from "./services/import-jobs.ts";
import { createImportWritesService } from "./services/import-writes.ts";
import { createAdminExportQueueService } from "./services/admin-export-queue.ts";
import type { AdminExportJob } from "./services/admin-export-types.ts";
import { createScoreService } from "./services/image-score.ts";
import {
  imageAssetUrl, imageListDto, taskImageDto, taskListImageDto,
  subjectDto, teamDto,
} from "./services/dto.ts";
import { createAdminScoringService } from "./services/admin-scoring.ts";
import { createAdminThumbnailService } from "./services/admin-thumbnails.ts";
import { createThumbnailImportScheduler } from "./services/thumbnail-import.ts";
import { createAdminSystemService, createApiActivityTracker } from "./services/admin-system.ts";
import { createAdminLogService } from "./services/admin-logs.ts";
import { createFeedbackService } from "./services/feedback.ts";
import { createTeamService } from "./services/teams.ts";
import { createUserIdentityService } from "./services/user-identity.ts";
import { createAuthSessionService } from "./services/auth-session.ts";
import { createAccessService } from "./services/access.ts";
import { createLoginService } from "./services/login.ts";
import { createScorerAccountService } from "./services/scorer-accounts.ts";
import { createProjectViewService } from "./services/project-view.ts";
import { createTaskStatsWriteService } from "./services/task-stats-write.ts";
import { createTaskStatsWorkerService } from "./services/task-stats-worker.ts";
import { createTaskGenerationJobStore } from "./services/task-generation-job-store.ts";
import { createSubjectDeletionService } from "./services/subject-deletion.ts";
import { createProjectStatements } from "./repositories/project-statements.ts";
import { createTeamStatements } from "./repositories/team-statements.ts";
import { createAccountStatements } from "./repositories/account-statements.ts";
import { createImportStatements } from "./repositories/import-statements.ts";
import { createFeedbackStatements } from "./repositories/feedback-statements.ts";
import { createTaskCoreStatements } from "./repositories/task-core-statements.ts";
import { createTaskTemplateStatements } from "./repositories/task-template-statements.ts";
import { createTaskStatsStatements } from "./repositories/task-stats-statements.ts";
import { createTaskAssignmentStatements } from "./repositories/task-assignment-statements.ts";
import { createAssetStatements } from "./repositories/asset-statements.ts";
import { createTaskGenerationJobStatements } from "./repositories/task-generation-job-statements.ts";
import { createStartupStatements } from "./repositories/startup-statements.ts";
import {
  taskVersion, taskCriteria, taskExclusionCriteria,
  taskCorrectnessCriteria, taskCriterionLabels,
} from "./constants/tasks.ts";
import { createOperationalLogger, requestLogMetadata } from "./operational-logger.ts";
import { retryTaskStatsRefresh } from "./task-stats-retry.ts";
import { registerAdminDashboardRoutes } from "./routes/admin-dashboard.ts";
import { registerAdminThumbnailRoutes } from "./routes/admin-thumbnails.ts";
import { registerAdminSystemRoutes } from "./routes/admin-system.ts";
import { registerAdminScoringRoutes } from "./routes/admin-scoring.ts";
import { registerPublicAuthRoutes, registerSessionAuthRoutes } from "./routes/auth.ts";
import { registerScorerTaskListRoutes, registerScorerTaskDetailRoutes } from "./routes/scorer-tasks.ts";
import { registerFeedbackRoutes } from "./routes/feedback.ts";
import { registerAdminAccountRoutes } from "./routes/admin-accounts.ts";
import { registerAdminExportRoutes } from "./routes/admin-exports.ts";
import { registerProjectRoutes } from "./routes/projects.ts";
import { registerAdminTaskRoutes } from "./routes/admin-tasks.ts";
import { registerDirectImportRoute, registerImportUploadRoutes } from "./routes/imports.ts";
import { registerCatalogRoutes, registerCatalogMutationRoutes } from "./routes/catalog.ts";

type DbRow = Record<string, unknown>;
const taskImageDtoFromDb = (row: DbRow) => taskImageDto(row as Parameters<typeof taskImageDto>[0]);
const taskListImageDtoFromDb = (row: DbRow) => taskListImageDto(row as Parameters<typeof taskListImageDto>[0]);
const imageListDtoFromDb = (row: DbRow) => imageListDto(row as Parameters<typeof imageListDto>[0]);
const subjectDtoFromDb = (row: unknown) => subjectDto(row as Parameters<typeof subjectDto>[0]);
const teamDtoFromDb = (row: unknown) => teamDto(row as Parameters<typeof teamDto>[0]);

const app = express();
type ApiError = Error & {
  status?: number; publicCode?: string; isArchiveImportError?: boolean;
  code?: string; retryAfterSeconds?: number; cause?: unknown;
};
const startupState: {
  status: string; startedAt: string; completedAt: string | null; error: string | null;
} = {
  status: process.env.TASK_GENERATION_WORKER === "1" || process.env.THUMBNAIL_WORKER === "1"
    ? "worker"
    : "starting",
  startedAt: new Date().toISOString(),
  completedAt: null,
  error: null,
};
const apiActivity = createApiActivityTracker();
const logDir = path.resolve(process.env.LOG_DIR || "logs");
const operationalLogger = createOperationalLogger({
  source: process.env.TASK_GENERATION_WORKER === "1" ? "task-generation-worker" : "api",
  logDir,
});
operationalLogger.installConsoleCapture();
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
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
const pendingJsonImportDir = path.join(uploadDir, "_pending-json");
const adminExportDir = path.join(uploadDir, "_exports");
const taskGenerationUploadDir = path.join(uploadDir, "_task-generation");
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
const { parseTaskPagination, hasPaginationQuery, parseTaskCursor,
  serializeTaskCursor, includeTaskTotal, escapeSqlLike, parseOptionalDateFilter,
  parseQueryList, placeholders, completedTaskResultDto, hydrateTaskRows } = createTaskQueryCore({
  httpError, db, taskImageSelectColumns, taskImageDto: taskImageDtoFromDb,
});

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(zipUploadDir, { recursive: true });
await fs.mkdir(chunkUploadDir, { recursive: true });
await fs.mkdir(resumableUploadDir, { recursive: true });
await fs.mkdir(pendingJsonImportDir, { recursive: true });
await fs.mkdir(adminExportDir, { recursive: true });
await fs.mkdir(taskGenerationUploadDir, { recursive: true });
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
app.use((req, res, next) => {
  req.requestId = String(req.headers["x-request-id"] || crypto.randomUUID()).slice(0, 120);
  res.setHeader("X-Request-Id", req.requestId);
  next();
});
app.use((_req, _res, next) => runWithDatabaseContext(() => next()));
app.use(apiActivity.middleware);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "api" });
});

app.get("/readyz", (_req, res) => {
  const ready = startupState.status === "ready" || startupState.status === "worker";
  res.status(ready ? 200 : 503).json({
    status: startupState.status,
    startedAt: startupState.startedAt,
    completedAt: startupState.completedAt,
    error: startupState.error,
  });
});

function positiveLimit(name: string, fallback: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

function setShortApiCache(res: Response) {
  res.setHeader("Cache-Control", "private, max-age=2, stale-while-revalidate=2");
  res.setHeader("Vary", "Cookie");
}

const maxZipBytes = positiveLimit("MAX_ZIP_BYTES", 1024 * 1024 * 1024 * 100)
const maxArchiveEntries = positiveLimit("MAX_ARCHIVE_ENTRIES", 100000);
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
const importDbBatchSize = Math.min(
  4000,
  Math.max(100, Math.floor(positiveLimit("IMPORT_DB_BATCH_SIZE", 1000))),
);
const importDbItemBatchSize = Math.min(
  10000,
  Math.max(500, Math.floor(positiveLimit("IMPORT_DB_ITEM_BATCH_SIZE", 5000))),
);
const taskStatsEventFlushIntervalMs = Math.max(
  500,
  Math.floor(positiveLimit("TASK_STATS_EVENT_FLUSH_INTERVAL_MS", 2 * 1000)),
);
const taskStatsEventScanBatchSize = Math.min(
  50000,
  Math.max(1, Math.floor(positiveLimit("TASK_STATS_EVENT_SCAN_BATCH_SIZE", 20000))),
);
const taskStatsEventInsertBatchSize = Math.min(
  1000,
  Math.max(1, Math.floor(positiveLimit("TASK_STATS_EVENT_INSERT_BATCH_SIZE", 500))),
);
const taskStatsEventRetentionMs = Math.max(
  60 * 60 * 1000,
  Math.floor(positiveLimit("TASK_STATS_EVENT_RETENTION_MS", 48 * 60 * 60 * 1000)),
);
const taskStatsEventCleanupIntervalMs = Math.max(
  60 * 1000,
  Math.floor(positiveLimit("TASK_STATS_EVENT_CLEANUP_INTERVAL_MS", 60 * 60 * 1000)),
);
const completeTaskSlowLogMs = Math.floor(positiveLimit("COMPLETE_TASK_SLOW_LOG_MS", 1000));

function createStepTimer() {
  const startedAt = performance.now();
  let previousAt = startedAt;
  const steps: Array<{ step: string; ms: number }> = [];
  return {
    mark(step: string) {
      const currentAt = performance.now();
      steps.push({
        step,
        ms: Number((currentAt - previousAt).toFixed(1)),
      });
      previousAt = currentAt;
    },
    warnIfSlow(label: string, fields: Record<string, unknown> = {}) {
      const totalMs = Number((performance.now() - startedAt).toFixed(1));
      if (totalMs < completeTaskSlowLogMs) return;
      console.warn(`${label} slow`, JSON.stringify({
        ...fields,
        totalMs,
        steps,
      }));
    },
  };
}

const upload = multer({
  dest: zipUploadDir,
  limits: { fileSize: maxZipBytes },
});

const jsonSupplementUpload = multer({
  dest: zipUploadDir,
  limits: { fileSize: 128 * 1024 * 1024 },
  fileFilter(_req, file, callback) {
    if (path.extname(file.originalname || "").toLowerCase() !== ".zip") {
      callback(httpError(400, "补充 JSON 仅支持 ZIP 文件"));
      return;
    }
    callback(null, true);
  },
});

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, callback) {
      let destination;
      try {
        destination = chunkDir(req.params.uploadId);
      } catch (error) {
        callback(error as Error, "");
        return;
      }
      fs.mkdir(destination, { recursive: true })
        .then(() => callback(null, destination))
        .catch((error: Error) => callback(error, ""));
    },
    filename(req, _file, callback) {
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0 || index >= maxChunkCount) {
        callback(httpError(400, "分片序号不正确"), "");
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

const exactTaskAssignmentUpload = multer({
  dest: taskGenerationUploadDir,
  limits: {
    files: 1,
    fileSize: 64 * 1024 * 1024,
  },
  fileFilter(_req, file, callback) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".json") {
      callback(httpError(400, "精确分配清单仅支持 JSON 文件"));
      return;
    }
    callback(null, true);
  },
});

const importJobs = new Map();
const adminExportJobs = new Map();
const adminExportQueue: AdminExportJob[] = [];
const taskGenerationJobs = new Map();
const activeTaskGenerationBySubject = new Map();
const isTaskGenerationWorker = process.env.TASK_GENERATION_WORKER === "1";
const taskGenerationJobTtlMs = 24 * 60 * 60 * 1000;
const { selectTaskGenerationJobStmt, selectActiveTaskGenerationJobBySubjectStmt, selectActiveTaskGenerationJobStmt, selectActiveTaskGenerationSubjectsStmt, upsertTaskGenerationJobStmt, deleteTaskGenerationJobStmt, deleteExpiredTaskGenerationJobsStmt, failInterruptedTaskGenerationJobsStmt } = createTaskGenerationJobStatements(db);
const sessionSeenWriteAt = new Map();
const subjectTaskReportCache = new Map();
const subjectTaskReportCacheTtlMs = 15 * 1000;
const sessionSeenWriteIntervalMs = 5 * 60 * 1000;
// Keep large task jobs bounded while avoiding thousands of tiny transactions.
// These can be tuned per deployment without changing the allocation logic.
const configuredTaskWriteBatchSize = Number.parseInt(process.env.TASK_WRITE_BATCH_SIZE || "1000", 10);
const configuredTaskWriteTransactionSize = Number.parseInt(
  process.env.TASK_WRITE_TRANSACTION_SIZE || String(configuredTaskWriteBatchSize),
  10,
);
const configuredTaskAssignBatchSize = Number.parseInt(process.env.TASK_ASSIGN_BATCH_SIZE || "1000", 10);
const TASK_WRITE_BATCH_SIZE = Number.isInteger(configuredTaskWriteBatchSize)
  ? Math.min(1000, Math.max(100, configuredTaskWriteBatchSize))
  : 1000;
const TASK_WRITE_TRANSACTION_SIZE = Number.isInteger(configuredTaskWriteTransactionSize)
  ? Math.min(1000, Math.max(TASK_WRITE_BATCH_SIZE, configuredTaskWriteTransactionSize))
  : TASK_WRITE_BATCH_SIZE;
const TASK_ASSIGN_BATCH_SIZE = Number.isInteger(configuredTaskAssignBatchSize)
  ? Math.min(5000, Math.max(100, configuredTaskAssignBatchSize))
  : 1000;
const MAX_EXACT_TASK_ASSIGNMENTS = 500000;
const taskClaimLeaseMs = Math.max(
  5 * 60 * 1000,
  Math.floor(positiveLimit("TASK_CLAIM_LEASE_MS", 30 * 60 * 1000)),
);
const TASK_GENERATION_PROGRESS_PERSIST_INTERVAL_MS = 1000;
const ADMIN_EXPORT_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_EXPORT_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.ADMIN_EXPORT_CONCURRENCY || "1", 10) || 1,
);
const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
const authFailureWindowMs = 15 * 60 * 1000;
const authAccountFailureLimit = 5;
const authAccountLockMs = 10 * 60 * 1000;
const authCaptchaTtlMs = 5 * 60 * 1000;
const authCaptchaSecret = process.env.AUTH_CAPTCHA_SECRET || crypto.randomBytes(32).toString("hex");
const {
  taskGenerationJobDto, persistTaskGenerationJob,
  recordTaskGenerationStage, getTaskGenerationJob,
  getActiveTaskGenerationJob, getAnyActiveTaskGenerationJob,
  scheduleTaskGenerationJobCleanup,
} = createTaskGenerationJobStore({
  taskGenerationJobs, activeTaskGenerationBySubject, nowIso,
  upsertTaskGenerationJobStmt, selectTaskGenerationJobStmt,
  selectActiveTaskGenerationJobBySubjectStmt,
  selectActiveTaskGenerationJobStmt, deleteTaskGenerationJobStmt,
});

const {
  adminExportJobDto, updateAdminExportJob, validateAdminExportJobId,
  adminExportFilename, normalizeAdminExportRequest,
  scheduleAdminExportJob, attachmentDisposition,
} = createAdminExportQueueService({
  adminExportQueue, ADMIN_EXPORT_CONCURRENCY,
  nowIso, httpError, parseQueryList,
  getProjectOrThrow: async (id) => {
    const project = await getProjectOrThrow(String(id));
    return { name: String(project.name) };
  },
  selectUserByIdStmt: { get: (...args) => selectUserByIdStmt.get(...args) },
  selectScorerByUsernameStmt: { get: (...args) => selectScorerByUsernameStmt.get(...args) },
  normalizeTeamIds: (...args) => normalizeTeamIds(...args),
  selectTeamByIdStmt: { get: (...args) => selectTeamByIdStmt.get(...args) },
  runAdminExportJob: (...args) => runAdminExportJob(...args),
});

function yieldToEventLoop() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

const {
  insertSubjectStmt, updateSubjectCountsStmt, markSubjectImportFailedStmt,
  selectSubjectByIdStmt, selectSubjectPendingDeletionStmt, selectSubjectsStmt,
  selectProjectByIdStmt, selectProjectByNameStmt, selectProjectsStmt,
  selectProjectPackagesStmt, insertProjectStmt, insertProjectPackageStmt,
  deleteProjectPackagesStmt, updateProjectStmt, updateProjectTaskStatusStmt,
  updateProjectTaskLockStmt, clearProjectTaskClaimsStmt, selectProjectTaskCountStmt,
  deleteUncompletedProjectTasksStmt, deleteProjectUserLinksStmt,
  deleteProjectScorerTaskStatsStmt, deleteProjectScorerScoringStatsStmt,
  deleteProjectStmt, selectPackageProjectCountStmt, selectProjectScorerAccessStmt,
} = createProjectStatements({ db, subjectSelectColumns, projectSelectColumns });
const { selectTeamByIdStmt, selectTeamByNameStmt, selectTeamsStmt, insertTeamStmt, updateTeamStmt, deleteTeamStmt, selectTeamUsageStmt, selectUserTeamsStmt, selectDisabledTeamForUserStmt, deleteUserTeamsStmt, insertUserTeamStmt, selectProjectTeamsStmt, deleteProjectTeamsStmt, insertProjectTeamStmt } = createTeamStatements(db);
const {
  selectUserAuthByUsernameStmt,
  selectScorerByUsernameStmt,
  selectUserByUsernameStmt,
  selectUserByIdStmt,
  insertScorerUserStmt,
  updateScorerUserStmt,
  deleteScorerUserStmt,
  selectAssignedTaskCountByScorerStmt,
  insertSessionStmt,
  selectSessionUserStmt,
  updateSessionSeenStmt,
  deleteSessionStmt,
  deleteExpiredSessionsStmt,
  insertAuthLoginAttemptStmt,
  selectAuthUsernameFailureCountStmt,
  deleteAuthLoginAttemptsForUsernameStmt,
  deleteExpiredAuthLoginAttemptsStmt,
  updateUserLoginFailureStmt,
  clearUserLoginFailureStmt,
  updateOwnPasswordStmt,
  insertCaptchaChallengeStmt,
  selectCaptchaChallengeStmt,
  markCaptchaChallengeUsedStmt,
  deleteExpiredCaptchaChallengesStmt,
} = createAccountStatements({ db, userSelectColumns, authAccountFailureLimit });
const { insertImportJobStmt, updateImportJobStmt, selectImportJobStmt, deleteImportJobStmt, deleteExpiredImportJobsStmt, selectPendingImportJobsStmt } = createImportStatements(db);
const { insertFeedbackStmt, selectFeedbackByIdStmt, selectFeedbackMessagesStmt, selectFeedbackMessageExistsStmt, insertFeedbackMessageStmt, updateFeedbackReplyStmt } = createFeedbackStatements(db);
const {
  selectScorerTaskStatsStmt,
  selectScorerTaskListTotalStmt,
  selectScorerProjectCountStmt,
  selectTaskByIdStmt,
  claimAssignedTaskStmt,
  releaseTaskClaimStmt,
  selectTaskImageIdsStmt,
  completeAssignedTaskStmt,
  updateCompletedTaskStmt,
  selectSubjectTaskTemplatesStmt,
} = createTaskCoreStatements(db);
const { upsertSubjectTaskTemplateStatsStmt, upsertAllSubjectTaskTemplateStatsStmt } = createTaskTemplateStatements(db);
const {
  updateSubjectTaskStatusStmt, selectProjectTaskStatsStmt, deleteProjectTaskStatsStmt,
  insertProjectTaskStatsFromTasksStmt, backfillProjectTaskBaseStatsStmt,
  deleteScorerTaskStatsStmt, insertScorerTaskStatsFromTasksStmt,
  deleteScorerScoringStatsStmt, insertScorerScoringStatsFromTasksStmt,
  addDashboardCompletionHourStatsStmt, subtractDashboardCompletionHourStatsStmt,
  selectPendingTaskStatsEventsStmt, selectPendingProjectTaskStatsEventHourDeltasStmt,
  markPendingProjectTaskStatsEventsStmt, markTaskStatsEventsProcessedByIdsStmt,
  tryTaskStatsMaintenanceLockStmt, lockTaskStatsMaintenanceStmt,
  updateProjectTaskStatsDeltaStmt, reconcileProjectTaskStatsStmt,
  updateScorerTaskStatsDeltaStmt, insertScorerTaskStatsDeltaStmt,
  deleteEmptyScorerTaskStatsStmt, updateScorerScoringStatsDeltaStmt,
  insertScorerScoringStatsDeltaStmt, deleteEmptyScorerScoringStatsStmt,
  refreshScorerScoringExtremaStmt, deleteProcessedTaskStatsEventsStmt,
  deleteProjectTaskStatsEventsStmt,
} = createTaskStatsStatements({ db, placeholders });
const { selectPendingProjectTaskIdsStmt, selectSubjectScorerNamesStmt, selectSubjectAssignedScorerCountsStmt, selectAvailableSubjectScorersStmt, selectReassignableTaskIdsStmt, selectReassignableTaskIdsByScorerStmt } = createTaskAssignmentStatements({ db, userSelectColumns });
const { selectImageByIdStmt, selectAssignedTaskForImageStmt, markSubjectForDeletionStmt, selectSubjectStoragePathsStmt, deleteQueuedSubjectStmt, updateImageScoreStmt } = createAssetStatements({ db, imageSelectColumns });
const { selectQueuedSubjectsStmt, markInterruptedImportJobsStmt, selectCompletedProjectsStmt } = createStartupStatements(db);

function httpError(status: number, message: string, publicCode: string | null = null): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  if (publicCode) error.publicCode = publicCode;
  return error;
}

function isUniqueConstraintError(error: unknown) {
  const candidate = error as ApiError;
  return (
    candidate?.code === "23505" ||
    String(candidate?.message || "").includes("UNIQUE constraint failed")
  );
}

function archiveImportError(status: number, message: string, cause?: unknown) {
  const error = httpError(status, message);
  error.isArchiveImportError = true;
  if (cause) error.cause = cause;
  return error;
}

function normalizeArchiveImportError(error: unknown): ApiError {
  const candidate = error as ApiError;
  if (candidate?.isArchiveImportError || candidate?.status) return candidate;

  if (candidate?.code === "ENOSPC") {
    return archiveImportError(
      507,
      "服务器磁盘空间不足，无法保存解压后的图片",
      error,
    );
  }
  if (candidate?.code === "EACCES" || candidate?.code === "EPERM") {
    return archiveImportError(500, "服务器上传目录没有读写权限", error);
  }
  if (candidate?.code === "SQLITE_BUSY") {
    return archiveImportError(503, "数据库正被其他操作占用，请稍后重试", error);
  }

  return archiveImportError(
    500,
    "导入过程中发生未预期错误，已清理本次上传内容，请重试",
    error,
  );
}

const { cleanRelative, decodeZipEntryPath, isInfographicPath, loadArchiveManifests, loadArchiveTaskManifest, loadSupplementalJsonArchive, loadImageCatalogIndex, catalogEntryForImage, buildArchiveImageReferenceRecords, validateTaskManifest, buildTaskTemplateRecords, assertTaskManifestValid, catalogPrompt, parseCatalogData, assertArchiveLimits, decompressionLimit, openZip64Archive, isMacMetadataEntry, allocateSubjectStorageRoot, markSupplementableJsonError } = createImportManifestService({
  archiveImportError, imageExts,
  maxArchiveEntries, maxArchiveUncompressedBytes, maxZipBytes,
  taskCriteria, taskTemplateRoles, uploadDir,
});


const {
  bulkInsertImageRecords, bulkInsertSubjectTaskTemplates,
  bulkInsertSubjectTaskTemplateItems, refreshSubjectTaskTemplateStats,
  queueSubjectTaskTemplateStatsBackfill, queueProjectTaskBaseStatsBackfill,
} = createImportWritesService({
  db, importDbBatchSize, importDbItemBatchSize, placeholders,
  archiveImportError, nowIso, upsertSubjectTaskTemplateStatsStmt,
  upsertAllSubjectTaskTemplateStatsStmt, backfillProjectTaskBaseStatsStmt,
  taskVersion,
});

const scheduleImportedThumbnailJobs = createThumbnailImportScheduler({
  db,
  runWithDatabaseContext,
  operationalLogger,
  batchSize: importDbItemBatchSize,
});
const { validateUploadId, chunkDir, resumableUploadExpiresAt, cleanupPendingJsonImport, parseTusMetadataHeader, requireTusResumableHeader, resumableUploadResponseHeaders, resumableUploadDto, loadResumableUploadSession, saveResumableUploadSession, createResumableUploadSession, cleanupResumableUploadSession, sweepResumableUploadSessions, sweepPendingJsonImports, normalizeTusFilename, withResumableUploadLock, importZipArchive, runResumableImportJob, importJobExpiry, importJobDto, importJobFromRow, persistImportJob, runChunkedImportJob, runSupplementalJsonImportJob } = createImportJobsService({
  allocateSubjectStorageRoot, archiveImportError, assertArchiveLimits,
  assertTaskManifestValid, buildArchiveImageReferenceRecords,
  buildTaskTemplateRecords, bulkInsertImageRecords,
  bulkInsertSubjectTaskTemplateItems, bulkInsertSubjectTaskTemplates,
  catalogEntryForImage, catalogPrompt, chunkUploadDir, cleanRelative,
  db, decodeZipEntryPath, decompressionLimit, deleteImportJobStmt,
  httpError, imageExts, imageImportConcurrency, importArchive, importJobs,
  insertSubjectStmt, isInfographicPath, isMacMetadataEntry,
  loadArchiveManifests, loadArchiveTaskManifest, loadImageCatalogIndex,
  loadSupplementalJsonArchive, markSubjectImportFailedStmt,
  markSupplementableJsonError,
  maxImageUncompressedBytes, maxZipBytes, normalizeArchiveImportError,
  nowIso, openZip64Archive, pendingJsonImportDir,
  refreshSubjectTaskTemplateStats, resumableUploadDir,
  resumableUploadExpiryMs, scheduleImportedThumbnailJobs,
  selectPendingImportJobsStmt, selectSubjectByIdStmt, subjectDto,
  tusVersion, updateImportJobStmt, updateSubjectCountsStmt, uploadDir,
  validateTaskManifest,
});


function nowIso() {
  return new Date().toISOString();
}

const {
  scoreStateColumn, parseScoreRange, escapeLike,
  parseScorerName, normalizeScorePayload, scoreFromRow,
} = createScoreService({ httpError, scoreNumericFields, skippableScoreFields, nowIso });

const { listFeedbacks, createFeedback, addFeedbackMessage, updateFeedbackStatus } = createFeedbackService({
  db, placeholders, httpError, nowIso, feedbackImageExts,
  feedbackUploadDir, uploadDir, insertFeedbackStmt,
  selectFeedbackByIdStmt, selectFeedbackMessagesStmt,
  selectFeedbackMessageExistsStmt, insertFeedbackMessageStmt,
  updateFeedbackReplyStmt,
});



function imageDto(row: DbRow) {
  return {
    _id: row._id,
    subjectId: row.subjectId,
    filename: row.filename,
    originalPath: row.originalPath,
    category: row.category,
    directory: row.directory || "",
    isInfographic: Boolean(row.isInfographic),
    prompt: row.prompt ?? null,
    catalog: parseCatalogData(row.catalogData as string | null),
    imageUrl: imageAssetUrl(row.storagePath as string | null | undefined),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath as string | null | undefined),
    score: scoreFromRow(row),
  };
}


const {
  getProjectTaskStats,
  beginSynchronousTaskStatsTransaction, beginTaskWriteTransaction,
  recordTaskStatsEvents,
  scoringStatsAdditiveFields, aggregateTaskStatsEvents,
} = createTaskStatsWriteService({
  db, taskVersion, nowIso, selectProjectTaskStatsStmt,
  taskStatsEventInsertBatchSize,
});


const {
  refreshProjectTaskStats,
  queueTaskGenerationAnalyze, invalidateTaskSummaryCaches,
  queueProjectTaskSummary,
  refreshGeneratedProjectTaskStats, hasActiveTaskGeneration,
  startTaskStatsWorkers,
} = createTaskStatsWorkerService({
  db, taskVersion, nowIso, scoringStatsAdditiveFields, aggregateTaskStatsEvents,
  getProjectTaskStats, subjectTaskReportCache,
  getTaskGenerationCapacity: (...args) => getTaskGenerationCapacity(...args),
  runWithDatabaseContext, retryTaskStatsRefresh, activeTaskGenerationBySubject,
  taskGenerationJobs, taskStatsEventRetentionMs, taskStatsEventScanBatchSize,
  taskStatsEventFlushIntervalMs, taskStatsEventCleanupIntervalMs,
  invalidateScorerQueryCaches, updateProjectTaskStatsDeltaStmt,
  reconcileProjectTaskStatsStmt, updateScorerTaskStatsDeltaStmt,
  insertScorerTaskStatsDeltaStmt, deleteEmptyScorerTaskStatsStmt,
  updateScorerScoringStatsDeltaStmt, insertScorerScoringStatsDeltaStmt,
  refreshScorerScoringExtremaStmt, deleteEmptyScorerScoringStatsStmt,
  addDashboardCompletionHourStatsStmt, subtractDashboardCompletionHourStatsStmt,
  deleteProjectTaskStatsStmt, insertProjectTaskStatsFromTasksStmt,
  deleteScorerTaskStatsStmt, insertScorerTaskStatsFromTasksStmt,
  deleteScorerScoringStatsStmt, insertScorerScoringStatsFromTasksStmt,
  selectPendingProjectTaskStatsEventHourDeltasStmt,
  markPendingProjectTaskStatsEventsStmt, selectProjectByIdStmt,
  updateSubjectTaskStatusStmt, lockTaskStatsMaintenanceStmt,
  deleteProcessedTaskStatsEventsStmt, tryTaskStatsMaintenanceLockStmt,
  selectPendingTaskStatsEventsStmt, selectActiveTaskGenerationSubjectsStmt,
  markTaskStatsEventsProcessedByIdsStmt,
});

const {
  mapProjectRows, projectDto,
  projectSubjectDto, listProjects, listProjectsPage,
} = createProjectViewService({
  db, taskVersion, placeholders, selectProjectTaskStatsStmt,
  selectProjectPackagesStmt, selectProjectTeamsStmt,
  getProjectTaskStats, teamDto: teamDtoFromDb, selectProjectsStmt,
  parseTaskPagination, projectSelectColumns,
});
const projectDtoFromDb = (row: unknown) => projectDto(row as Parameters<typeof projectDto>[0]);
const mapProjectRowsFromDb = (rows: DbRow[]) => mapProjectRows(rows as Parameters<typeof mapProjectRows>[0]);
const projectPackageIdsFromDb = (row: DbRow) => projectPackageIds(row as Parameters<typeof projectPackageIds>[0]);

const {
  normalizeTeamNames, normalizeTeamIds, parseEnabledStatus,
  listTeams, createTeam, updateTeam,
  syncUserTeams, syncProjectTeams, deleteTeam,
} = createTeamService({
  db, httpError, nowIso, teamDto: teamDtoFromDb, isUniqueConstraintError,
  selectTeamByIdStmt, selectTeamByNameStmt, insertTeamStmt,
  selectTeamsStmt, updateTeamStmt, deleteTeamStmt, selectTeamUsageStmt,
  deleteUserTeamsStmt, insertUserTeamStmt, deleteProjectTeamsStmt,
  insertProjectTeamStmt,
});

const {
  projectPackageIds, getProjectOrThrow, createProject, updateProject,
  updateProjectTaskLock, listVisibleProjects, deleteProject,
} = createProjectService({
  db, httpError, nowIso, taskVersion, projectSelectColumns,
  selectProjectByNameStmt, selectProjectPackagesStmt, selectSubjectByIdStmt,
  selectProjectByIdStmt, insertProjectStmt, insertProjectPackageStmt,
  selectProjectTaskCountStmt, updateProjectStmt, deleteProjectPackagesStmt,
  updateProjectTaskLockStmt, clearProjectTaskClaimsStmt,
  deleteUncompletedProjectTasksStmt, deleteProjectUserLinksStmt,
  deleteProjectScorerTaskStatsStmt, deleteProjectScorerScoringStatsStmt,
  deleteProjectTaskStatsStmt, deleteProjectTaskStatsEventsStmt, deleteProjectStmt,
  isUniqueConstraintError, projectDto: projectDtoFromDb, listProjects, listProjectsPage,
  hasPaginationQuery, mapProjectRows: mapProjectRowsFromDb, invalidateScorerQueryCaches,
  invalidateTaskSummaryCaches, activeTaskGenerationBySubject, taskGenerationJobs,
});

const { queueSubjectDeletion, assertPackageCanBeDeleted } = createSubjectDeletionService({
  db, uploadDir, runWithDatabaseContext, invalidateScorerQueryCaches,
  selectSubjectPendingDeletionStmt, selectSubjectStoragePathsStmt,
  deleteQueuedSubjectStmt, selectPackageProjectCountStmt, httpError,
});

const {
  userDto, normalizeUsername, parseUserPassword, hashPassword,
  verifyPassword, scorerAvailabilityError, assertScorerAssignable,
} = createUserIdentityService({
  httpError, selectUserTeamsStmt, selectDisabledTeamForUserStmt, teamDto: teamDtoFromDb,
});
const userDtoFromDb = (row: unknown) => userDto(row as Parameters<typeof userDto>[0]);
const assertScorerAssignableFromDb = (row: DbRow | undefined, name?: string) =>
  assertScorerAssignable(row as Parameters<typeof assertScorerAssignable>[0], name);

const {
  cookieValue, sessionTokenHash, loginRequestIp, authCutoff, authLockError,
  loginFailureWarning, createLoginCaptcha, consumeLoginCaptcha,
  loginCaptchaRequired, recordLoginFailure, clearLoginFailures,
  createSession, setSessionCookie, clearSessionCookie,
  requireAuth, requireAdmin, requireScorer, requirePasswordChanged,
} = createAuthSessionService({
  httpError, nowIso, userDto: userDtoFromDb, scorerAvailabilityError,
  authAccountFailureLimit, authCaptchaSecret, authCaptchaTtlMs,
  authFailureWindowMs, authAccountLockMs, sessionDurationMs,
  sessionSeenWriteAt, sessionSeenWriteIntervalMs,
  deleteExpiredCaptchaChallengesStmt, insertCaptchaChallengeStmt,
  selectCaptchaChallengeStmt, markCaptchaChallengeUsedStmt,
  selectAuthUsernameFailureCountStmt, insertAuthLoginAttemptStmt,
  updateUserLoginFailureStmt, clearUserLoginFailureStmt,
  deleteAuthLoginAttemptsForUsernameStmt, deleteExpiredSessionsStmt,
  insertSessionStmt, updateSessionSeenStmt, selectSessionUserStmt,
  deleteSessionStmt,
});

const { assertSubjectAccess, listVisibleSubjects, ensureFileAccess, parseProjectId } = createAccessService({
  db, httpError, selectProjectByIdStmt, selectSubjectByIdStmt,
  selectSubjectsStmt, taskVersion, cleanRelative, imageExts,
  getProjectOrThrow,
});

const { loginUser, changeOwnPassword } = createLoginService({
  httpError, nowIso, normalizeUsername, parseUserPassword,
  verifyPassword, hashPassword, userDto: userDtoFromDb, scorerAvailabilityError,
  consumeLoginCaptcha, authLockError, loginCaptchaRequired,
  loginFailureWarning, recordLoginFailure, clearLoginFailures,
  authAccountLockMs, selectUserAuthByUsernameStmt,
  selectScorerByUsernameStmt, selectUserByIdStmt, updateOwnPasswordStmt,
  deleteAuthLoginAttemptsForUsernameStmt, db,
});

const {
  listScorerUsers, createScorerUser, createScorerUsers,
  updateScorerUser, normalizeTeamMatchMode,
  listScorersByTeamIds, deleteScorerUser,
} = createScorerAccountService({
  db, httpError, nowIso, parseTaskPagination, parseQueryList,
  normalizeTeamIds, parseOptionalDateFilter, escapeSqlLike,
  placeholders, userSelectColumns, userDto: userDtoFromDb, normalizeUsername,
  parseUserPassword, normalizeTeamNames, selectUserByUsernameStmt,
  insertScorerUserStmt, hashPassword, syncUserTeams,
  selectScorerByUsernameStmt, selectUserByIdStmt,
  isUniqueConstraintError, parseEnabledStatus, updateScorerUserStmt,
  selectAssignedTaskCountByScorerStmt, deleteScorerUserStmt,
});

const { loadUnmaterializedProjectTaskTemplates,
  loadProjectTaskTemplatesBySourceTaskIds, buildGeneratedTaskRecord,
  writeGeneratedTaskGroup,
  loadTaskRecordsForBacktest, parseBacktestRatio,
  expandBacktestAllocations, buildBacktestTaskRows,
  buildDimensionAwareAssignmentPlan } = createTaskGenerationTemplatesService({
  TASK_WRITE_BATCH_SIZE, beginTaskWriteTransaction, db, httpError,
  nowIso, placeholders, projectPackageIds: projectPackageIdsFromDb, selectProjectByIdStmt,
  selectSubjectTaskTemplatesStmt, taskVersion, yieldToEventLoop,
});

const adminDashboardService = createAdminDashboardService({
  db,
  taskVersion,
  httpError,
  nowIso,
  normalizeTeamIds,
  parseProjectId,
  parseTaskPagination,
  hydrateTaskRows: (rows, options) => hydrateTaskRows(rows as Parameters<typeof hydrateTaskRows>[0], options),
  selectUserByIdStmt,
  selectScorerByUsernameStmt,
  selectTeamByIdStmt,
});
const {
  exportCompletedTasks,
  exportScorerTaskSummary,
  exportTeamTaskSummary,
  writeProjectCompletedTasksExport,
  writeScorerCompletedTasksExport,
  writeTeamTaskSummaryExport,
} = adminDashboardService;

const adminScoringService = createAdminScoringService({
  db,
  taskVersion,
  httpError,
  nowIso,
  parseProjectId,
  parseTaskPagination,
  selectScorerByUsernameStmt,
  assertScorerAssignable: assertScorerAssignableFromDb,
  withDatabaseContext: runWithDatabaseContext,
  onTasksChanged: () => invalidateScorerQueryCaches(),
  recordTaskStatsEvents,
});
const {
  writeScoringOperationsExport,
  writeScoringRiskReport,
  invalidateSummaryCache,
} = adminScoringService;

const adminThumbnailService = createAdminThumbnailService({
  db,
  httpError,
  nowIso,
});
function getBackgroundActivity() {
  const tasks = [];
  for (const job of taskGenerationJobs.values()) {
    if (!["queued", "running"].includes(job.status)) continue;
    tasks.push({
      type: "task-generation",
      label: "任务下发",
      detail: job.stage || "正在生成任务",
      progress: Number(job.progress || 0),
    });
  }
  for (const job of adminExportJobs.values()) {
    if (!["queued", "running"].includes(job.status)) continue;
    tasks.push({
      type: "admin-export",
      label: "管理端导出",
      detail: job.stage || "正在导出",
      progress: Number(job.progress || 0),
    });
  }
  for (const job of importJobs.values()) {
    if (["completed", "failed", "awaiting_json"].includes(job.status)) continue;
    tasks.push({
      type: "image-import",
      label: "图片导入",
      detail: job.stage || job.status || "正在导入",
      progress: Number(job.progress || 0),
    });
  }
  return tasks;
}

const adminSystemService = createAdminSystemService({
  db,
  uploadDir,
  nowIso,
  apiActivity,
  getBackgroundActivity,
});
const adminLogService = createAdminLogService({ logDir });

const { hydrateTaskListRows, listSubjectTaskOptions, listSubjectTasks } = createAdminTaskListService({
  db, taskListImageSelectColumns, taskListImageDto: taskListImageDtoFromDb, placeholders,
  parseTaskPagination, parseScorerName, taskVersion, taskCriteria,
  parseTaskCursor, getProjectTaskStats, includeTaskTotal,
  serializeTaskCursor,
});

const { getSubjectTaskReportSummary, exportSubjectTaskReport, writeSubjectTaskReportFile } = createTaskReportService({
  taskCriterionLabels, subjectTaskReportCache, subjectTaskReportCacheTtlMs,
  getProjectOrThrow, projectPackageIds, db, placeholders,
  getProjectTaskStats, taskVersion, ExcelJS,
});

const { runAdminExportJob, startAdminExportJob } = createAdminExportJobService({
  updateAdminExportJob, adminExportDir, writeProjectCompletedTasksExport,
  writeScorerCompletedTasksExport, writeScoringOperationsExport,
  writeScoringRiskReport, writeTeamTaskSummaryExport, writeSubjectTaskReportFile,
  httpError, adminExportJobs, ADMIN_EXPORT_JOB_TTL_MS,
  normalizeAdminExportRequest, adminExportFilename, nowIso,
  scheduleAdminExportJob,
});

const { buildScorerTaskFilter } = createScorerTaskFilterService({
  parseScorerName, httpError, parseProjectId, selectScorerByUsernameStmt,
  taskVersion, activeTaskGenerationBySubject, hasActiveTaskGeneration,
  placeholders, taskCriteria,
});

const assignedTaskListCache = new Map();
const assignedTaskListCacheTtlMs = 1000;
const assignedTaskCountCache = new Map();
const assignedTaskCountCacheTtlMs = 15 * 1000;
let assignedTaskCacheVersion = 0;

function invalidateAssignedTaskListCache() {
  assignedTaskCacheVersion += 1;
  assignedTaskListCache.clear();
  assignedTaskCountCache.clear();
}

function invalidateScorerQueryCaches() {
  invalidateAssignedTaskListCache();
  scorerDashboardCache.clear();
  invalidateSummaryCache();
}

const scorerDashboardCache = new Map();
const scorerDashboardCacheTtlMs = 2 * 1000;

async function assertProjectTasksUnlocked(projectId: string) {
  const project = await selectProjectByIdStmt.get(projectId);
  if (!project || project.tasksLocked) {
    throw httpError(423, "该项目任务已锁定，请等待管理员开放", "PROJECT_TASKS_LOCKED");
  }
  return project;
}

const { parseTaskExcludedImageIds, parseTaskCorrectImageIds, parseTaskRanking, parseTaskRankingRelations, parseTaskDuration, parseRankingActionCount, parseLargeImageOpened, parseTaskBehaviorCount, parseTaskBehaviorBoolean, parseTaskClaimToken, parseFirstActionMs, hasTaskBehaviorTracking, calculateTaskRisk, parseTaskSubmissionMode } = createTaskSubmissionValidation({
  httpError, taskExclusionCriteria, taskCorrectnessCriteria,
});

const { claimTaskForScorer, releaseTaskClaim, completeAssignedTask, updateCompletedTask } = createTaskSubmissionService({
  nowIso, taskClaimLeaseMs, db, claimAssignedTaskStmt, taskVersion,
  selectTaskByIdStmt, assertProjectTasksUnlocked, httpError, parseTaskClaimToken,
  releaseTaskClaimStmt, createStepTimer, parseScorerName, completedTaskResultDto,
  selectTaskImageIdsStmt, parseTaskExcludedImageIds, parseTaskCorrectImageIds,
  parseTaskRanking, parseTaskRankingRelations, parseTaskDuration,
  parseRankingActionCount, hasTaskBehaviorTracking, parseTaskBehaviorCount,
  parseTaskBehaviorBoolean, parseLargeImageOpened, parseFirstActionMs,
  calculateTaskRisk, parseTaskSubmissionMode, beginSynchronousTaskStatsTransaction,
  completeAssignedTaskStmt, recordTaskStatsEvents, invalidateTaskSummaryCaches,
  invalidateScorerQueryCaches, updateCompletedTaskStmt, hydrateTaskRows,
});

const { assignedTaskOptions, listAssignedTasks, getTaskDetail, getScorerDashboard } = createScorerTaskListService({
  taskCriteria, selectScorerTaskListTotalStmt, taskVersion,
  assignedTaskCountCache, assignedTaskCountCacheTtlMs, db,
  selectScorerByUsernameStmt, httpError, hasActiveTaskGeneration,
  assignedTaskListCache, assignedTaskListCacheTtlMs,
  getAssignedTaskCacheVersion: () => assignedTaskCacheVersion, buildScorerTaskFilter,
  parseTaskPagination, parseTaskCursor, includeTaskTotal,
  serializeTaskCursor, hydrateTaskListRows, selectTaskByIdStmt,
  assertProjectTasksUnlocked, claimTaskForScorer, parseTaskClaimToken,
  hydrateTaskRows, parseScorerName, parseProjectId,
  selectScorerTaskStatsStmt, selectScorerProjectCountStmt,
  scorerDashboardCache, scorerDashboardCacheTtlMs,
});


const { parseTaskAssignees, parseTaskGenerationAssignees, parseExactTaskGenerationAssignment, parseTaskAllocationWorkbook } = createTaskAssignmentInputService({
  normalizeUsername, httpError, selectScorerByUsernameStmt,
  assertScorerAssignable: assertScorerAssignableFromDb, parseGenerationAssignees, normalizeTeamIds,
  normalizeTeamMatchMode, parseBacktestRatio, listScorersByTeamIds,
  MAX_EXACT_TASK_ASSIGNMENTS,
});

const { getTaskReassignmentOptions, reassignSubjectTasks } = createTaskReassignmentService({
  getProjectOrThrow, getProjectTaskStats, selectAvailableSubjectScorersStmt,
  userDto: userDtoFromDb, selectSubjectAssignedScorerCountsStmt, taskVersion,
  parseTaskAssignees, selectSubjectScorerNamesStmt, httpError,
  normalizeUsername, selectReassignableTaskIdsStmt,
  selectReassignableTaskIdsByScorerStmt, buildDimensionAwareAssignmentPlan,
  nowIso, beginTaskWriteTransaction, TASK_ASSIGN_BATCH_SIZE, db,
  placeholders, refreshProjectTaskStats, invalidateTaskSummaryCaches,
  invalidateScorerQueryCaches,
});

const { assignGeneratedTasks, rollbackGeneratedTasks } = createTaskGenerationOperations({
  httpError, nowIso, TASK_ASSIGN_BATCH_SIZE, beginTaskWriteTransaction,
  db, placeholders, yieldToEventLoop, invalidateTaskSummaryCaches,
  invalidateScorerQueryCaches, TASK_WRITE_BATCH_SIZE, updateProjectTaskStatusStmt,
});

const { getTaskGenerationCapacity, prepareTaskGeneration, taskGenerationRequestSummary } =
  createTaskGenerationPlanService({
    parseBacktestRatio, expandBacktestAllocations, getProjectOrThrow,
    projectPackageIds: projectPackageIdsFromDb, db, placeholders, taskVersion, httpError,
  });

const { generateSubjectTasks } = createTaskGenerationExecutionService({
  httpError, TASK_WRITE_BATCH_SIZE, db, placeholders,
  getProjectOrThrow, prepareTaskGeneration,
  loadProjectTaskTemplatesBySourceTaskIds, buildGeneratedTaskRecord,
  TASK_WRITE_TRANSACTION_SIZE, writeGeneratedTaskGroup, yieldToEventLoop,
  assignGeneratedTasks, syncProjectTeams, nowIso, updateSubjectTaskStatusStmt,
  refreshGeneratedProjectTaskStats, invalidateTaskSummaryCaches,
  invalidateScorerQueryCaches, selectProjectByIdStmt, getProjectTaskStats,
  projectDto: projectDtoFromDb, taskVersion, rollbackGeneratedTasks,
  selectPendingProjectTaskIdsStmt, loadUnmaterializedProjectTaskTemplates,
  buildDimensionAwareAssignmentPlan, loadTaskRecordsForBacktest,
  buildBacktestTaskRows,
});

const { startSubjectTaskGeneration, startExactSubjectTaskGeneration } =
  createTaskGenerationJobService({
    getActiveTaskGenerationJob, getAnyActiveTaskGenerationJob, httpError,
    prepareTaskGeneration, nowIso, taskGenerationRequestSummary,
    taskGenerationJobTtlMs, persistTaskGenerationJob, taskGenerationJobs,
    activeTaskGenerationBySubject, invalidateScorerQueryCaches,
    invalidateTaskSummaryCaches, recordTaskGenerationStage,
    TASK_GENERATION_PROGRESS_PERSIST_INTERVAL_MS, queueTaskGenerationAnalyze,
    scheduleTaskGenerationJobCleanup, getProjectOrThrow,
    getTaskGenerationCapacity, parseTaskGenerationAssignees,
    parseExactTaskGenerationAssignment,
  });

const { listImages, getCategories, getScorers } = createCatalogService({
  escapeLike, scoreFilterKeys, parseScoreRange, skippableScoreFields,
  scoreStateColumn, db, imageSelectColumns, imageListSelectColumns,
  imageDto, imageListDto: imageListDtoFromDb,
});

app.use(
  "/files",
  ensureFileAccess,
  express.static(uploadDir, {
    maxAge: "7d",
    immutable: true,
    index: false,
  }),
);

registerPublicAuthRoutes(app, {
  loginUser,
  loginRequestIp,
  createSession,
  setSessionCookie,
  createLoginCaptcha,
});

app.use("/api", requireAuth);

registerSessionAuthRoutes(app, {
  changeOwnPassword,
  cookieValue,
  sessionTokenHash,
  deleteSessionStmt,
  sessionSeenWriteAt,
  clearSessionCookie,
});

app.use("/api", requirePasswordChanged);
app.use("/api/admin", requireAdmin);
app.use("/api/users", requireAdmin);
app.use("/api/import", requireAdmin);
app.use("/api/scorer", requireScorer);
app.use("/api/tasks/assigned", requireScorer);

registerAdminExportRoutes(app, {
  startAdminExportJob,
  adminExportJobDto,
  validateAdminExportJobId,
  adminExportJobs,
  httpError,
  attachmentDisposition,
  exportCompletedTasks,
  exportScorerTaskSummary,
  exportTeamTaskSummary,
});
registerAdminDashboardRoutes(app, adminDashboardService);
registerAdminThumbnailRoutes(app, adminThumbnailService);
registerAdminSystemRoutes(app, { systemService: adminSystemService, logService: adminLogService });
registerAdminScoringRoutes(app, adminScoringService, { httpError, setShortApiCache });

registerAdminAccountRoutes(app, {
  listScorerUsers,
  createScorerUser,
  createScorerUsers,
  updateScorerUser,
  listTeams,
  createTeam,
  normalizeTeamIds,
  normalizeTeamMatchMode,
  listScorersByTeamIds,
  updateTeam,
  deleteTeam,
  deleteScorerUser,
}, requireAdmin);

registerScorerTaskListRoutes(app, { assignedTaskOptions, listAssignedTasks, getScorerDashboard }, setShortApiCache);
registerFeedbackRoutes(app, { listFeedbacks, createFeedback, addFeedbackMessage, updateFeedbackStatus }, {
  requireScorer,
  requireAdmin,
  feedbackUpload,
  setShortApiCache,
});
registerScorerTaskDetailRoutes(app, {
  completeAssignedTask,
  updateCompletedTask,
  getTaskDetail,
  releaseTaskClaim,
}, requireScorer);

registerCatalogRoutes(app, {
  listVisibleSubjects, subjectDto: subjectDtoFromDb, httpError, assertSubjectAccess,
  getCategories, getScorers, listImages, setShortApiCache,
});

registerProjectRoutes(app, {
  listVisibleProjects,
  getProjectOrThrow,
  projectDto: projectDtoFromDb,
  createProject,
  updateProject,
  updateProjectTaskLock,
  deleteProject,
  httpError,
  async canScorerAccessProject(projectId, username) {
    return selectProjectScorerAccessStmt.get(projectId, username);
  },
}, requireAdmin);

registerAdminTaskRoutes(app, {
  getTaskReassignmentOptions, reassignSubjectTasks, getSubjectTaskReportSummary,
  exportSubjectTaskReport, getProjectOrThrow, listSubjectTaskOptions, projectDto: projectDtoFromDb,
  projectSubjectDto, listSubjectTasks, taskAllocationUpload, parseTaskAllocationWorkbook,
  taskGenerationJobDto, startSubjectTaskGeneration, startExactSubjectTaskGeneration,
  exactTaskAssignmentUpload, getTaskGenerationJob, httpError, getTaskDetail,
}, requireAdmin);

registerDirectImportRoute(app, { upload, importZipArchive });

registerImportUploadRoutes(app, {
  tusVersion, maxZipBytes, requireTusResumableHeader, httpError,
  parseTusMetadataHeader, normalizeTusFilename, createResumableUploadSession,
  resumableUploadResponseHeaders, resumableUploadDto, loadResumableUploadSession,
  resumableUploadMaxChunkBytes, withResumableUploadLock, nowIso,
  resumableUploadExpiresAt, saveResumableUploadSession, importJobExpiry,
  insertImportJobStmt, importJobs, runResumableImportJob, validateUploadId,
  importJobFromRow, selectImportJobStmt, importJobDto, selectPendingImportJobsStmt,
  jsonSupplementUpload, persistImportJob, runSupplementalJsonImportJob,
  cleanupResumableUploadSession, cleanupPendingJsonImport, deleteImportJobStmt,
  chunkUpload, maxChunkCount, chunkDir, zipUploadDir, runChunkedImportJob,
});

registerCatalogMutationRoutes(app, {
  selectSubjectByIdStmt, assertPackageCanBeDeleted, markSubjectForDeletionStmt,
  subjectDto: subjectDtoFromDb, queueSubjectDeletion, selectImageByIdStmt, selectAssignedTaskForImageStmt,
  httpError, normalizeScorePayload, updateImageScoreStmt, imageDto,
}, requireAdmin);

app.use(((error: ApiError, req, res, _next) => {
  const timedOut = error?.code === "57014" || (error?.cause as ApiError | undefined)?.code === "57014";
  const poolQueueTimedOut = error?.message === "timeout exceeded when trying to connect";
  let status = timedOut || poolQueueTimedOut ? 503 : error.status || 500;
  let message = timedOut
    ? "查询执行超时，请稍后重试"
    : poolQueueTimedOut
      ? "请求较多，请稍后重试"
      : error.message || "服务异常";
  const code = timedOut
    ? "QUERY_TIMEOUT"
    : poolQueueTimedOut
      ? "QUERY_QUEUE_TIMEOUT"
      : error.publicCode || error.code || "REQUEST_FAILED";

  if (error instanceof multer.MulterError) {
    status = 400;
    message =
      error.code === "LIMIT_FILE_SIZE"
        ? req.path.includes("/chunks/")
          ? "上传分片超过大小限制，请重新上传该文件"
          : req.path.includes("/tasks/generate/exact")
            ? "精确分配清单超过 64MB"
            : "ZIP 文件超过服务器允许的大小限制"
        : "上传文件数据不完整，请重新上传";
  }

  if (error.retryAfterSeconds != null) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
  if (status >= 500) {
    operationalLogger.error({
      kind: "api-error",
      message,
      code,
      status,
      api: requestLogMetadata(req),
      metadata: {
        timedOut,
        poolQueueTimedOut,
      },
    }, error);
  }
  res.status(status).json({ message, code });
}) satisfies ErrorRequestHandler);

export async function runStartupMaintenance() {
  if (isTaskGenerationWorker) return;
  startupState.status = "maintaining";
  startupState.error = null;
  console.info("API startup maintenance started");
  try {
    const queuedSubjects = await selectQueuedSubjectsStmt.all();
    for (const subject of queuedSubjects) queueSubjectDeletion(String(subject.id));

    const startupNow = nowIso();
    await deleteExpiredSessionsStmt.run(startupNow);
    await deleteExpiredAuthLoginAttemptsStmt.run(authCutoff(startupNow, 24 * 60 * 60 * 1000));
    await deleteExpiredCaptchaChallengesStmt.run(startupNow);
    await deleteExpiredImportJobsStmt.run(startupNow);
    await deleteExpiredTaskGenerationJobsStmt.run(startupNow);
    await sweepResumableUploadSessions();
    await markInterruptedImportJobsStmt.run({ updatedAt: startupNow });
    await failInterruptedTaskGenerationJobsStmt.run({ updatedAt: startupNow });
    await sweepPendingJsonImports();
    queueSubjectTaskTemplateStatsBackfill();
    queueProjectTaskBaseStatsBackfill();
    startTaskStatsWorkers();
    const completedProjects = await selectCompletedProjectsStmt.all();
    completedProjects.forEach((project) => queueProjectTaskSummary(String(project.id)));
    startupState.status = "ready";
    startupState.completedAt = new Date().toISOString();
    console.info("API startup maintenance completed");
  } catch (error) {
    startupState.status = "degraded";
    startupState.error = error instanceof Error ? error.message : String(error);
    console.error("API startup maintenance failed; API remains available for diagnosis", error);
  }
}

export { generateSubjectTasks, importZipArchive, startupState };
export default app;
