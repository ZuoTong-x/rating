import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import iconv from "iconv-lite";
import yauzl from "yauzl";

type ArchiveImportError = Error & {
  isArchiveImportError?: boolean;
  isSupplementableJsonError?: boolean;
  taskFailures?: TaskFailure[];
};
type ZipEntry = {
  type: "Directory" | "File";
  path: string;
  entryName?: string;
  pathBuffer: Buffer;
  flags?: number;
  isUnicode?: boolean;
  uncompressedSize: number;
  size?: number;
  vars: { uncompressedSize: number };
  stream(): PassThrough;
  buffer(): Promise<Buffer>;
};
type ZipArchive = { files: ZipEntry[]; close(): void };
type CatalogRow = Record<string, unknown>;
type Catalog = { rows: CatalogRow[] };
type CatalogIndex = Map<string, CatalogRow | null>;
type ImageReference = { id: string; filename: string; originalPath: string };
type ImageReferenceIndex = {
  pathIndex: Map<string, ImageReference | null>;
  filenameIndex: Map<string, ImageReference | null>;
};
type TaskManifest = { tasks: unknown[] };
type TaskFailure = { index: number; id: string; message: string };
type ValidatedTask = {
  sourceTaskId: string;
  criterion: string;
  imageKey: string;
  items: Array<{ image: ImageReference; position: number; role: string }>;
};
type ImportManifestDependencies = {
  archiveImportError: (status: number, message: string, cause?: unknown) => ArchiveImportError;
  imageExts: Set<string>;
  maxArchiveEntries: number;
  maxArchiveUncompressedBytes: number;
  maxZipBytes: number;
  taskCriteria: string[];
  taskTemplateRoles: Set<string>;
  uploadDir: string;
};

function archiveError(error: unknown): ArchiveImportError | null {
  return error instanceof Error ? error as ArchiveImportError : null;
}

