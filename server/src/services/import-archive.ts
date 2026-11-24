import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { uploadFilePath } from "../image-assets.ts";
import type { db as database } from "../postgres.ts";
import type { subjectDto as formatSubject } from "./dto.ts";
import type { createImportManifestService } from "./import-manifest.ts";
import type { createImportWritesService } from "./import-writes.ts";
import type { createThumbnailImportScheduler } from "./thumbnail-import.ts";

type ManifestFns = ReturnType<typeof createImportManifestService>;
type WritesFns = ReturnType<typeof createImportWritesService>;
type ImageRows = Parameters<WritesFns["bulkInsertImageRecords"]>[0];
type Progress = { stage: string; progress: number; current: number; total: number };
type ArchiveOptions = {
  removeSource?: boolean;
  onProgress?: (progress: Progress) => void | Promise<void>;
  supplementalJson?: Awaited<ReturnType<ManifestFns["loadSupplementalJsonArchive"]>>;
};
type ImportArchiveDependencies = Pick<ManifestFns,
  "openZip64Archive" | "assertArchiveLimits" | "cleanRelative" | "decodeZipEntryPath" |
  "isMacMetadataEntry" | "loadArchiveManifests" | "loadArchiveTaskManifest" |
  "markSupplementableJsonError" | "buildArchiveImageReferenceRecords" |
  "validateTaskManifest" | "assertTaskManifestValid" | "loadImageCatalogIndex" |
  "allocateSubjectStorageRoot" | "catalogEntryForImage" | "isInfographicPath" |
  "decompressionLimit" | "catalogPrompt" | "buildTaskTemplateRecords"
> & Pick<WritesFns,
  "bulkInsertImageRecords" | "bulkInsertSubjectTaskTemplates" |
  "refreshSubjectTaskTemplateStats" | "bulkInsertSubjectTaskTemplateItems"
> & {
  nowIso: () => string;
  archiveImportError: (status: number, message: string, cause?: unknown) => Error;
  imageExts: Set<string>;
  uploadDir: string;
  maxImageUncompressedBytes: number;
  imageImportConcurrency: number;
  insertSubjectStmt: ReturnType<typeof database.prepare>;
  updateSubjectCountsStmt: ReturnType<typeof database.prepare>;
  scheduleImportedThumbnailJobs: ReturnType<typeof createThumbnailImportScheduler>;
  selectSubjectByIdStmt: ReturnType<typeof database.prepare>;
  subjectDto: typeof formatSubject;
  markSubjectImportFailedStmt: ReturnType<typeof database.prepare>;
  db: typeof database;
  normalizeArchiveImportError: (error: unknown) => Error;
};

function archiveError(error: unknown): Error & { code?: string; isArchiveImportError?: boolean } | null {
  return error instanceof Error ? error as Error & { code?: string; isArchiveImportError?: boolean } : null;
}

