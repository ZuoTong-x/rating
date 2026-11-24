import ExcelJSModule from "exceljs";
import type { Response } from "express";
import type { db as database } from "../postgres.ts";

type TaskStats = { total: number; pending: number; assigned: number; completed: number };
type DimensionSummary = TaskStats & { key: string; criterion: string; label: string };
type ScorerSummary = TaskStats & {
  scorer: string;
  averageDurationMs: number | null;
  criteria: Set<string>;
};
type ReportSummary = {
  subject: { _id: string; name: string };
  imageCount: number;
  categoryCount: number;
  criterionCount: number;
  totalTasks: number;
  statusCounts: Pick<TaskStats, "pending" | "assigned" | "completed">;
  completedTasks: number;
  completionRate: number;
  scorerCount: number;
  dimensions: Array<DimensionSummary & { completionRate: number }>;
  scorers: Array<Omit<ScorerSummary, "criteria" | "averageDurationMs"> & {
    uncompleted: number;
    completionRate: number;
    dimensions: Array<{ key: string; label: string }>;
    averageDurationSeconds: number | null;
  }>;
};
type Progress = (update: { stage: string; progress: number }) => void;
type Project = { _id: string; name: string };
type TaskStatus = "pending" | "assigned" | "completed";
type DimensionRow = { criterion: string; status: TaskStatus; count: number };
type ScorerRow = { scorer: string; status: TaskStatus; count: number; averageDurationMs: number | null };
type ScorerCriterionRow = { scorer: string; criterion: string };

export function createTaskReportService({
    taskCriterionLabels, subjectTaskReportCache, subjectTaskReportCacheTtlMs,
    getProjectOrThrow, projectPackageIds, db, placeholders,
    getProjectTaskStats, taskVersion, ExcelJS,
}: {
  taskCriterionLabels: Record<string, string>;
  subjectTaskReportCache: Map<string, { value: ReportSummary; expiresAt: number }>;
  subjectTaskReportCacheTtlMs: number;
  getProjectOrThrow: (id: string) => Promise<Project>;
  projectPackageIds: (project: Project) => Promise<string[]>;
  db: typeof database;
  placeholders: (count: number) => string;
  getProjectTaskStats: (id: string) => Promise<TaskStats>;
  taskVersion: string;
  ExcelJS: typeof ExcelJSModule;
}) {
function taskCriterionLabel(taskType: string) {
  const criterion = String(taskType || "").split(":")[1] || "";
  return taskCriterionLabels[criterion] || criterion || "未指定维度";
}

function reportCompletionRate(completed: number, total: number) {
  return total ? completed / total : 0;
}

function addReportSheet(
  workbook: ExcelJSModule.Workbook,
  name: string,
  headers: string[],
  rows: Array<Array<string | number | null>>,
  widths?: number[],
) {
  const worksheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  worksheet.columns = headers.map((header, index) => ({
    header,
    width: widths?.[index] || 16,
  }));
  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E293B" },
    };
  });

  rows.forEach((values) => {
    const row = worksheet.addRow(values.map((value) => value ?? ""));
    row.alignment = { vertical: "middle", wrapText: true };
  });
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };
  return worksheet;
}

