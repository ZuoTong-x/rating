import { readOperationalLogs } from "../operational-logger.ts";

type LogQuery = Partial<Record<"page" | "pageSize" | "level" | "source" | "code" | "search" | "startTime" | "endTime", string | number | null>>;

export function createAdminLogService({ logDir }: { logDir: string }) {
  async function listLogs(query: LogQuery = {}) {
    return readOperationalLogs({
      logDir,
      page: query.page == null ? undefined : Number(query.page),
      pageSize: query.pageSize == null ? undefined : Number(query.pageSize),
      level: String(query.level || "").trim(),
      source: String(query.source || "").trim(),
      code: String(query.code || "").trim(),
      search: String(query.search || "").trim(),
      startTime: String(query.startTime || "").trim(),
      endTime: String(query.endTime || "").trim(),
    });
  }

  return { listLogs };
}
