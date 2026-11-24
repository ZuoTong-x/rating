import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import type { Request } from "express";

type LogInput = {
  level?: string;
  kind?: string;
  message?: string;
  code?: string | null;
  status?: number | null;
  api?: unknown;
  metadata?: unknown;
  error?: unknown;
};
type LogEntry = {
  timestamp: string;
  level: string;
  source: string;
  code?: string | null;
  message?: string;
  api?: unknown;
  metadata?: unknown;
};
type ErrorDetails = {
  name?: string;
  message?: string;
  stack?: string;
  code?: string;
  cause?: { code?: string };
  severity?: string;
  detail?: string;
  hint?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;
};

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_READ_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4000;

const API_DESCRIPTIONS: Array<[RegExp, string]> = [
  [/^GET \/api\/admin\/dashboard(?:\/|$)/, "读取管理端仪表盘数据"],
  [/^GET \/api\/admin\/system\/status$/, "读取服务器负载和运行状态"],
  [/^GET \/api\/admin\/logs$/, "查询线上结构化错误日志"],
  [/^GET \/api\/admin\/thumbnails$/, "读取缩略图任务流状态"],
  [/^PATCH \/api\/admin\/thumbnails\/settings$/, "更新缩略图全局调度策略"],
  [/^PATCH \/api\/admin\/thumbnails\/packages\//, "调整图包缩略图生成策略"],
  [/^POST \/api\/admin\/thumbnails\//, "重试缩略图失败任务"],
  [/^POST \/api\/admin\/exports$/, "创建管理端数据导出任务"],
  [/^GET \/api\/admin\/exports\//, "查询或下载管理端导出结果"],
  [/^GET \/api\/admin\/scoring(?:\/|$)/, "读取打分质量和记录数据"],
  [/^POST \/api\/admin\/scoring(?:\/|$)/, "执行打分管理操作"],
  [/^GET \/api\/projects(?:\/|$)/, "读取项目及任务统计"],
  [/^(POST|PUT|PATCH|DELETE) \/api\/projects(?:\/|$)/, "修改项目配置或任务分配"],
  [/^GET \/api\/subjects(?:\/|$)/, "读取图包或图片数据"],
  [/^(POST|PUT|PATCH|DELETE) \/api\/subjects(?:\/|$)/, "修改图包、图片或生成任务"],
  [/^GET \/api\/tasks(?:\/|$)/, "读取评分任务"],
  [/^(POST|PUT|PATCH) \/api\/tasks(?:\/|$)/, "领取、提交或调整评分任务"],
  [/^GET \/api\/(users|teams)(?:\/|$)/, "读取账号或团队数据"],
  [/^(POST|PUT|PATCH|DELETE) \/api\/(users|teams)(?:\/|$)/, "修改账号或团队数据"],
  [/^POST \/api\/import(?:\/|$)/, "上传或导入图片数据"],
  [/^GET \/api\/feedbacks(?:\/|$)/, "读取问题反馈"],
  [/^(POST|PUT|PATCH) \/api\/feedbacks(?:\/|$)/, "提交或处理问题反馈"],
  [/^POST \/api\/auth\/login$/, "管理员或打分人登录"],
  [/^GET \/api\/auth\/session$/, "检查当前登录会话"],
];

function compactText(value: unknown, maximum = MAX_TEXT_LENGTH) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function safeSource(value: unknown) {
  return String(value || "api").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "api";
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return compactText(value, 1000);
  if (depth >= 3) return "[内容过深，已省略]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (/password|passwd|secret|token|cookie|authorization|session/i.test(key)) {
        result[key] = "[已脱敏]";
      } else {
        result[key] = sanitizeValue(item, depth + 1);
      }
    }
    return result;
  }
  return compactText(value);
}

export function serializeOperationalError(error: unknown) {
  if (!error) return null;
  const details = error as ErrorDetails;
  return sanitizeValue({
    name: details.name || "Error",
    message: details.message || String(error),
    stack: details.stack || null,
    code: details.code || details.cause?.code || null,
    severity: details.severity || null,
    detail: details.detail || null,
    hint: details.hint || null,
    schema: details.schema || null,
    table: details.table || null,
    column: details.column || null,
    constraint: details.constraint || null,
    file: details.file || null,
    line: details.line || null,
    routine: details.routine || null,
  });
}