export function createImportManifestService({
    archiveImportError, imageExts,
    maxArchiveEntries, maxArchiveUncompressedBytes, maxZipBytes,
    taskCriteria, taskTemplateRoles, uploadDir,
}: ImportManifestDependencies) {
function markSupplementableJsonError(error: unknown) {
  const known = archiveError(error);
  if (known?.isArchiveImportError) known.isSupplementableJsonError = true;
  return error;
}
function cleanRelative(value: string) {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((item) => item.replace(/[^\p{L}\p{N}._-]/gu, "_"))
    .join("/");
}

function decodeZipEntryPath(entry: ZipEntry) {
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

function normalizeCatalogPath(value: unknown) {
  return cleanRelative(String(value ?? "")).toLocaleLowerCase();
}

function normalizeCatalogFilename(value: unknown) {
  const normalized = normalizeCatalogPath(value);
  return normalized ? path.posix.basename(normalized) : "";
}

function isInfographicPath(relative: unknown) {
  const directories = cleanRelative(String(relative ?? ""))
    .split("/")
    .filter(Boolean);
  directories.pop();
  return directories.some((directory) => directory.trim() === "信息图");
}

function catalogRowForManifest(row: unknown): CatalogRow | null {
  if (!row || typeof row !== "object") return null;
  const { catalog_row: nestedCatalogRow, ...manifestRow } = row as CatalogRow;
  if (!nestedCatalogRow || typeof nestedCatalogRow !== "object") return row as CatalogRow;

  // ZIP manifest 的顶层保存来源和目标文件名，catalog_row 保存原始目录信息。
  // 合并两者，确保详情、Prompt 和文件路径都能保留下来。
  return { ...manifestRow, ...nestedCatalogRow };
}

function addCatalogRowsToIndex(index: CatalogIndex, catalog: Catalog) {
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

async function loadArchiveManifests(zip: ZipArchive): Promise<Catalog[]> {
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
    if (archiveError(error)?.isArchiveImportError) throw error;
    throw archiveImportError(422, "压缩包根目录的 manifest.json 无效", error);
  }
}

async function loadArchiveTaskManifest(zip: ZipArchive): Promise<TaskManifest | null> {
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
    if (archiveError(error)?.isArchiveImportError) throw error;
    throw archiveImportError(422, "Invalid root tasks.json", error);
  }
}

async function loadSupplementalJsonArchive(zipPath: string) {
  let zip: ZipArchive | undefined;
  try {
    zip = await openZip64Archive(zipPath);
    await assertArchiveLimits(zip, zipPath);
    const imageEntry = zip.files.find((entry) => {
      if (entry.type === "Directory") return false;
      const relative = cleanRelative(decodeZipEntryPath(entry));
      return Boolean(relative) && imageExts.has(path.extname(relative).toLowerCase());
    });
    if (imageEntry) {
      throw archiveImportError(422, "补充 JSON 压缩包不能包含图片文件");
    }

    let archiveManifests;
    let archiveTaskManifest;
    try {
      archiveManifests = await loadArchiveManifests(zip);
      archiveTaskManifest = await loadArchiveTaskManifest(zip);
    } catch (error) {
      throw markSupplementableJsonError(error);
    }
    if (!archiveManifests.length && !archiveTaskManifest) {
      throw archiveImportError(422, "补充 JSON 压缩包中未找到 manifest.json 或 tasks.json");
    }
    return {
      manifestProvided: archiveManifests.length > 0,
      archiveManifests,
      taskManifestProvided: Boolean(archiveTaskManifest),
      archiveTaskManifest,
    };
  } catch (error) {
    if (archiveError(error)?.isArchiveImportError) throw markSupplementableJsonError(error);
    throw markSupplementableJsonError(
      archiveImportError(422, "无法读取补充 JSON 压缩包，请确认文件完整", error),
    );
  } finally {
    zip?.close();
  }
}

async function loadImageCatalogIndex(archiveManifests: Catalog[] = []) {
  const index: CatalogIndex = new Map();
  for (const manifest of archiveManifests) {
    addCatalogRowsToIndex(index, manifest);
  }

  return index;
}

function catalogEntryForImage(catalogIndex: CatalogIndex, rawRelative: string, relative: string) {
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

function addTaskReference(index: Map<string, ImageReference | null>, key: string, image: ImageReference) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, image);
    return;
  }
  if (index.get(key)?.id !== image.id) index.set(key, null);
}

function buildTaskImageReferenceIndex(imageRecords: ImageReference[]): ImageReferenceIndex {
  const pathIndex = new Map<string, ImageReference | null>();
  const filenameIndex = new Map<string, ImageReference | null>();
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

function taskImageReference(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return (
      item.src_rel_path ??
      item.originalPath ??
      item.path ??
      item.filename ??
      item.image
    );
  }
  return "";
}

function resolveTaskImage(imageReferenceIndex: ImageReferenceIndex, reference: unknown) {
  const normalizedPath = normalizeCatalogPath(reference);
  if (imageReferenceIndex.pathIndex.has(normalizedPath)) {
    return imageReferenceIndex.pathIndex.get(normalizedPath);
  }

  const normalizedFilename = normalizeCatalogFilename(reference);
  return imageReferenceIndex.filenameIndex.get(normalizedFilename);
}

function buildArchiveImageReferenceRecords(imageEntries: ZipEntry[]): ImageReference[] {
  const records: ImageReference[] = [];
  const seenPaths = new Set<string>();
  for (const entry of imageEntries) {
    const relative = cleanRelative(decodeZipEntryPath(entry));
    if (
      !relative ||
      isMacMetadataEntry(relative) ||
      !imageExts.has(path.extname(relative).toLowerCase()) ||
      seenPaths.has(relative)
    ) {
      continue;
    }
    seenPaths.add(relative);
    records.push({
      id: relative,
      filename: path.posix.basename(relative),
      originalPath: relative,
    });
  }
  return records;
}

