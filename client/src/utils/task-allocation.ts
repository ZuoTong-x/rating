import type ExcelJS from 'exceljs';
import type { TaskAllocationImportResult } from '../services/tasks';

function normalizedAllocationHeader(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-:：]/g, '');
}

function taskAllocationCellText(cell: { text?: unknown; value?: unknown } | null | undefined) {
  if (!cell) return '';
  const text = String(cell.text ?? '').trim();
  if (text) return text;
  const value = cell.value;
  if (value == null) return '';
  if (typeof value === 'object') {
    if ('result' in value) return String((value as { result?: unknown }).result ?? '').trim();
    if ('text' in value) return String((value as { text?: unknown }).text ?? '').trim();
    if ('richText' in value && Array.isArray((value as { richText?: Array<{ text?: string }> }).richText)) {
      return ((value as { richText?: Array<{ text?: string }> }).richText || [])
        .map(item => item.text || '')
        .join('')
        .trim();
    }
  }
  return String(value).trim();
}

function parseAllocationTaskCount(value: unknown) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text) return null;
  const count = Number(text);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
    return null;
  }
  return count;
}

export async function parseTaskAllocationWorkbook(file: File): Promise<TaskAllocationImportResult> {
  if (!file) throw new Error('请选择分配表');

  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch (error) {
    const wrapped = new Error('分配表无法读取，请确认文件为 XLSX 格式');
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('分配表没有可读取的工作表');

  const scorerHeaders = new Set([
    '打分人',
    '打分人名字',
    '打分账号',
    '账号',
    '用户名',
    '姓名',
    '名字',
    'name',
    'username',
    'user',
    'scorer',
  ].map(normalizedAllocationHeader));
  const countHeaders = new Set([
    '数量',
    '任务数量',
    '任务数',
    '分配数量',
    '分配任务数',
    'count',
    'taskcount',
    'tasks',
    'number',
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
    const cells = [] as Array<{ index: number; header: string }>;
    for (let index = 1; index <= Math.max(row.cellCount, 8); index += 1) {
      cells.push({
        index,
        header: normalizedAllocationHeader(taskAllocationCellText(row.getCell(index))),
      });
    }
    const scorer = cells.find(cell => scorerHeaders.has(cell.header));
    const count = cells.find(cell => countHeaders.has(cell.header));
    if (scorer && count && scorer.index !== count.index) {
      scorerColumn = scorer.index;
      countColumn = count.index;
      firstDataRow = rowNumber + 1;
      hasHeader = true;
      break;
    }
  }

  const parsedRows: TaskAllocationImportResult['rows'] = [];
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
      throw new Error('分配表最多读取 1000 行');
    }
  }

  return {
    filename: file.name,
    hasHeader,
    scorerColumn,
    countColumn,
    rows: parsedRows,
    errors,
  };
}
