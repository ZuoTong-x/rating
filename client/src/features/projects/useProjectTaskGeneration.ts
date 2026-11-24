import { computed, ref, type Ref } from 'vue';
import { useMessage, type UploadCustomRequestOptions } from 'naive-ui';
import { useRouter } from 'vue-router';
import { authApi } from '../../services/auth';
import { HttpError } from '../../services/http';
import { taskApi, type TaskAllocationImportResult } from '../../services/tasks';
import { parseTaskAllocationWorkbook } from '../../utils/task-allocation';
import { useTaskStackStore } from '../../stores/taskStack';
import type { ProjectItem } from '../../types/image';

type AllocationImportFeedback = {
  filename: string;
  parsedCount: number;
  appliedCount: number;
  ignoredCount: number;
  invalidCount: number;
  totalTaskCount: number;
  overflow: number;
  ignoredScorers: string[];
  errors: string[];
};

type TaskGenerationMode = 'random' | 'exact';
type ExactAssignmentSummary = {
  taskCount: number;
  mappedScorerCount: number;
  fallbackTaskCount: number;
};

type Options = {
  message: ReturnType<typeof useMessage>;
  submitting: Ref<boolean>;
  loadData: () => Promise<void>;
};

export function useProjectTaskGeneration({ message, submitting, loadData }: Options) {
  const router = useRouter();
  const taskStack = useTaskStackStore();
  const taskModalVisible = ref(false);
const pendingTaskProject = ref<ProjectItem | null>(null);
const taskTeamIds = ref<string[]>([]);
const taskTeamMatchMode = ref<'all' | 'any'>('all');
const taskScorersLoading = ref(false);
const taskScorers = ref<Array<{ id: string; username: string }>>([]);
const taskGenerationMode = ref<TaskGenerationMode>('random');
const exactAssignmentFile = ref<File | null>(null);
const exactAssignmentSummary = ref<ExactAssignmentSummary | null>(null);
const exactFallbackScorer = ref<string | null>(null);
const selectedTaskScorers = ref<string[]>([]);
const taskAllocations = ref<Record<string, number | null>>({});
const perScorerTaskCount = ref<number | null>(null);
const backtestRatio = ref<number | null>(0);
const allocationImporting = ref(false);
const allocationImportFeedback = ref<AllocationImportFeedback | null>(null);
const taskScorerRequest = ref(0);
const taskProgress = ref<Record<string, number>>({});
const taskStage = ref<Record<string, string>>({});
const taskGenerating = ref<Set<string>>(new Set());

const taskScorerOptions = computed(() => taskScorers.value.map(user => ({
  label: user.username,
  value: user.username
})));
const taskTemplateCount = computed(() => pendingTaskProject.value?.taskTemplateCount || 0);
const availableTaskCount = computed(() => pendingTaskProject.value?.availableTaskCount ?? taskTemplateCount.value);
const selectedTaskScorerSet = computed(() => new Set(selectedTaskScorers.value));
const assignedTaskCount = computed(() => selectedTaskScorers.value.reduce(
  (total, username) => total + Math.max(0, Math.floor(Number(taskAllocations.value[username]) || 0)),
  0
));
const backtestPercent = computed(() => Math.max(0, Math.min(50, Number(backtestRatio.value) || 0)));
function backtestTaskCountForTaskCount(taskCount: number) {
  if (!backtestPercent.value || taskCount <= 1) return 0;
  const requested = Math.floor((taskCount * backtestPercent.value) / 100);
  return Math.max(0, Math.min(requested, taskCount - 1));
}
function baseTaskCountForTaskCount(taskCount: number) {
  return Math.max(0, taskCount - backtestTaskCountForTaskCount(taskCount));
}
function allocationBaseTaskTotal(allocations: Record<string, number | null>, scorers = selectedTaskScorers.value) {
  return scorers.reduce((total, username) => {
    const taskCount = Math.max(0, Math.floor(Number(allocations[username]) || 0));
    return total + baseTaskCountForTaskCount(taskCount);
  }, 0);
}
const backtestTaskCount = computed(() => selectedTaskScorers.value.reduce((total, username) => {
  const taskCount = Math.max(0, Math.floor(Number(taskAllocations.value[username]) || 0));
  return total + backtestTaskCountForTaskCount(taskCount);
}, 0));
const baseAssignedTaskCount = computed(() => allocationBaseTaskTotal(taskAllocations.value));
function maxTaskCountForBaseLimit(baseLimit: number) {
  const limit = Math.max(0, Math.floor(baseLimit));
  if (!limit) return 0;
  if (!backtestPercent.value) return limit;
  let low = 0;
  let high = Math.ceil(limit / Math.max(0.01, 1 - backtestPercent.value / 100)) + 4;
  while (baseTaskCountForTaskCount(high) <= limit) high *= 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (baseTaskCountForTaskCount(middle) <= limit) low = middle;
    else high = middle - 1;
  }
  return low;
}
function evenAllocationBaseTaskTotal(totalTaskCount: number, userCount: number) {
  const count = Math.max(0, Math.floor(totalTaskCount));
  const users = Math.max(0, Math.floor(userCount));
  if (!count || !users) return 0;
  const base = Math.floor(count / users);
  const remainder = count % users;
  return ((users - remainder) * baseTaskCountForTaskCount(base))
    + (remainder * baseTaskCountForTaskCount(base + 1));
}
function maxEvenTaskCountForBaseLimit(baseLimit: number, userCount: number) {
  const limit = Math.max(0, Math.floor(baseLimit));
  const users = Math.max(0, Math.floor(userCount));
  if (!limit || !users) return 0;
  if (!backtestPercent.value) return limit;
  let low = 0;
  let high = maxTaskCountForBaseLimit(limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (evenAllocationBaseTaskTotal(middle, users) <= limit) low = middle;
    else high = middle - 1;
  }
  return low;
}
const maxAssignableTaskCount = computed(() => maxTaskCountForBaseLimit(availableTaskCount.value));
const remainingTaskCount = computed(() => Math.max(availableTaskCount.value - baseAssignedTaskCount.value, 0));
const allocationPayload = computed(() => selectedTaskScorers.value.map(username => ({
  scorer: username,
  taskCount: Math.max(0, Math.floor(Number(taskAllocations.value[username]) || 0))
})).filter(item => item.taskCount > 0));
const selectedTaskScorerCount = computed(() => selectedTaskScorers.value.length);
const allocationFeedbackType = computed(() => {
  if (!allocationImportFeedback.value) return 'success';
  return allocationImportFeedback.value.overflow > 0 || allocationImportFeedback.value.ignoredCount > 0 || allocationImportFeedback.value.invalidCount > 0
    ? 'warning'
    : 'success';
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function setGenerating(projectId: string, active: boolean) {
  const next = new Set(taskGenerating.value);
  if (active) next.add(projectId);
  else next.delete(projectId);
  taskGenerating.value = next;
}

function setProgress(projectId: string, progress: number | null, stage?: string | null) {
  const nextProgress = { ...taskProgress.value };
  const nextStage = { ...taskStage.value };
  if (progress == null) {
    delete nextProgress[projectId];
    delete nextStage[projectId];
  } else {
    nextProgress[projectId] = Math.max(0, Math.min(100, progress));
    if (stage) nextStage[projectId] = stage;
  }
  taskProgress.value = nextProgress;
  taskStage.value = nextStage;
}

async function loadTaskScorers() {
  const requestId = ++taskScorerRequest.value;
  if (!taskTeamIds.value.length) {
    taskScorers.value = [];
    taskAllocations.value = {};
    taskScorersLoading.value = false;
    return;
  }
  taskScorersLoading.value = true;
  try {
    const result = await authApi.scorerUsersByTeams(taskTeamIds.value, taskTeamMatchMode.value);
    if (requestId !== taskScorerRequest.value) return;
    const nextAllocations: Record<string, number | null> = {};
    result.users.forEach(user => {
      nextAllocations[user.username] = taskAllocations.value[user.username] ?? 0;
    });
    taskScorers.value = result.users;
    taskAllocations.value = nextAllocations;
    const availableNames = new Set(result.users.map(user => user.username));
    selectedTaskScorers.value = selectedTaskScorers.value.filter(username => availableNames.has(username));
    if (exactFallbackScorer.value && !availableNames.has(exactFallbackScorer.value)) {
      exactFallbackScorer.value = null;
    }
  } catch (error) {
    if (requestId === taskScorerRequest.value) message.error(errorMessage(error));
  } finally {
    if (requestId === taskScorerRequest.value) taskScorersLoading.value = false;
  }
}

function updateTaskTeams(teamIds: string[]) {
  taskTeamIds.value = teamIds;
  allocationImportFeedback.value = null;
  void loadTaskScorers();
}

function updateTaskTeamMatchMode(useAnyTeam: boolean) {
  taskTeamMatchMode.value = useAnyTeam ? 'any' : 'all';
  allocationImportFeedback.value = null;
  void loadTaskScorers();
}

function updateTaskScorerSelected(username: string, checked: boolean) {
  const next = new Set(selectedTaskScorers.value);
  if (checked) next.add(username);
  else {
    next.delete(username);
    taskAllocations.value = { ...taskAllocations.value, [username]: 0 };
  }
  selectedTaskScorers.value = taskScorers.value
    .map(user => user.username)
    .filter(name => next.has(name));
}

function selectAllTaskScorers() {
  selectedTaskScorers.value = taskScorers.value.map(user => user.username);
}

function clearTaskScorerSelection() {
  selectedTaskScorers.value = [];
  taskAllocations.value = Object.fromEntries(taskScorers.value.map(user => [user.username, 0]));
}

function updateTaskAllocation(username: string, value: number | null) {
  const taskCount = Math.max(0, Math.floor(Number(value) || 0));
  taskAllocations.value = {
    ...taskAllocations.value,
    [username]: taskCount
  };
  if (taskCount > 0 && !selectedTaskScorerSet.value.has(username)) {
    updateTaskScorerSelected(username, true);
  }
}

function normalizeTaskAllocations(editedUsername: string) {
  const limit = maxAssignableTaskCount.value;
  if (!limit) return;

  const selected = taskScorers.value.filter(user => selectedTaskScorerSet.value.has(user.username));
  const next = Object.fromEntries(taskScorers.value.map(user => [
    user.username,
    selectedTaskScorerSet.value.has(user.username)
      ? Math.min(limit, Math.max(0, Math.floor(Number(taskAllocations.value[user.username]) || 0)))
      : 0
  ])) as Record<string, number>;
  let overflow = allocationBaseTaskTotal(next) - availableTaskCount.value;
  if (overflow <= 0) {
    taskAllocations.value = next;
    return;
  }

  // Keep the amount just edited and take any overflow from the other allocations.
  // This keeps the total within the available task count while preserving the user's input.
  const otherUsers = selected
    .filter(user => user.username !== editedUsername)
    .sort((left, right) => next[right.username] - next[left.username]);
  for (const user of otherUsers) {
    if (overflow <= 0) break;
    const targetBaseCount = Math.max(0, baseTaskCountForTaskCount(next[user.username]) - overflow);
    next[user.username] = Math.min(next[user.username], maxTaskCountForBaseLimit(targetBaseCount));
    overflow = allocationBaseTaskTotal(next) - availableTaskCount.value;
  }

  if (overflow > 0) {
    const targetBaseCount = Math.max(0, baseTaskCountForTaskCount(next[editedUsername]) - overflow);
    next[editedUsername] = Math.min(next[editedUsername], maxTaskCountForBaseLimit(targetBaseCount));
  }
  taskAllocations.value = next;
}

function distributeEvenly() {
  const users = taskScorers.value.filter(user => selectedTaskScorerSet.value.has(user.username));
  if (!users.length) {
    message.error('请先选择打分人');
    return;
  }
  if (!availableTaskCount.value) return;
  const totalTaskCount = maxEvenTaskCountForBaseLimit(availableTaskCount.value, users.length);
  const base = Math.floor(totalTaskCount / users.length);
  const remainder = totalTaskCount % users.length;
  const userIndexes = new Map(users.map((user, index) => [user.username, index]));
  taskAllocations.value = Object.fromEntries(taskScorers.value.map(user => [
    user.username,
    selectedTaskScorerSet.value.has(user.username)
      ? base + ((userIndexes.get(user.username) ?? users.length) < remainder ? 1 : 0)
      : 0
  ]));
}

function assignFixedTaskCount() {
  const taskCount = Math.floor(Number(perScorerTaskCount.value) || 0);
  if (!selectedTaskScorerCount.value) {
    message.error('请先选择打分人');
    return;
  }
  if (taskCount <= 0) {
    message.error('请输入每人分配数量');
    return;
  }
  const nextAllocations = Object.fromEntries(taskScorers.value.map(user => [
    user.username,
    selectedTaskScorerSet.value.has(user.username) ? taskCount : 0
  ])) as Record<string, number>;
  const poolTaskCount = allocationBaseTaskTotal(nextAllocations);
  if (poolTaskCount > availableTaskCount.value) {
    message.error(`本次占用任务池数量不能超过 ${availableTaskCount.value}`);
    return;
  }
  taskAllocations.value = nextAllocations;
}

function applyAllocationImport(result: TaskAllocationImportResult) {
  const availableNames = new Set(taskScorers.value.map(user => user.username));
  const importedAllocations = new Map<string, number>();
  const ignoredScorers: string[] = [];

  result.rows.forEach(row => {
    if (!availableNames.has(row.scorer)) {
      if (!ignoredScorers.includes(row.scorer)) ignoredScorers.push(row.scorer);
      return;
    }
    importedAllocations.set(
      row.scorer,
      (importedAllocations.get(row.scorer) || 0) + row.taskCount
    );
  });

  selectedTaskScorers.value = taskScorers.value
    .map(user => user.username)
    .filter(username => (importedAllocations.get(username) || 0) > 0);
  taskAllocations.value = Object.fromEntries(taskScorers.value.map(user => [
    user.username,
    importedAllocations.get(user.username) || 0
  ]));

  const totalTaskCount = [...importedAllocations.values()].reduce((total, count) => total + count, 0);
  const importedBaseTaskCount = allocationBaseTaskTotal(taskAllocations.value, selectedTaskScorers.value);
  allocationImportFeedback.value = {
    filename: result.filename,
    parsedCount: result.rows.length,
    appliedCount: selectedTaskScorers.value.length,
    ignoredCount: ignoredScorers.length,
    invalidCount: result.errors.length,
    totalTaskCount,
    overflow: Math.max(0, importedBaseTaskCount - availableTaskCount.value),
    ignoredScorers,
    errors: result.errors
  };
}

async function importAllocationSheet({ file, onFinish, onError }: UploadCustomRequestOptions) {
  const project = pendingTaskProject.value;
  if (!project) {
    message.error('请先选择项目');
    onError();
    return;
  }
  if (!(file.file instanceof File)) {
    message.error('无法读取分配表');
    onError();
    return;
  }
  allocationImporting.value = true;
  try {
    const result = await parseTaskAllocationWorkbook(file.file);
    applyAllocationImport(result);
    message.success(`已读取 ${result.rows.length} 行分配数据`);
    onFinish();
  } catch (error) {
    message.error(errorMessage(error));
    onError();
  } finally {
    allocationImporting.value = false;
  }
}

async function readExactAssignmentFile({ file, onFinish, onError }: UploadCustomRequestOptions) {
  if (!(file.file instanceof File)) {
    message.error('无法读取精确分配清单');
    onError();
    return;
  }
  try {
    const parsed = JSON.parse(await file.file.text()) as Record<string, unknown> | unknown[];
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.tasks)
        ? parsed.tasks
        : Array.isArray(parsed.assignments)
          ? parsed.assignments
          : Array.isArray(parsed.mappings)
            ? parsed.mappings
            : null;
    if (!rows?.length) throw new Error('清单中没有任务数据');
    let mappedScorerCount = 0;
    rows.forEach((raw, index) => {
      const row = raw as Record<string, unknown>;
      if (!String(row?.sourceTaskId ?? '').trim()) {
        throw new Error(`第 ${index + 1} 条缺少 sourceTaskId`);
      }
      if (String(row?.scorer ?? row?.sourceScorer ?? '').trim()) mappedScorerCount += 1;
    });
    exactAssignmentFile.value = file.file;
    exactAssignmentSummary.value = {
      taskCount: rows.length,
      mappedScorerCount,
      fallbackTaskCount: rows.length - mappedScorerCount
    };
    onFinish();
  } catch (error) {
    exactAssignmentFile.value = null;
    exactAssignmentSummary.value = null;
    message.error(errorMessage(error));
    onError();
  }
}

async function openTaskProject(project: ProjectItem) {
  if (!['task_pending', 'scoring'].includes(project.taskStatus)) {
    void router.push(`/admin/projects/${encodeURIComponent(project._id)}/tasks`);
    return;
  }
  pendingTaskProject.value = project;
  taskTeamIds.value = [];
  taskTeamMatchMode.value = 'all';
  taskScorers.value = [];
  taskGenerationMode.value = 'random';
  exactAssignmentFile.value = null;
  exactAssignmentSummary.value = null;
  exactFallbackScorer.value = null;
  selectedTaskScorers.value = [];
  taskAllocations.value = {};
  perScorerTaskCount.value = null;
  backtestRatio.value = 0;
  allocationImportFeedback.value = null;
  taskModalVisible.value = true;
  await loadTaskScorers();
}

const TASK_GENERATION_POLL_INTERVAL = 10_000;
const TASK_GENERATION_MISSING_RETRY_LIMIT = 3;
type TaskGenerationJob = Awaited<ReturnType<typeof taskApi.projectTaskGenerationStatus>>;

function wait(milliseconds: number) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function waitForTaskGeneration(projectId: string, jobId: string, taskId: string) {
  let missingRetryCount = 0;
  while (true) {
    let job: TaskGenerationJob;
    try {
      job = await taskApi.projectTaskGenerationStatus(projectId, jobId);
      missingRetryCount = 0;
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.status === 404 &&
        missingRetryCount < TASK_GENERATION_MISSING_RETRY_LIMIT
      ) {
        missingRetryCount += 1;
        await wait(1_000 * missingRetryCount);
        continue;
      }
      throw error;
    }
    setProgress(projectId, job.progress, job.stage);
    taskStack.updateTask(taskId, {
      progress: job.progress,
      stage: job.stage || '任务生成中'
    });
    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.message || '任务生成失败');
    await wait(TASK_GENERATION_POLL_INTERVAL);
  }
}

