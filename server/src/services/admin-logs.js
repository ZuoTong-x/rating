import { readOperationalLogs } from "../operational-logger.js";

export function createAdminLogService({ logDir }) {
  async function listLogs(query = {}) {
    return readOperationalLogs({
      logDir,
      page: query.page,
      pageSize: query.pageSize,
      level: String(query.level || "").trim(),
      source: String(query.source || "").trim(),
      code: String(query.code || "").trim(),
      search: String(query.search || "").trim(),
    });
  }

  return { listLogs };
}