export function normalizeApiPath(req: Request) {
  const route = typeof req.route?.path === "string" ? `${req.baseUrl || ""}${req.route.path}` : null;
  return compactText(route || String(req.originalUrl || req.path || "/").split("?")[0], 500)
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/:id");
}

export function describeApi(method: string, apiPath: string) {
  const signature = `${String(method || "GET").toUpperCase()} ${apiPath || "/"}`;
  return API_DESCRIPTIONS.find(([pattern]) => pattern.test(signature))?.[1] || "未分类 API 请求";
}

export function requestLogMetadata(req: Request) {
  const apiPath = normalizeApiPath(req);
  const params: Record<string, string> = {};
  const requestContext = req as Request & { requestId?: string; auth?: { username?: string; role?: string } };
  for (const key of ["id", "subjectId", "projectId", "jobId", "uploadId", "imageId"]) {
    if (req.params?.[key] != null) params[key] = compactText(req.params[key], 120);
  }
  return {
    requestId: requestContext.requestId || null,
    method: req.method,
    path: apiPath,
    description: describeApi(req.method, apiPath),
    actor: requestContext.auth ? { username: requestContext.auth.username, role: requestContext.auth.role } : null,
    params,
  };
}

function logDate(timestamp: string) {
  return timestamp.slice(0, 10);
}

async function readFileTail(filePath: string, maximumBytes: number) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maximumBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return text;
  } finally {
    await handle.close();
  }
}

export function createOperationalLogger({
  source,
  logDir = process.env.LOG_DIR || "logs",
  retentionDays = Number.parseInt(process.env.LOG_RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10),
}: { source?: string; logDir?: string; retentionDays?: number } = {}) {
  const normalizedSource = safeSource(source);
  const directory = path.resolve(logDir);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  let writeChain = Promise.resolve();
  let lastCleanupAt = 0;

  async function cleanup() {
    if (Date.now() - lastCleanupAt < 60 * 60 * 1000) return;
    lastCleanupAt = Date.now();
    const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
    const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(files
      .filter((entry) => entry.isFile() && /^operational-[a-z0-9_-]+-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
      .map(async (entry) => {
        const match = entry.name.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (match && new Date(`${match[1]}T00:00:00.000Z`).getTime() < cutoff) {
          await fs.unlink(path.join(directory, entry.name)).catch(() => {});
        }
      }));
  }

  function write(entry: LogInput) {
    const timestamp = new Date().toISOString();
    const payload = sanitizeValue({
      id: crypto.randomUUID(),
      timestamp,
      level: entry.level || "error",
      source: normalizedSource,
      kind: entry.kind || "application",
      message: compactText(entry.message || "未提供错误信息"),
      code: entry.code || (entry.error as ErrorDetails | undefined)?.code || (entry.error as ErrorDetails | undefined)?.cause?.code || null,
      status: entry.status || null,
      api: entry.api || null,
      metadata: entry.metadata || null,
      error: serializeOperationalError(entry.error),
    }) as Record<string, unknown>;
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(directory, { recursive: true });
        await cleanup();
        const filename = `operational-${normalizedSource}-${logDate(timestamp)}.jsonl`;
        await fs.appendFile(path.join(directory, filename), `${JSON.stringify(payload)}\n`, "utf8");
      })
      .catch((writeError) => originalError("Operational log write failed", writeError));
    return String(payload.id);
  }

  function formatConsoleArgs(args: unknown[]) {
    return compactText(args.map((item) => item instanceof Error
      ? item.stack || item.message
      : typeof item === "string" ? item : util.inspect(item, { depth: 3, breakLength: 160 })).join(" "));
  }

  function installConsoleCapture() {
    console.error = (...args) => {
      write({ level: "error", kind: "console", message: formatConsoleArgs(args), error: args.find((item) => item instanceof Error) });
      originalError(...args);
    };
    console.warn = (...args) => {
      write({ level: "warning", kind: "console", message: formatConsoleArgs(args), error: args.find((item) => item instanceof Error) });
      originalWarn(...args);
    };
    process.on("uncaughtExceptionMonitor", (error, origin) => {
      write({ level: "critical", kind: "process", message: `未捕获异常：${origin}`, error });
    });
    process.on("unhandledRejection", (reason) => {
      write({
        level: "critical",
        kind: "process",
        message: "未处理的 Promise rejection",
        error: reason instanceof Error ? reason : new Error(String(reason)),
      });
    });
  }

  function error(entry: LogInput, cause: unknown) {
    write({ ...entry, level: entry.level || "error", error: cause });
    originalError(entry.message || "Application error", cause || "");
  }

  return { directory, write, error, installConsoleCapture, flush: () => writeChain };
}

