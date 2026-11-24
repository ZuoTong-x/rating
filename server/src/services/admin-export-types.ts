export type AdminExportQuery = Record<string, unknown>;

export type AdminExportConfig = {
  type: string;
  query: AdminExportQuery;
  fallbackName: string;
  title: string;
  extension: string;
  contentType: string;
  stage: string;
};

export type AdminExportJob = {
  jobId: string;
  type: string;
  query: AdminExportQuery;
  filename: string;
  contentType: string;
  extension: string;
  filePath: string;
  status: string;
  stage: string;
  progress: number;
  message: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type AdminExportProgress = { stage?: string; progress?: number };
