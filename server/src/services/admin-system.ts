import fs from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import type { db as database } from "../postgres.ts";

type ActiveRequest = {
  id: number;
  method: string;
  path: string;
  startedAt: number;
  startedAtEpoch: number;
};
type CompletedRequest = {
  method: string;
  path: string;
  durationMs: number;
  statusCode: number;
  finishedAt: number;
};
type GroupedRequest = {
  method: string;
  path: string;
  requestCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  errorCount: number;
};

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function normalizedRequestPath(req: Request) {
  const routePath = req.route?.path;
  if (typeof routePath === "string") return `${req.baseUrl || ""}${routePath}`;
  return String(req.path || "/")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/:id");
}

export function createApiActivityTracker({ windowMs = 60_000, maxSamples = 2_000 } = {}) {
  const active = new Map<number, ActiveRequest>();
  const completed: CompletedRequest[] = [];
  let nextId = 1;

  function prune(now = Date.now()) {
    const cutoff = now - windowMs;
    while (completed.length && completed[0].finishedAt < cutoff) completed.shift();
    if (completed.length > maxSamples) completed.splice(0, completed.length - maxSamples);
  }

  function middleware(req: Request, res: Response, next: NextFunction) {
    if (!req.path?.startsWith("/api/") || req.path === "/api/admin/system/status") {
      next();
      return;
    }
    const id = nextId++;
    const startedAt = performance.now();
    const item = {
      id,
      method: req.method,
      path: normalizedRequestPath(req),
      startedAt,
      startedAtEpoch: Date.now(),
    };
    active.set(id, item);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      active.delete(id);
      const finishedAt = Date.now();
      completed.push({
        method: item.method,
        path: normalizedRequestPath(req),
        durationMs: Math.max(0, performance.now() - startedAt),
        statusCode: res.statusCode,
        finishedAt,
      });
      prune(finishedAt);
    };
    res.once("finish", finish);
    res.once("close", finish);
    next();
  }

  function snapshot() {
    const now = Date.now();
    prune(now);
    const grouped = new Map<string, GroupedRequest>();
    for (const sample of completed) {
      const key = `${sample.method} ${sample.path}`;
      const current = grouped.get(key) || {
        method: sample.method,
        path: sample.path,
        requestCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        errorCount: 0,
      };
      current.requestCount += 1;
      current.totalDurationMs += sample.durationMs;
      current.maxDurationMs = Math.max(current.maxDurationMs, sample.durationMs);
      if (sample.statusCode >= 500) current.errorCount += 1;
      grouped.set(key, current);
    }
    const hotApis = [...grouped.values()]
      .map((item) => ({
        ...item,
        totalDurationMs: Math.round(item.totalDurationMs),
        averageDurationMs: rounded(item.totalDurationMs / item.requestCount),
        maxDurationMs: rounded(item.maxDurationMs),
      }))
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs)
      .slice(0, 5);
    const activeRequests = [...active.values()]
      .map((item) => ({
        method: item.method,
        path: item.path,
        durationMs: Math.round(performance.now() - item.startedAt),
      }))
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 5);
    return {
      windowSeconds: Math.round(windowMs / 1000),
      activeRequestCount: active.size,
      requestCount: completed.length,
      hotApis,
      activeRequests,
    };
  }

  return { middleware, snapshot };
}

function cpuSnapshot() {
  return os.cpus().reduce((totals, cpu) => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { total: totals.total + total, idle: totals.idle + times.idle };
  }, { total: 0, idle: 0 });
}

async function readText(filePath: string) {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    return null;
  }
}

async function effectiveCpuCount() {
  const cpuMax = await readText("/sys/fs/cgroup/cpu.max");
  if (cpuMax) {
    const [quotaText, periodText] = cpuMax.split(/\s+/);
    const quota = Number(quotaText);
    const period = Number(periodText);
    if (quotaText !== "max" && quota > 0 && period > 0) {
      return Math.max(0.1, quota / period);
    }
  }
  return Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
}

async function memorySnapshot() {
  const [currentText, maxText] = await Promise.all([
    readText("/sys/fs/cgroup/memory.current"),
    readText("/sys/fs/cgroup/memory.max"),
  ]);
  const current = Number(currentText);
  const maximum = Number(maxText);
  if (currentText && maxText && maxText !== "max" && current >= 0 && maximum > 0) {
    return {
      source: "cgroup",
      totalBytes: maximum,
      usedBytes: current,
      availableBytes: Math.max(0, maximum - current),
      usagePercent: clampPercent((current / maximum) * 100),
    };
  }
  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    source: "host",
    totalBytes,
    usedBytes,
    availableBytes,
    usagePercent: clampPercent((usedBytes / totalBytes) * 100),
  };
}