async function startTask() {
  const project = pendingTaskProject.value;
  if (!project) {
    return;
  }
  if (!project.taskTemplateCount) {
    message.error('关联图包未提供 tasks.json，无法创建任务');
    return;
  }
  if (!availableTaskCount.value) {
    message.error('当前项目没有可继续下发的任务');
    return;
  }
  if (!taskTeamIds.value.length) {
    message.error('请至少选择一个标注团队');
    return;
  }
  const exactMode = taskGenerationMode.value === 'exact';
  if (exactMode) {
    if (!exactAssignmentFile.value || !exactAssignmentSummary.value) {
      message.error('请选择精确分配 JSON 清单');
      return;
    }
    if (!exactFallbackScorer.value) {
      message.error('请选择未匹配任务的兜底账号');
      return;
    }
    if (exactAssignmentSummary.value.taskCount > availableTaskCount.value) {
      message.error(`清单任务数不能超过可下发数量 ${availableTaskCount.value}`);
      return;
    }
  } else {
    if (!selectedTaskScorerCount.value) {
      message.error('请至少选择一名打分人');
      return;
    }
    if (!allocationPayload.value.length) {
      message.error('请至少为一名打分人设置任务数量');
      return;
    }
    if (baseAssignedTaskCount.value > availableTaskCount.value) {
      message.error(`占用任务池数量不能超过 ${availableTaskCount.value}`);
      return;
    }
  }
  submitting.value = true;
  taskModalVisible.value = false;
  setGenerating(project._id, true);
  const initialStage = exactMode ? '等待精确任务分配' : '等待导入任务模板';
  setProgress(project._id, 0, initialStage);
  const taskId = taskStack.addTask({
    kind: 'generate',
    title: `发起任务：${project.name}`,
    description: exactMode
      ? `按清单分配 ${exactAssignmentSummary.value?.taskCount || 0} 个任务`
      : `${allocationPayload.value.length} 个打分人 / 实际 ${assignedTaskCount.value} 个任务 / 回测 ${backtestTaskCount.value} 个`,
    stage: initialStage,
    progress: 0
  });
  try {
    const job = exactMode
      ? await taskApi.generateExactProjectTasks(project._id, {
        file: exactAssignmentFile.value!,
        teamIds: taskTeamIds.value,
        teamMatchMode: taskTeamMatchMode.value,
        fallbackScorer: exactFallbackScorer.value!
      })
      : await taskApi.generateProjectTasks(project._id, {
        teamIds: taskTeamIds.value,
        teamMatchMode: taskTeamMatchMode.value,
        allocations: allocationPayload.value,
        backtestRatio: backtestPercent.value
      });
    taskStack.updateTask(taskId, {
      progress: job.progress,
      stage: job.stage || '任务生成中'
    });
    const result = job.status === 'completed'
      ? job.result
      : job.status === 'failed'
        ? (() => { throw new Error(job.message || '任务生成失败'); })()
        : await waitForTaskGeneration(project._id, job.jobId, taskId);
    if (!result) throw new Error('任务生成完成，但没有返回结果');
    taskStack.finishTask(taskId, {
      stage: '任务创建完成',
      description: exactMode
        ? `已按清单分配 ${result.assignedCount} 个任务`
        : `已分配 ${result.assignedCount} 个，其中回测 ${result.backtestCount || 0} 个`
    });
    message.success(exactMode
      ? `已按清单分配 ${result.assignedCount} 个任务，待分配 ${result.unassignedCount} 个`
      : `已生成 ${result.createdCount} 个任务，已分配 ${result.assignedCount} 个，其中回测 ${result.backtestCount || 0} 个，待分配 ${result.unassignedCount} 个`);
    await loadData();
    await router.push(`/admin/projects/${encodeURIComponent(project._id)}/tasks`);
  } catch (error) {
    taskStack.failTask(taskId, error);
    message.error(errorMessage(error));
    await loadData();
  } finally {
    setGenerating(project._id, false);
    setProgress(project._id, null);
    pendingTaskProject.value = null;
    submitting.value = false;
  }
}

  return {
    taskModalVisible, taskTeamIds, taskTeamMatchMode,
    taskScorersLoading, taskScorers, taskGenerationMode, exactAssignmentFile,
    exactAssignmentSummary, exactFallbackScorer, taskAllocations,
    perScorerTaskCount, backtestRatio, allocationImporting, allocationImportFeedback,
    taskProgress, taskStage, taskGenerating, taskScorerOptions,
    taskTemplateCount, availableTaskCount, selectedTaskScorerSet, assignedTaskCount,
    backtestTaskCount, baseAssignedTaskCount, maxAssignableTaskCount,
    remainingTaskCount, selectedTaskScorerCount, allocationFeedbackType,
    updateTaskTeams, updateTaskTeamMatchMode, updateTaskScorerSelected, selectAllTaskScorers,
    clearTaskScorerSelection, updateTaskAllocation, normalizeTaskAllocations, distributeEvenly,
    assignFixedTaskCount, importAllocationSheet, readExactAssignmentFile, openTaskProject,
    startTask
  };
}
