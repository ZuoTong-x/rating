import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import type { db as database } from "../postgres.ts";
import { parseTaskGenerationAssignees } from "./task-generation-assignment.ts";

type Statement = ReturnType<typeof database.prepare>;
type AssignmentBody = Parameters<typeof parseTaskGenerationAssignees>[0];
type AssignmentDependencies = Parameters<typeof parseTaskGenerationAssignees>[1];
type ExactEntry = { sourceTaskId: string; scorer: string | null };

export function createTaskAssignmentInputService({
    normalizeUsername, httpError, selectScorerByUsernameStmt,
    assertScorerAssignable, parseGenerationAssignees, normalizeTeamIds,
    normalizeTeamMatchMode, parseBacktestRatio, listScorersByTeamIds,
    MAX_EXACT_TASK_ASSIGNMENTS,
}: {
  normalizeUsername: (value: unknown) => string;
  httpError: (status: number, message: string) => Error;
  selectScorerByUsernameStmt: Statement;
  assertScorerAssignable: (user: Record<string, unknown> | undefined, name: string) => Promise<void>;
  parseGenerationAssignees: typeof parseTaskGenerationAssignees;
  normalizeTeamIds: AssignmentDependencies["normalizeTeamIds"];
  normalizeTeamMatchMode: AssignmentDependencies["normalizeTeamMatchMode"];
  parseBacktestRatio: AssignmentDependencies["parseBacktestRatio"];
  listScorersByTeamIds: AssignmentDependencies["listScorersByTeamIds"];
  MAX_EXACT_TASK_ASSIGNMENTS: number;
}) {
function normalizeTaskAssigneeNames(value: unknown) {
  const rawNames = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  return [
    ...new Set(
      rawNames
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
        .map(normalizeUsername),
    ),
  ];
}

async function parseTaskAssignees(value: unknown) {
  const names = normalizeTaskAssigneeNames(value);
  if (!names.length) throw httpError(400, "请选择打分人");

  const users = await Promise.all(names.map(async name => await selectScorerByUsernameStmt.get(name)));
  const missing = names.filter((_, index) => !users[index]);
  if (missing.length)
    throw httpError(400, `打分人不存在：${missing.join("、")}`);
  await Promise.all(users.map(async (user, index) => {
    await assertScorerAssignable(user, names[index]);
  }));
  return { names };
}

async function parseTaskGenerationAssigneesInput(body: AssignmentBody = {}) {
  return parseGenerationAssignees(body, {
    normalizeTeamIds, normalizeTeamMatchMode, parseBacktestRatio,
    listScorersByTeamIds, normalizeUsername, httpError,
  });
}

function parseMultipartArray(value: unknown, label: string) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  throw httpError(400, `${label}格式不正确`);
}

async function readExactTaskAssignmentFile(file: Express.Multer.File | undefined): Promise<ExactEntry[]> {
  if (!file?.path) throw httpError(400, "请选择精确分配 JSON 清单");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file.path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw httpError(400, "精确分配清单不是有效的 JSON 文件");
    throw error;
  }

  const parsedObject = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const rows = Array.isArray(parsed)
    ? parsed
    : parsedObject.tasks ?? parsedObject.assignments ?? parsedObject.mappings;
  if (!Array.isArray(rows) || !rows.length) {
    throw httpError(400, "精确分配清单中没有任务数据");
  }
  if (rows.length > MAX_EXACT_TASK_ASSIGNMENTS) {
    throw httpError(400, `精确分配清单最多支持 ${MAX_EXACT_TASK_ASSIGNMENTS} 条任务`);
  }

  const seen = new Set<string>();
  const entries = rows.map((row, index) => {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const sourceTaskId = String(item.sourceTaskId ?? "").trim();
    if (!sourceTaskId || sourceTaskId.length > 160) {
      throw httpError(400, `精确分配清单第 ${index + 1} 条缺少有效的 sourceTaskId`);
    }
    if (seen.has(sourceTaskId)) {
      throw httpError(400, `精确分配清单存在重复的 sourceTaskId：${sourceTaskId}`);
    }
    seen.add(sourceTaskId);
    const scorer = String(item.scorer ?? item.sourceScorer ?? "").trim();
    if (scorer.length > 100) {
      throw httpError(400, `精确分配清单第 ${index + 1} 条打分人名称过长`);
    }
    return { sourceTaskId, scorer: scorer || null };
  });
  return entries;
}