export async function readOperationalLogs({
  logDir = process.env.LOG_DIR || "logs",
  page = 1,
  pageSize = 50,
  level = "",
  source = "",
  code = "",
  search = "",
  startTime = "",
  endTime = "",
  maximumBytes = DEFAULT_READ_BYTES,
}: {
  logDir?: string;
  page?: number;
  pageSize?: number;
  level?: string;
  source?: string;
  code?: string;
  search?: string;
  startTime?: string;
  endTime?: string;
  maximumBytes?: number;
} = {}) {
  const directory = path.resolve(logDir);
  const startTimestamp = startTime ? Date.parse(startTime) : NaN;
  const endTimestamp = endTime ? Date.parse(endTime) : NaN;
  const files = (await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^operational-[a-z0-9_-]+-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((filename) => {
      const day = filename.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1];
      const dayStart = Date.parse(`${day}T00:00:00.000Z`);
      return (!Number.isFinite(startTimestamp) || dayStart + 24 * 60 * 60 * 1000 > startTimestamp)
        && (!Number.isFinite(endTimestamp) || dayStart < endTimestamp);
    })
    .sort()
    .reverse();
  const entries: LogEntry[] = [];
  let remainingBytes = maximumBytes;
  for (const filename of files) {
    if (remainingBytes <= 0) break;
    const filePath = path.join(directory, filename);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;
    const bytes = Math.min(stat.size, remainingBytes);
    remainingBytes -= bytes;
    const content = await readFileTail(filePath, bytes);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {}
    }
  }
  const normalizedSearch = String(search || "").trim().toLowerCase();
  const filtered = entries
    .filter((entry) => {
      if (!Number.isFinite(startTimestamp) && !Number.isFinite(endTimestamp)) return true;
      const timestamp = Date.parse(entry.timestamp);
      return Number.isFinite(timestamp)
        && (!Number.isFinite(startTimestamp) || timestamp >= startTimestamp)
        && (!Number.isFinite(endTimestamp) || timestamp < endTimestamp);
    })
    .filter((entry) => !level || entry.level === level)
    .filter((entry) => !source || entry.source === source)
    .filter((entry) => !code || String(entry.code || "").toLowerCase() === String(code).toLowerCase())
    .filter((entry) => !normalizedSearch || JSON.stringify({
      message: entry.message,
      code: entry.code,
      api: entry.api,
      metadata: entry.metadata,
    }).toLowerCase().includes(normalizedSearch))
    .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
  const safePageSize = Math.min(100, Math.max(10, Number(pageSize) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safePageSize;
  const summary = filtered.reduce((result, entry) => {
    result.byLevel[entry.level] = (result.byLevel[entry.level] || 0) + 1;
    result.bySource[entry.source] = (result.bySource[entry.source] || 0) + 1;
    if (entry.code) result.byCode[entry.code] = (result.byCode[entry.code] || 0) + 1;
    return result;
  }, {
    byLevel: {} as Record<string, number>,
    bySource: {} as Record<string, number>,
    byCode: {} as Record<string, number>,
  });
  return {
    entries: filtered.slice(offset, offset + safePageSize),
    total: filtered.length,
    page: safePage,
    pageSize: safePageSize,
    availableSources: [...new Set(entries.map((entry) => entry.source).filter(Boolean))].sort(),
    summary,
    truncated: remainingBytes <= 0,
  };
}
