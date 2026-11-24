type ImageRow = {
  _id: string;
  subjectId?: string;
  filename: string;
  originalPath?: string | null;
  category?: string | null;
  directory?: string | null;
  isInfographic?: boolean | null;
  prompt?: string | null;
  storagePath?: string | null;
  thumbnailPath?: string | null;
};

type SubjectRow = {
  _id: string;
  name: string;
  originalFilename?: string | null;
  importBatch?: string | null;
  imageCount?: number | null;
  categoryCount?: number | null;
  taskTemplateCount?: number | null;
  status?: string | null;
  taskStatus?: string | null;
  deletionRequestedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type TeamRow = {
  id: string;
  name: string;
  status?: string | null;
  userCount?: number | null;
  projectCount?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export function imageAssetUrl(storagePath: string | null | undefined): string | null {
  return storagePath ? `/files/${storagePath}` : null;
}

export function imageListDto(row: ImageRow) {
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

export function taskImageDto(row: ImageRow) {
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

export function taskListImageDto(row: ImageRow) {
  return {
    _id: row._id,
    filename: row.filename,
    imageUrl: imageAssetUrl(row.storagePath),
    thumbnailUrl: imageAssetUrl(row.thumbnailPath),
  };
}

export function subjectDto(row: SubjectRow | null | undefined) {
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

export function teamDto(row: TeamRow | null | undefined) {
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