function taskItemRole(value: unknown) {
  const role = String(value && typeof value === "object" ? (value as Record<string, unknown>).role ?? "target" : "target");
  if (!taskTemplateRoles.has(role)) {
    throw archiveImportError(422, `Unsupported task item role: ${role}`);
  }
  return role;
}

function validateTaskManifest(taskManifest: TaskManifest | null, imageRecords: ImageReference[]) {
  if (!taskManifest) return { validatedTasks: [], failedTasks: [] };
  if (!taskManifest.tasks.length) {
    throw archiveImportError(422, "tasks.json does not contain any tasks");
  }

  const imageReferenceIndex = buildTaskImageReferenceIndex(imageRecords);
  const sourceTaskIds = new Set<string>();
  const taskKeys = new Set<string>();
  const failedTasks: TaskFailure[] = [];

  const validatedTasks = taskManifest.tasks.map((rawTask, index) => {
    try {
      if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) {
        throw archiveImportError(422, `tasks[${index}] must be an object`);
      }

      const task = rawTask as Record<string, unknown>;
      const sourceTaskId = String(task.id ?? `task-${index + 1}`).trim();
      if (!sourceTaskId || sourceTaskId.length > 160 || sourceTaskIds.has(sourceTaskId)) {
        throw archiveImportError(422, `tasks[${index}] has an invalid or duplicate id`);
      }
      sourceTaskIds.add(sourceTaskId);

      const criterion = String(task.criterion ?? "").trim();
      if (!taskCriteria.includes(criterion)) {
        throw archiveImportError(422, `tasks[${index}].criterion is not supported`);
      }

      if (!Array.isArray(task.images) || task.images.length < 1 || task.images.length > 5) {
        throw archiveImportError(422, `tasks[${index}].images must contain 1 to 5 images`);
      }
      if (criterion === "saturation" && task.images.length !== 2) {
        throw archiveImportError(422, `tasks[${index}].images must contain exactly 2 images for saturation`);
      }

      const usedImageIds = new Set<string>();
      const items = task.images.map((rawItem: unknown, itemIndex: number) => {
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
          image,
          position: itemIndex,
          role: taskItemRole(rawItem),
        };
      });
      const imageKey = items.map((item) => item.image.id).sort().join("|");
      const taskKey = `${criterion}|${imageKey}`;
      if (taskKeys.has(taskKey)) {
        throw archiveImportError(422, `tasks[${index}] duplicates another task group`);
      }
      taskKeys.add(taskKey);

      return {
        sourceTaskId,
        criterion,
        imageKey,
        items,
      };
    } catch (error) {
      const sourceTaskId = rawTask && typeof rawTask === "object" ? (rawTask as Record<string, unknown>).id ?? `task-${index + 1}` : `task-${index + 1}`;
      const message = archiveError(error)?.message || String(error);
      failedTasks.push({
        index,
        id: String(sourceTaskId),
        message,
      });
      console.warn(`Skipping invalid task ${index} (${sourceTaskId}): ${message}`);
      return null;
    }
  }).filter((task): task is ValidatedTask => task !== null);

  return { validatedTasks, failedTasks };
}

function buildTaskTemplateRecords(subjectId: string, taskManifest: TaskManifest | null, imageRecords: ImageReference[], createdAt: string) {
  const validation = validateTaskManifest(taskManifest, imageRecords);
  if (!taskManifest) return { taskTemplates: [], failedTasks: [] };
  const taskTemplates = validation.validatedTasks.map((task) => ({
    id: crypto.randomUUID(),
    subjectId,
    sourceTaskId: task.sourceTaskId,
    round: 1,
    criterion: task.criterion,
    imageKey: task.imageKey,
    selectionKey: crypto.randomInt(1, 2147483647),
    createdAt,
    items: task.items.map((item) => ({
      imageId: item.image.id,
      position: item.position,
      role: item.role,
    })),
  }));

  return {
    taskTemplates,
    failedTasks: validation.failedTasks,
  };
}