export async function importZipArchive(
  zipPath: string,
  originalFilename: string,
  { removeSource = true, onProgress, supplementalJson }: ArchiveOptions = {},
  dependencies: ImportArchiveDependencies,
) {
  const {
    nowIso, openZip64Archive, assertArchiveLimits, archiveImportError,
    cleanRelative, decodeZipEntryPath, isMacMetadataEntry, imageExts,
    loadArchiveManifests, loadArchiveTaskManifest, markSupplementableJsonError,
    buildArchiveImageReferenceRecords, validateTaskManifest, assertTaskManifestValid,
    loadImageCatalogIndex, allocateSubjectStorageRoot, uploadDir,
    catalogEntryForImage, isInfographicPath, decompressionLimit,
    maxImageUncompressedBytes, catalogPrompt, imageImportConcurrency,
    buildTaskTemplateRecords, insertSubjectStmt, bulkInsertImageRecords,
    bulkInsertSubjectTaskTemplates, refreshSubjectTaskTemplateStats,
    bulkInsertSubjectTaskTemplateItems, updateSubjectCountsStmt,
    scheduleImportedThumbnailJobs, selectSubjectByIdStmt, subjectDto,
    markSubjectImportFailedStmt, db, normalizeArchiveImportError,
  } = dependencies;
  const batch = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const subjectId = crypto.randomUUID();
  const subjectName =
    path.basename(originalFilename, path.extname(originalFilename)) ||
    originalFilename;
  const createdAt = nowIso();
  let subjectDir: string | undefined;
  let subjectCreated = false;
  let zip: Awaited<ReturnType<ManifestFns["openZip64Archive"]>> | undefined;

  try {
    try {
      zip = await openZip64Archive(zipPath);
      await assertArchiveLimits(zip, zipPath);
    } catch (error) {
      if (archiveError(error)?.isArchiveImportError) throw error;
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

    let archiveManifests;
    let archiveTaskManifest;
    try {
      archiveManifests = supplementalJson?.manifestProvided
        ? supplementalJson.archiveManifests
        : await loadArchiveManifests(zip);
      archiveTaskManifest = supplementalJson?.taskManifestProvided
        ? supplementalJson.archiveTaskManifest
        : await loadArchiveTaskManifest(zip);
    } catch (error) {
      throw markSupplementableJsonError(error);
    }
    try {
      // Validate task references against the ZIP directory before extracting
      // images. Invalid JSON should not spend time writing images or thumbnails.
      const archiveImageRecords = buildArchiveImageReferenceRecords(imageEntries);
      const validation = validateTaskManifest(archiveTaskManifest, archiveImageRecords);
      assertTaskManifestValid(validation.failedTasks);
    } catch (error) {
      throw markSupplementableJsonError(error);
    }
    await onProgress?.({ stage: "正在校验 JSON", progress: 5, current: 1, total: 1 });
    const catalogIndex = await loadImageCatalogIndex(archiveManifests);
    const storageRoot = await allocateSubjectStorageRoot(
      subjectName,
      subjectId,
    );
    subjectDir = path.join(uploadDir, storageRoot);
    let imported = 0;
    let skipped = 0;
    let catalogMatched = 0;
    const directories = new Set<string>();
    const imageRecords: ImageRows = [];
    const seenOriginalPaths = new Set<string>();

    await fs.mkdir(subjectDir, { recursive: true });

    const processImageEntry = async (entry: (typeof imageEntries)[number]) => {
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
      const storedPath = uploadFilePath(uploadDir, storagePath);

      try {
        await fs.mkdir(path.dirname(storedPath), { recursive: true });
        await pipeline(
          entry.stream(),
          decompressionLimit(maxImageUncompressedBytes, relative),
          createWriteStream(storedPath),
        );
      } catch (error) {
        await fs.unlink(storedPath).catch(() => {});
        if (
          archiveError(error)?.code === "ENOSPC" ||
          archiveError(error)?.code === "EACCES" ||
          archiveError(error)?.code === "EPERM"
        ) {
          throw archiveImportError(
            500,
            `保存图片“${relative}”时失败，请检查服务器上传目录`,
            error,
          );
        }
        return { skipped: 1 };
      }
      return { record: {
        id: imageId,
        subjectId,
        filename: path.basename(relative),
        originalPath: relative,
        storagePath,
        thumbnailPath: null,
        mimeType:
          ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : `image/${ext.slice(1)}`,
        category,
        directory,
        isInfographic,
        prompt: catalogPrompt(catalogEntry ?? null),
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
          .map((entry) => processImageEntry(entry)),
      );
      const results = settledResults.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      for (const result of results) {
        skipped += result?.skipped || 0;
        if (!result?.record) continue;
        imageRecords.push(result.record);
        if (result.directory) directories.add(result.record.directory);
        catalogMatched += result.catalogMatched ? 1 : 0;
        imported++;
      }
      await onProgress?.({
        stage: "正在解压图片",
        progress: 5 + Math.round((Math.min(start + imageImportConcurrency, imageEntries.length) / imageEntries.length) * 80),
        current: Math.min(start + imageImportConcurrency, imageEntries.length),
        total: imageEntries.length,
      });
    }

    if (!imported) {
      throw archiveImportError(422, "压缩包中的图片均无法导入");
    }

    let taskTemplateResult;
    try {
      taskTemplateResult = buildTaskTemplateRecords(
        subjectId,
        archiveTaskManifest,
        imageRecords,
        createdAt,
      );
    } catch (error) {
      throw markSupplementableJsonError(error);
    }
    const { taskTemplates, failedTasks } = taskTemplateResult;
    try {
      assertTaskManifestValid(failedTasks);
    } catch (error) {
      throw markSupplementableJsonError(error);
    }
    await onProgress?.({ stage: "正在准备数据库写入", progress: 90, current: 1, total: 1 });

    // Publish through the existing subject status instead of holding one large
    // transaction across every image, template, relation and index update.
    // In-progress subjects stay hidden from normal package listings.
    await insertSubjectStmt.run({
      id: subjectId,
      name: subjectName,
      originalFilename,
      importBatch: batch,
      storageRoot,
      // The uploaded archive is only an import transport. Keeping another
      // copy under the subject directory doubles storage use and no runtime
      // feature reads it after a successful import.
      sourceZipPath: null,
      createdAt,
      updatedAt: createdAt,
    });
    subjectCreated = true;
    await bulkInsertImageRecords(imageRecords, async ({ current, total }) => {
      await onProgress?.({
        stage: "正在分批写入图片数据",
        progress: 90 + Math.round((current / total) * 3),
        current,
        total,
      });
    });
    await bulkInsertSubjectTaskTemplates(taskTemplates, async ({ current, total }) => {
      await onProgress?.({
        stage: "正在分批写入任务模板",
        progress: 93 + Math.round((current / total) * 3),
        current,
        total,
      });
    });
    await refreshSubjectTaskTemplateStats(subjectId, createdAt);
    await bulkInsertSubjectTaskTemplateItems(taskTemplates, async ({ current, total }) => {
      await onProgress?.({
        stage: "正在分批写入模板图片关系",
        progress: 96 + Math.round((current / total) * 3),
        current,
        total,
      });
    });

    const updatedAt = nowIso();
    await onProgress?.({ stage: "正在发布图包", progress: 99, current: 1, total: 1 });
    await updateSubjectCountsStmt.run({
      id: subjectId,
      imageCount: imported,
      categoryCount: directories.size,
      status: "imported",
      updatedAt,
    });
    scheduleImportedThumbnailJobs(
      imageRecords.map(({ id }) => ({ id })),
      createdAt,
      subjectId,
    );
    const subject = await selectSubjectByIdStmt.get(subjectId);
    return {
      subject: subjectDto(subject as Parameters<typeof formatSubject>[0]),
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
    if (subjectCreated) {
      try {
        await markSubjectImportFailedStmt.run({
          id: subjectId,
          updatedAt: nowIso(),
        });
      } catch (markFailedError) {
        console.error("Failed to mark ZIP import as failed", markFailedError);
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