async function parseExactTaskGenerationAssignment(body: Record<string, unknown>, file: Express.Multer.File | undefined) {
  if (!file) throw httpError(400, "请选择精确分配 JSON 清单");
  const entries = await readExactTaskAssignmentFile(file);
  const teamIds = await normalizeTeamIds(parseMultipartArray(body.teamIds, "团队列表"), {
    required: true,
    enabledOnly: true,
  });
  const teamMatchMode = normalizeTeamMatchMode(body.teamMatchMode);
  const availableUsers = await listScorersByTeamIds(teamIds, teamMatchMode);
  if (!availableUsers.length) throw httpError(400, "所选团队没有可用的打分账号");

  const fallbackScorerText = String(body.fallbackScorer ?? "").trim();
  const fallbackTaskCount = entries.reduce((total, entry) => total + (entry.scorer ? 0 : 1), 0);
  if (fallbackTaskCount && !fallbackScorerText) {
    throw httpError(400, `清单中有 ${fallbackTaskCount} 条任务没有原打分人，请选择兜底账号`);
  }
  const fallbackScorer = fallbackScorerText ? normalizeUsername(fallbackScorerText) : null;
  const availableNames = new Set(availableUsers.map((user) => user.username));
  const unavailableNames = new Set<string>();
  const countsByScorer = new Map<string, number>();
  entries.forEach((entry) => {
    const assignedScorer = entry.scorer || fallbackScorer;
    if (!assignedScorer) throw httpError(400, "请选择兜底账号");
    entry.scorer = assignedScorer;
    if (!availableNames.has(assignedScorer)) unavailableNames.add(assignedScorer);
    countsByScorer.set(assignedScorer, (countsByScorer.get(assignedScorer) || 0) + 1);
  });
  if (unavailableNames.size) {
    const names = [...unavailableNames];
    throw httpError(
      400,
      `清单中有 ${names.length} 名打分人不属于所选团队或账号不可用：${names.slice(0, 8).join("、")}`,
    );
  }

  const normalized = {
    version: 1,
    tasks: entries,
  };
  await fs.writeFile(file.path, JSON.stringify(normalized));
  return {
    mode: "exact",
    teamIds,
    teamMatchMode,
    backtestRatio: 0,
    fallbackScorer,
    fallbackTaskCount,
    exactTaskCount: entries.length,
    exactAssignmentFile: file.path,
    exactAssignmentFilename: file.originalname || "exact-task-assignment.json",
    allocations: [...countsByScorer.entries()].map(([scorer, taskCount]) => ({
      scorer,
      taskCount,
    })),
  };
}

function normalizedAllocationHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-:：]/g, "");
}

function taskAllocationCellText(cell: ExcelJS.Cell | null | undefined) {
  if (!cell) return "";
  const text = String(cell.text ?? "").trim();
  if (text) return text;
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if ("result" in value) return String(value.result ?? "").trim();
    if ("text" in value) return String(value.text ?? "").trim();
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text || "").join("").trim();
    }
  }
  return String(value).trim();
}

function parseAllocationTaskCount(value: unknown) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  if (!text) return null;
  const count = Number(text);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    return null;
  }
  return count;
}

async function parseTaskAllocationWorkbook(file: Express.Multer.File | undefined) {
  if (!file) throw httpError(400, "请选择分配表");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    const invalidWorkbook = httpError(422, "分配表无法读取，请确认文件为 XLSX 格式");
    invalidWorkbook.cause = error;
    throw invalidWorkbook;
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw httpError(422, "分配表没有可读取的工作表");

  const scorerHeaders = new Set([
    "打分人",
    "打分人名字",
    "打分账号",
    "账号",
    "用户名",
    "姓名",
    "名字",
    "name",
    "username",
    "user",
    "scorer",
  ].map(normalizedAllocationHeader));
  const countHeaders = new Set([
    "数量",
    "任务数量",
    "任务数",
    "分配数量",
    "分配任务数",
    "count",
    "taskcount",
    "tasks",
    "number",
  ].map(normalizedAllocationHeader));

  let scorerColumn = 1;
  let countColumn = 2;
  let firstDataRow = 1;
  let hasHeader = false;

  const rows: Array<{ row: ExcelJS.Row; rowNumber: number }> = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    rows.push({ row, rowNumber });
  });

  for (const { row, rowNumber } of rows.slice(0, 10)) {
    const cells = [];
    for (let index = 1; index <= Math.max(row.cellCount, 8); index += 1) {
      cells.push({
        index,
        header: normalizedAllocationHeader(taskAllocationCellText(row.getCell(index))),
      });
    }
    const scorer = cells.find((cell) => scorerHeaders.has(cell.header));
    const count = cells.find((cell) => countHeaders.has(cell.header));
    if (scorer && count && scorer.index !== count.index) {
      scorerColumn = scorer.index;
      countColumn = count.index;
      firstDataRow = rowNumber + 1;
      hasHeader = true;
      break;
    }
  }

  const parsedRows: Array<{ rowNumber: number; scorer: string; taskCount: number }> = [];
  const errors: string[] = [];
  for (const { row, rowNumber } of rows) {
    if (rowNumber < firstDataRow) continue;
    const scorer = taskAllocationCellText(row.getCell(scorerColumn));
    const rawCount = taskAllocationCellText(row.getCell(countColumn));
    if (!scorer && !rawCount) continue;
    if (!scorer) {
      errors.push(`第 ${rowNumber} 行缺少打分人`);
      continue;
    }
    const taskCount = parseAllocationTaskCount(rawCount);
    if (taskCount == null) {
      errors.push(`第 ${rowNumber} 行任务数量无效`);
      continue;
    }
    parsedRows.push({ rowNumber, scorer, taskCount });
    if (parsedRows.length > 1000) {
      throw httpError(413, "分配表最多读取 1000 行");
    }
  }

  return {
    filename: file.originalname,
    hasHeader,
    scorerColumn,
    countColumn,
    rows: parsedRows,
    errors,
  };
}

  return { parseTaskAssignees, parseTaskGenerationAssignees: parseTaskGenerationAssigneesInput, parseExactTaskGenerationAssignment, parseTaskAllocationWorkbook };
}