async function diskSnapshot(uploadDir: string) {
  try {
    const stat = await fs.statfs(uploadDir, { bigint: true });
    const totalBytes = Number(stat.blocks * stat.bsize);
    const availableBytes = Number(stat.bavail * stat.bsize);
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    return {
      path: uploadDir,
      totalBytes,
      usedBytes,
      availableBytes,
      usagePercent: totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : null,
    };
  } catch (error) {
    return {
      path: uploadDir,
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      usagePercent: null,
      error: String(error instanceof Error ? error.message : error || "磁盘状态读取失败").slice(0, 300),
    };
  }
}

export function createAdminSystemService({
  db,
  uploadDir,
  nowIso,
  apiActivity,
  getBackgroundActivity = () => [],
}: {
  db: typeof database;
  uploadDir: string;
  nowIso: () => string;
  apiActivity: ReturnType<typeof createApiActivityTracker>;
  getBackgroundActivity?: () => unknown[];
}) {
  let previousCpu = cpuSnapshot();
  let previousProcessCpu = process.cpuUsage();
  let previousProcessSampleAt = performance.now();

  async function getSystemStatus() {
    const sampledAt = performance.now();
    const currentCpu = cpuSnapshot();
    const totalDelta = currentCpu.total - previousCpu.total;
    const idleDelta = currentCpu.idle - previousCpu.idle;
    const systemCpuPercent = totalDelta > 0
      ? clampPercent(((totalDelta - idleDelta) / totalDelta) * 100)
      : null;
    previousCpu = currentCpu;

    const currentProcessCpu = process.cpuUsage();
    const processCpuMicros =
      currentProcessCpu.user - previousProcessCpu.user
      + currentProcessCpu.system - previousProcessCpu.system;
    const elapsedMicros = Math.max(1, (sampledAt - previousProcessSampleAt) * 1000);
    const cpuCount = await effectiveCpuCount();
    const processCpuPercent = clampPercent((processCpuMicros / elapsedMicros / cpuCount) * 100);
    previousProcessCpu = currentProcessCpu;
    previousProcessSampleAt = sampledAt;

    const databaseStartedAt = performance.now();
    let database;
    try {
      await db.prepare("SELECT 1 AS ok").get();
      database = {
        status: "healthy",
        latencyMs: Math.round((performance.now() - databaseStartedAt) * 10) / 10,
      };
    } catch (error) {
      database = {
        status: "unavailable",
        latencyMs: null,
        error: String(error instanceof Error ? error.message : error || "数据库连接失败").slice(0, 300),
      };
    }

    const [memory, disk] = await Promise.all([
      memorySnapshot(),
      diskSnapshot(uploadDir),
    ]);
    const loadAverage = os.loadavg();
    const processMemory = process.memoryUsage();
    const normalizedLoadPercent = clampPercent((loadAverage[0] / cpuCount) * 100);
    const databasePressure = database.status !== "healthy"
      ? 100
      : clampPercent(Math.max(0, ((database.latencyMs || 0) - 10) / 2));
    const pressureInputs = [
      systemCpuPercent,
      normalizedLoadPercent,
      memory.usagePercent,
      databasePressure,
    ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const congestionPercent = pressureInputs.length
      ? clampPercent(
        Math.max(...pressureInputs) * 0.55
        + pressureInputs.reduce((sum, value) => sum + value, 0) / pressureInputs.length * 0.45,
      )
      : null;
    const congestionLevel = congestionPercent == null
      ? "unknown"
      : congestionPercent >= 85
        ? "critical"
        : congestionPercent >= 65
          ? "busy"
          : congestionPercent >= 40
            ? "moderate"
            : "relaxed";
    const activity = apiActivity?.snapshot?.() || {
      windowSeconds: 60,
      activeRequestCount: 0,
      requestCount: 0,
      hotApis: [],
      activeRequests: [],
    };
    return {
      status: database.status === "healthy" ? "healthy" : "degraded",
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      cpu: {
        logicalCount: os.cpus().length,
        effectiveCount: Math.round(cpuCount * 10) / 10,
        systemUsagePercent: systemCpuPercent,
        processUsagePercent: processCpuPercent,
        loadAverage1m: Math.round(loadAverage[0] * 100) / 100,
        loadAverage5m: Math.round(loadAverage[1] * 100) / 100,
        loadAverage15m: Math.round(loadAverage[2] * 100) / 100,
        normalizedLoadPercent,
      },
      memory,
      process: {
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        rssBytes: processMemory.rss,
        heapUsedBytes: processMemory.heapUsed,
        heapTotalBytes: processMemory.heapTotal,
      },
      systemUptimeSeconds: Math.floor(os.uptime()),
      disk,
      database,
      congestion: {
        percent: congestionPercent,
        level: congestionLevel,
        factors: {
          cpuPercent: systemCpuPercent,
          loadPercent: normalizedLoadPercent,
          memoryPercent: memory.usagePercent,
          databasePercent: databasePressure,
        },
      },
      activity: {
        ...activity,
        backgroundTasks: getBackgroundActivity().slice(0, 6),
      },
      sampledAt: nowIso(),
    };
  }

  return { getSystemStatus };
}
