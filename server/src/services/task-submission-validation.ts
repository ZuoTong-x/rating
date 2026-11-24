type RiskInput = {
  durationMs: number;
  rankingActionCount: number;
  dragActionCount: number;
  orderChanged: boolean;
  largeImageOpened: boolean;
  largeImageOpenCount: number;
  firstActionMs: number | null;
  pageBlurCount: number;
};

export function createTaskSubmissionValidation({
  httpError, taskExclusionCriteria, taskCorrectnessCriteria,
}: {
  httpError: (status: number, message: string) => Error;
  taskExclusionCriteria: Set<string>;
  taskCorrectnessCriteria: Set<string>;
}) {
function parseTaskExcludedImageIds(value: unknown, taskImageIds: string[], taskType: string) {
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
  value: unknown,
  taskImageIds: string[],
  taskType: string,
  excludedImageIds: string[] = [],
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
  value: unknown,
  taskImageIds: string[],
  excludedImageIds: string[] = [],
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

function parseTaskRankingRelations(value: unknown, ranking: string[]) {
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

function parseTaskDuration(value: unknown) {
  const durationMs = Math.round(Number(value));
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw httpError(400, "打分时长不正确");
  return Math.min(durationMs, 24 * 60 * 60 * 1000);
}

function parseRankingActionCount(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count < 0)
    throw httpError(400, "排序操作次数不正确");
  return Math.min(count, 100000);
}

function parseLargeImageOpened(value: unknown) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  throw httpError(400, "大图查看记录格式不正确");
}

function parseTaskBehaviorCount(value: unknown, label: string, fallback = 0, max = 100000) {
  if (value === null || value === undefined || value === "") return fallback;
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count) || count < 0) throw httpError(400, `${label}不正确`);
  return Math.min(count, max);
}

function parseTaskBehaviorBoolean(value: unknown, label: string, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  throw httpError(400, `${label}格式不正确`);
}

function parseTaskClaimToken(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const token = String(value).trim();
  if (!token) return null;
  if (token.length > 256) throw httpError(400, "任务占用令牌不正确");
  return token;
}

function parseFirstActionMs(value: unknown, durationMs: number) {
  if (value === null || value === undefined || value === "") return null;
  const firstActionMs = Math.floor(Number(value));
  if (!Number.isFinite(firstActionMs) || firstActionMs < 0)
    throw httpError(400, "首次操作时间不正确");
  return Math.min(firstActionMs, durationMs);
}

function hasTaskBehaviorTracking(body: Record<string, unknown> = {}) {
  return [
    "dragActionCount",
    "orderChanged",
    "largeImageOpenCount",
    "firstActionMs",
    "pageBlurCount",
  ].some((key) => Object.hasOwn(body, key));
}

function calculateTaskRisk({
  durationMs,
  rankingActionCount,
  dragActionCount,
  orderChanged,
  largeImageOpened,
  largeImageOpenCount,
  firstActionMs,
  pageBlurCount,
}: RiskInput) {
  let score = 0;
  const flags: string[] = [];
  if (!orderChanged && rankingActionCount <= 0 && dragActionCount <= 0) {
    score += 20;
    flags.push("no_order_change");
  }
  if (!largeImageOpened && largeImageOpenCount <= 0) {
    score += 10;
    flags.push("no_large_image");
  }
  if (durationMs < 3000) {
    score += 30;
    flags.push("fast_submit");
  }
  if (firstActionMs === null || (durationMs >= 1000 && firstActionMs > durationMs * 0.8)) {
    score += 5;
    flags.push("late_first_action");
  }
  if (pageBlurCount >= 3) {
    score += 10;
    flags.push("frequent_page_blur");
  }
  return {
    score: Math.min(score, 100),
    flags,
  };
}

function parseTaskSubmissionMode(value: unknown, rankingActionCount: number, trackingProvided = false) {
  const requested = String(value || "").trim();
  if (requested && !["direct", "ranked"].includes(requested)) {
    throw httpError(400, "提交方式不正确");
  }
  if (rankingActionCount > 0) return "ranked";
  if (requested) return requested;
  return trackingProvided ? "direct" : null;
}

  return { parseTaskExcludedImageIds, parseTaskCorrectImageIds, parseTaskRanking, parseTaskRankingRelations, parseTaskDuration, parseRankingActionCount, parseLargeImageOpened, parseTaskBehaviorCount, parseTaskBehaviorBoolean, parseTaskClaimToken, parseFirstActionMs, hasTaskBehaviorTracking, calculateTaskRisk, parseTaskSubmissionMode };
}