async function getSubjectTaskReportSummary(subjectId: string): Promise<ReportSummary> {
  const cached = subjectTaskReportCache.get(subjectId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const project = await getProjectOrThrow(subjectId);
  const packageIds = await projectPackageIds(project);

  const imageStats = await db
    .prepare(
      `SELECT COUNT(*) AS imageCount,
               COUNT(DISTINCT category) AS categoryCount
       FROM images
       WHERE subjectId IN (${placeholders(packageIds.length)})`,
    )
    .get(...packageIds) as { imageCount: number; categoryCount: number };
  const taskStats = await getProjectTaskStats(subjectId);
  const statusCounts = {
    pending: taskStats.pending,
    assigned: taskStats.assigned,
    completed: taskStats.completed,
  };

  const dimensionRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(split_part(taskType, ':', 2), ''), taskType) AS criterion,
              status, COUNT(*) AS count
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       GROUP BY COALESCE(NULLIF(split_part(taskType, ':', 2), ''), taskType), status
       ORDER BY criterion ASC`,
    )
    .all(subjectId, taskVersion) as DimensionRow[];
  const dimensionMap = new Map<string, DimensionSummary>();
  dimensionRows.forEach((row) => {
    const key = row.criterion;
    const item = dimensionMap.get(key) || {
      key,
      criterion: row.criterion || "",
      label: taskCriterionLabel(`dimension:${row.criterion}`),
      total: 0,
      pending: 0,
      assigned: 0,
      completed: 0,
    };
    item[row.status] = (item[row.status] || 0) + row.count;
    item.total += row.count;
    dimensionMap.set(key, item);
  });

  const scorerRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(scorer), ''), '未分配') AS scorer,
              status, COUNT(*) AS count,
              AVG(CASE WHEN durationMs >= 0 THEN durationMs END) AS averageDurationMs
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       GROUP BY COALESCE(NULLIF(TRIM(scorer), ''), '未分配'), status`,
    )
    .all(subjectId, taskVersion) as ScorerRow[];
  const scorerCriteriaRows = await db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(scorer), ''), '未分配') AS scorer,
              COALESCE(NULLIF(split_part(taskType, ':', 2), ''), taskType) AS criterion
       FROM rating_tasks
       WHERE projectId = ? AND taskVersion = ?
       GROUP BY COALESCE(NULLIF(TRIM(scorer), ''), '未分配'),
                COALESCE(NULLIF(split_part(taskType, ':', 2), ''), taskType)
       ORDER BY LOWER(COALESCE(NULLIF(TRIM(scorer), ''), '未分配')) ASC,
                COALESCE(NULLIF(TRIM(scorer), ''), '未分配') ASC,
                criterion ASC`,
    )
    .all(subjectId, taskVersion) as ScorerCriterionRow[];
  const scorerMap = new Map<string, ScorerSummary>();
  scorerRows.forEach((row) => {
    const item = scorerMap.get(row.scorer) || {
      scorer: row.scorer,
      total: 0,
      pending: 0,
      assigned: 0,
      completed: 0,
      averageDurationMs: null,
      criteria: new Set<string>(),
    };
    item[row.status] = (item[row.status] || 0) + row.count;
    item.total += row.count;
    if (row.averageDurationMs != null)
      item.averageDurationMs = row.averageDurationMs;
    scorerMap.set(row.scorer, item);
  });
  scorerCriteriaRows.forEach((row) => {
    const item = scorerMap.get(row.scorer);
    if (item) item.criteria.add(row.criterion || "");
  });

  const totalTasks = taskStats.total;
  const completedTasks = statusCounts.completed;
  const dimensions = [...dimensionMap.values()].map((item) => ({
    ...item,
    completionRate: reportCompletionRate(item.completed, item.total),
  }));
  const scorers = [...scorerMap.values()]
    .sort((left, right) => left.scorer.localeCompare(right.scorer))
    .map((item) => ({
      scorer: item.scorer,
      total: item.total,
      pending: item.pending,
      assigned: item.assigned,
      uncompleted: item.pending + item.assigned,
      completed: item.completed,
      completionRate: reportCompletionRate(item.completed, item.total),
      dimensions: [...item.criteria].filter(Boolean).map((criterion) => ({
        key: criterion,
        label: taskCriterionLabel(`dimension:${criterion}`),
      })),
      averageDurationSeconds:
        item.averageDurationMs == null ? null : item.averageDurationMs / 1000,
    }));

  const report = {
    subject: { _id: project._id, name: project.name },
    imageCount: imageStats.imageCount,
    categoryCount: imageStats.categoryCount,
    criterionCount: new Set(
      dimensions.map((item) => item.criterion).filter(Boolean),
    ).size,
    totalTasks,
    statusCounts,
    completedTasks,
    completionRate: reportCompletionRate(completedTasks, totalTasks),
    scorerCount: scorers.filter((item) => item.scorer !== "未分配").length,
    dimensions,
    scorers,
  };
  subjectTaskReportCache.set(subjectId, {
    value: report,
    expiresAt: Date.now() + subjectTaskReportCacheTtlMs,
  });
  return report;
}

async function buildSubjectTaskReportWorkbook(subjectId: string, onProgress?: Progress) {
  onProgress?.({ stage: "正在统计项目任务", progress: 15 });
  const report = await getSubjectTaskReportSummary(subjectId);
  const subject = report.subject;
  const imageStats = {
    imageCount: report.imageCount,
    categoryCount: report.categoryCount,
  };
  const statusCounts = report.statusCounts;
  const totalTasks = report.totalTasks;
  const completedTasks = report.completedTasks;
  const dimensionStats = report.dimensions;
  const scorerStats = report.scorers;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "评分平台";
  workbook.created = new Date();
  onProgress?.({ stage: "正在生成 Excel 工作表", progress: 55 });

  addReportSheet(
    workbook,
    "项目总览",
    ["统计项", "数值"],
    [
      ["项目名称", subject.name],
      ["项目 ID", subject._id],
      ["图片总数", imageStats.imageCount],
      ["目录分类数", imageStats.categoryCount],
      ["评分维度数", report.criterionCount],
      ["任务总数", totalTasks],
      ["待分配任务", statusCounts.pending],
      ["未完成任务", statusCounts.assigned],
      ["已完成任务", completedTasks],
      ["任务完成率", reportCompletionRate(completedTasks, totalTasks)],
      ["打分人数量", report.scorerCount],
      ["导出时间", new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })],
    ],
    [24, 46],
  ).getCell(11, 2).numFmt = "0.00%";

  addReportSheet(
    workbook,
    "状态汇总",
    ["任务状态", "任务数量", "占比"],
    [
      [
        "待分配",
        statusCounts.pending,
        reportCompletionRate(statusCounts.pending, totalTasks),
      ],
      [
        "未完成",
        statusCounts.assigned,
        reportCompletionRate(statusCounts.assigned, totalTasks),
      ],
      [
        "已完成",
        completedTasks,
        reportCompletionRate(completedTasks, totalTasks),
      ],
    ],
    [18, 16, 16],
  ).getColumn(3).numFmt = "0.00%";

  const dimensionRows = dimensionStats.map((item) => [
    item.label,
    item.criterion,
    item.total,
    item.pending,
    item.assigned,
    item.completed,
    reportCompletionRate(item.completed, item.total),
  ]);
  addReportSheet(
    workbook,
    "维度统计",
    [
      "评分维度",
      "维度键",
      "任务总数",
      "待分配",
      "未完成",
      "已完成",
      "完成率",
    ],
    dimensionRows,
    [28, 24, 10, 14, 14, 14, 14],
  ).getColumn(7).numFmt = "0.00%";

  const scorerRows = scorerStats.map((item) => [
    item.scorer,
    item.total,
    item.pending,
    item.assigned,
    item.pending + item.assigned,
    item.completed,
    reportCompletionRate(item.completed, item.total),
    item.dimensions.map((dimension) => dimension.label).join("、"),
    item.averageDurationSeconds,
  ]);
  addReportSheet(
    workbook,
    "打分人统计",
    [
      "打分人",
      "任务总数",
      "待分配",
      "已分配未完成",
      "未完成合计",
      "已完成",
      "完成率",
      "涉及维度",
      "平均打分时长(秒)",
    ],
    scorerRows,
    [18, 14, 14, 18, 16, 14, 14, 52, 22],
  ).getColumn(7).numFmt = "0.00%";

  return { workbook, report };
}

function taskReportExportFilename() {
  return `task-report-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.xlsx`;
}

async function exportSubjectTaskReport(subjectId: string, res: Response) {
  const { workbook } = await buildSubjectTaskReportWorkbook(subjectId);
  const filename = taskReportExportFilename();
  const file = Buffer.from(await workbook.xlsx.writeBuffer());
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(file);
}

async function writeSubjectTaskReportFile(subjectId: string, filePath: string, onProgress?: Progress) {
  const { workbook, report } = await buildSubjectTaskReportWorkbook(subjectId, onProgress);
  onProgress?.({ stage: "正在写入 Excel 文件", progress: 80 });
  await workbook.xlsx.writeFile(filePath);
  onProgress?.({ stage: "Excel 文件已写入", progress: 95 });
  return {
    projectId: report.subject._id,
    projectName: report.subject.name,
    totalTasks: report.totalTasks,
    completedTasks: report.completedTasks,
    scorerCount: report.scorerCount,
  };
}

  return { getSubjectTaskReportSummary, exportSubjectTaskReport, writeSubjectTaskReportFile };
}