function assertTaskManifestValid(failedTasks: TaskFailure[]) {
  if (!failedTasks.length) return;
  const taskError = archiveImportError(
    422,
    `tasks.json 中有 ${failedTasks.length} 条任务校验失败，首条错误：${failedTasks[0].message}；请修正后补充上传`,
  );
  taskError.taskFailures = failedTasks;
  throw taskError;
}

function catalogPrompt(entry: CatalogRow | null) {
  const prompt = entry?.actual_input_prompt ?? entry?.prompt;
  const text = typeof prompt === "string" ? prompt.trim() : "";
  return text || null;
}

function parseCatalogData(value: string | null) {
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

function cleanFolderName(value: unknown, fallback = "upload") {
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

function detectArchiveRoot(entries: ZipEntry[]) {
  const roots = new Set<string>();
  let hasNestedImage = false;

  for (const entry of entries) {
    const relative = cleanRelative(
      decodeZipEntryPath(entry) || entry.entryName || "",
    );
    if (!relative) continue;
    const parts = relative.split("/");
    roots.add(parts[0]);
    if (parts.length > 1) hasNestedImage = true;
  }

  return roots.size === 1 && hasNestedImage ? [...roots][0] : null;
}

function stripArchiveRoot(relative: string, root: string | null) {
  if (!root) return relative;
  const parts = relative.split("/");
  return parts[0] === root ? parts.slice(1).join("/") : relative;
}

function archiveEntryUncompressedSize(entry: ZipEntry) {
  const size = Number(
    entry?.uncompressedSize ??
      entry?.vars?.uncompressedSize ??
      entry?.size ??
      0,
  );
  return Number.isFinite(size) && size > 0 ? size : 0;
}

async function assertArchiveLimits(zip: ZipArchive, zipPath: string) {
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

function decompressionLimit(maxBytes: number, relative: string) {
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

function openZip64Archive(zipPath: string): Promise<ZipArchive> {
  return new Promise<ZipArchive>((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, decodeStrings: false, autoClose: false },
      (error, archive) => {
      if (error) {
        reject(error);
        return;
      }
      const entries: ZipEntry[] = [];
      archive.on("entry", (rawEntry) => {
        const pathBuffer = Buffer.isBuffer(rawEntry.fileName)
          ? rawEntry.fileName
          : Buffer.from(rawEntry.fileName);
        const entry: ZipEntry = {
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
            const chunks: Buffer[] = [];
            for await (const chunk of entry.stream()) chunks.push(Buffer.from(chunk));
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

function isMacMetadataEntry(relative: string) {
  if (!relative) return true;
  if (relative === ".DS_Store" || relative.endsWith("/.DS_Store")) return true;
  return relative
    .split("/")
    .some((segment) => segment === "__MACOSX" || segment.startsWith("._"));
}

async function allocateSubjectStorageRoot(subjectName: string, subjectId: string) {
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

  return { cleanRelative, decodeZipEntryPath, normalizeCatalogPath, normalizeCatalogFilename, isInfographicPath, catalogRowForManifest, addCatalogRowsToIndex, loadArchiveManifests, loadArchiveTaskManifest, loadSupplementalJsonArchive, loadImageCatalogIndex, catalogEntryForImage, addTaskReference, buildTaskImageReferenceIndex, taskImageReference, resolveTaskImage, buildArchiveImageReferenceRecords, taskItemRole, validateTaskManifest, buildTaskTemplateRecords, assertTaskManifestValid, catalogPrompt, parseCatalogData, cleanFolderName, detectArchiveRoot, stripArchiveRoot, archiveEntryUncompressedSize, assertArchiveLimits, decompressionLimit, openZip64Archive, isMacMetadataEntry, allocateSubjectStorageRoot, markSupplementableJsonError };
}
