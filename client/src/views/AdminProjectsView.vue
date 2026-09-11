<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NInput, NProgress, NTag, useDialog, useMessage, type DataTableColumns, type UploadCustomRequestOptions } from 'naive-ui';
import { useRouter } from 'vue-router';
import { authApi } from '../services/auth';
import { HttpError } from '../services/http';
import { imageApi, type TaskAllocationImportResult } from '../services/images';
import { parseTaskAllocationWorkbook } from '../utils/task-allocation';
import { useTaskStackStore } from '../stores/taskStack';
import type { ProjectItem, SubjectItem } from '../types/image';
import { formatDateTime } from '../utils/time';

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

const router = useRouter();
const message = useMessage();
const dialog = useDialog();
const taskStack = useTaskStackStore();
const loading = ref(false);
const submitting = ref(false);
const projectModalVisible = ref(false);
const taskModalVisible = ref(false);
const projects = ref<ProjectItem[]>([]);
const projectTotal = ref(0);
const projectPage = ref(1);
const projectPageSize = ref(10);
const packages = ref<SubjectItem[]>([]);
const teams = ref<Array<{ id: string; name: string; userCount?: number }>>([]);
const editingProject = ref<ProjectItem | null>(null);
const pendingTaskProject = ref<ProjectItem | null>(null);
const taskTeamIds = ref<string[]>([]);
const taskTeamMatchMode = ref<'all' | 'any'>('all');
const taskScorersLoading = ref(false);
const taskScorers = ref<Array<{ id: string; username: string }>>([]);
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

const projectForm = reactive({
  name: '',
  packageIds: [] as string[]
});

const packageOptions = computed(() => packages.value
  .filter(item => item.status === 'imported')
  .map(item => ({ label: `${item.name} (${item.imageCount} 张)`, value: item._id })));
const teamOptions = computed(() => teams.value.map(team => ({
  label: `${team.name}${team.userCount != null ? ` (${team.userCount} 人)` : ''}`,
  value: team.id
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

function taskStatusLabel(status: ProjectItem['taskStatus']) {
  return {
    task_pending: '任务未开始',
    scoring: '打分中',
    task_completed: '打分任务已完成'
  }[status] || '任务未开始';
}

function taskStatusType(status: ProjectItem['taskStatus']) {
  if (status === 'task_completed') return 'success';
  if (status === 'scoring') return 'warning';
  return 'default';
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

async function loadData(page = projectPage.value, pageSize = projectPageSize.value) {
  loading.value = true;
  try {
    const [projectResult, packageRows, teamRows] = await Promise.all([
      imageApi.projectPage({ page, pageSize }),
      imageApi.subjects(),
      authApi.scorerTeams({ status: 'enabled' })
    ]);
    projects.value = projectResult.projects;
    projectTotal.value = projectResult.total;
    projectPage.value = projectResult.page;
    projectPageSize.value = projectResult.pageSize;
    packages.value = packageRows;
    teams.value = teamRows;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

function changeProjectPage(page: number) {
  void loadData(page, projectPageSize.value);
}

function changeProjectPageSize(pageSize: number) {
  void loadData(1, pageSize);
}

function projectPaginationPrefix({ itemCount }: { itemCount?: number }) {
  return `共 ${itemCount ?? projectTotal.value} 个项目`;
}

function openCreateProject() {
  editingProject.value = null;
  projectForm.name = '';
  projectForm.packageIds = [];
  projectModalVisible.value = true;
}

function openEditProject(project: ProjectItem) {
  editingProject.value = project;
  projectForm.name = project.name;
  projectForm.packageIds = [...(project.packageIds?.length ? project.packageIds : [project.packageId])];
  projectModalVisible.value = true;
}

async function submitProject() {
  const name = projectForm.name.trim();
  if (!name || !projectForm.packageIds.length) {
    message.error('请填写项目名称，并选择至少一个图包');
    return;
  }
  submitting.value = true;
  try {
    const creatingProject = !editingProject.value;
    const payload = {
      name,
      packageIds: projectForm.packageIds
    };
    if (editingProject.value) {
      await imageApi.updateProject(editingProject.value._id, payload);
      message.success('项目已更新');
    } else {
      await imageApi.createProject(payload);
      message.success('项目已创建');
    }
    projectModalVisible.value = false;
    await loadData(creatingProject ? 1 : projectPage.value, projectPageSize.value);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    submitting.value = false;
  }
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

async function openTaskProject(project: ProjectItem) {
  if (!['task_pending', 'scoring'].includes(project.taskStatus)) {
    void router.push(`/admin/projects/${encodeURIComponent(project._id)}/tasks`);
    return;
  }
  pendingTaskProject.value = project;
  taskTeamIds.value = [];
  taskTeamMatchMode.value = 'all';
  taskScorers.value = [];
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
type TaskGenerationJob = Awaited<ReturnType<typeof imageApi.projectTaskGenerationStatus>>;

function wait(milliseconds: number) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function waitForTaskGeneration(projectId: string, jobId: string, taskId: string) {
  let missingRetryCount = 0;
  while (true) {
    let job: TaskGenerationJob;
    try {
      job = await imageApi.projectTaskGenerationStatus(projectId, jobId);
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
  submitting.value = true;
  taskModalVisible.value = false;
  setGenerating(project._id, true);
  setProgress(project._id, 0, '等待导入任务模板');
  const taskId = taskStack.addTask({
    kind: 'generate',
    title: `发起任务：${project.name}`,
    description: `${allocationPayload.value.length} 个打分人 / 实际 ${assignedTaskCount.value} 个任务 / 回测 ${backtestTaskCount.value} 个`,
    stage: '等待导入任务模板',
    progress: 0
  });
  try {
    const job = await imageApi.generateProjectTasks(project._id, {
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
      description: `已分配 ${result.assignedCount} 个，其中回测 ${result.backtestCount || 0} 个`
    });
    message.success(`已生成 ${result.createdCount} 个任务，已分配 ${result.assignedCount} 个，其中回测 ${result.backtestCount || 0} 个，待分配 ${result.unassignedCount} 个`);
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

function removeProject(project: ProjectItem) {
  let confirmation = '';
  const positiveButtonProps = reactive({
    type: 'error' as const,
    disabled: true
  });
  const updateConfirmation = (value: string) => {
    confirmation = value;
    positiveButtonProps.disabled = value !== '立即删除';
  };

  dialog.warning({
    title: '删除项目',
    content: () => h('div', [
      h('p', { style: { margin: '0 0 12px' } },
        `删除“${project.name}”后，项目及未完成任务会被清理，图包和图片会保留，已完成标注记录保留。请输入“立即删除”继续。`),
      h(NInput, {
        placeholder: '请输入立即删除',
        clearable: true,
        autofocus: true,
        onUpdateValue: updateConfirmation
      })
    ]),
    positiveText: '确认删除',
    negativeText: '取消',
    positiveButtonProps,
    onPositiveClick: async () => {
      if (confirmation !== '立即删除') return false;
      try {
        const result = await imageApi.deleteProject(project._id);
        message.success(`项目已删除，清理了 ${result.deletedTaskCount} 个未完成任务`);
        const nextPage = projects.value.length === 1 && projectPage.value > 1 ? projectPage.value - 1 : projectPage.value;
        await loadData(nextPage, projectPageSize.value);
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      }
    }
  });
}

function renderStatus(row: ProjectItem) {
  if (taskGenerating.value.has(row._id)) {
    const percentage = Math.round(taskProgress.value[row._id] || 0);
    return h('div', { class: 'subject-status-cell' }, [
      h(NProgress, { percentage, showIndicator: false }),
      h('div', { class: 'subject-status-text' }, `${taskStage.value[row._id] || '生成任务'} ${percentage}%`)
    ]);
  }
  return h(NTag, { size: 'small', type: taskStatusType(row.taskStatus) }, {
    default: () => taskStatusLabel(row.taskStatus)
  });
}

function taskActionLabel(row: ProjectItem) {
  const available = row.availableTaskCount ?? row.taskTemplateCount;
  if (available) return row.taskStatus === 'scoring' ? '继续下发' : '开始任务';
  return row.taskTemplateCount > 0 ? '任务已全部下发' : '缺少任务文件';
}

const columns: DataTableColumns<ProjectItem> = [
  { title: '项目名称', key: 'name', minWidth: 180 },
  {
    title: '关联图包',
    key: 'packages',
    minWidth: 220,
    render: row => h('div', { class: 'account-team-tags' }, row.packages?.length
      ? row.packages.map(pkg => h(NTag, { size: 'small', type: 'info', bordered: false }, { default: () => pkg.name }))
      : [h('span', { class: 'table-muted' }, row.packageName || '未配置')])
  },
  { title: '图片数', key: 'imageCount', width: 90 },
  {
    title: '标注团队', key: 'teams', minWidth: 180,
    render: row => h('div', { class: 'account-team-tags' }, row.teams.length
      ? row.teams.map(team => h(
        NTag,
        { size: 'small', type: team.status === 'disabled' ? 'warning' : 'info', bordered: false },
        { default: () => team.status === 'disabled' ? `${team.name}（禁用）` : team.name }
      ))
      : [h('span', { class: 'table-muted' }, '未配置')])
  },
  { title: '任务状态', key: 'taskStatus', width: 180, render: renderStatus },
  { title: '创建时间', key: 'createdAt', width: 180, render: row => formatDateTime(row.createdAt) },
  {
    title: '功能', key: 'actions', fixed: 'right', width: 220,
    render: row => h('div', { class: 'table-actions' }, [
      ['task_pending', 'scoring'].includes(row.taskStatus)
        ? h(NButton, { size: 'small', type: 'primary', secondary: true, loading: taskGenerating.value.has(row._id), disabled: !(row.availableTaskCount ?? row.taskTemplateCount), onClick: () => openTaskProject(row) }, { default: () => taskActionLabel(row) })
        : null,
      h(NButton, { size: 'small', tertiary: true, onClick: () => openEditProject(row) }, { default: () => '编辑' }),
      h(NButton, { size: 'small', tertiary: true, type: 'error', disabled: taskGenerating.value.has(row._id), onClick: () => removeProject(row) }, { default: () => '删除' })
    ].filter(Boolean))
  }
];

onMounted(() => void loadData());
</script>

<template>
  <div class="admin-page">
    <div class="table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>项目列表</strong>
          <n-text depth="3">共 {{ projectTotal }} 个项目</n-text>
        </div>
        <n-button type="primary" @click="openCreateProject">新建项目</n-button>
      </div>
      <n-data-table v-if="projects.length" :columns="columns" :data="projects" :loading="loading" :bordered="false" remote
        :scroll-x="1100" />
      <div v-else class="empty">{{ loading ? '正在加载...' : '暂无项目，请先在图包管理中上传 ZIP' }}</div>
      <div class="table-shell-footer">
        <n-pagination v-if="projectTotal" :page="projectPage" :page-size="projectPageSize" :item-count="projectTotal"
          show-size-picker :page-sizes="[10, 20, 50, 100]" :prefix="projectPaginationPrefix"
          @update:page="changeProjectPage" @update:page-size="changeProjectPageSize" />
      </div>
    </div>

    <n-modal v-model:show="projectModalVisible" preset="card" class="project-create-modal"
      :title="editingProject ? '编辑项目' : '新建项目'" :bordered="false">
      <n-form label-placement="top">
        <n-form-item label="项目名称">
          <n-input v-model:value="projectForm.name" maxlength="120" placeholder="输入项目名称" autofocus />
        </n-form-item>
        <n-form-item label="选择图包">
          <n-select v-model:value="projectForm.packageIds" multiple filterable :options="packageOptions"
            placeholder="选择一个或多个已处理完成的图包" />
        </n-form-item>
      </n-form>
      <n-space justify="end">
        <n-button @click="projectModalVisible = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submitProject">保存项目</n-button>
      </n-space>
    </n-modal>

    <n-modal v-model:show="taskModalVisible" preset="card" class="task-allocation-modal" title="开始任务" :bordered="false">
      <n-form label-placement="top">
        <n-form-item>
          <template #label>
            <div class="flex">
              <n-text style="margin-right:10px">团队筛选</n-text>
              <n-switch :value="taskTeamMatchMode === 'any'" @update:value="updateTaskTeamMatchMode">
                <template #checked>合集</template>
                <template #unchecked>交集</template>
              </n-switch>
            </div>
          </template>

          <n-select :value="taskTeamIds" multiple filterable :options="teamOptions" placeholder="选择参与本次任务的团队"
            @update:value="updateTaskTeams" />

        </n-form-item>
        <div class="task-allocation-summary" aria-label="任务分配汇总">
          <n-tag size="small" type="info" :bordered="false">模板任务 {{ taskTemplateCount }}</n-tag>
          <n-tag size="small" :bordered="false">可下发 {{ availableTaskCount }}</n-tag>
          <n-tag size="small" :bordered="false">已选 {{ selectedTaskScorerCount }}</n-tag>
          <n-tag size="small" type="success" :bordered="false">实际下发 {{ assignedTaskCount }}</n-tag>
          <n-tag size="small" :bordered="false">占用任务池 {{ baseAssignedTaskCount }}</n-tag>
          <n-tag size="small" type="warning" :bordered="false">回测 {{ backtestTaskCount }}</n-tag>
          <n-tag size="small" :bordered="false">待分配 {{ remainingTaskCount }}</n-tag>
        </div>
        <div class="task-allocation-backtest">
          <span>回测比例</span>
          <n-input-number v-model:value="backtestRatio" size="small" :min="0" :max="50" :precision="2"
            :show-button="true" />
          <span>%</span>
          <n-text depth="3">按每个打分人的实际下发数随机复制任务，回测任务只在管理端标记。</n-text>
        </div>
        <div class="task-allocation-toolbar">
          <div class="task-allocation-toolbar-group">
            <n-button size="small" secondary :disabled="!taskScorers.length" @click="selectAllTaskScorers">全选</n-button>
            <n-button size="small" secondary :disabled="!selectedTaskScorerCount"
              @click="clearTaskScorerSelection">清空</n-button>
            <n-button size="small" type="primary" secondary :disabled="!selectedTaskScorerCount"
              @click="distributeEvenly">平均分配</n-button>
          </div>
          <div class="task-allocation-fixed">
            <span>每人</span>
            <n-input-number v-model:value="perScorerTaskCount" size="small" :min="1" :max="maxAssignableTaskCount"
              :show-button="true" />
            <span>个</span>
            <n-button size="small" secondary :disabled="!selectedTaskScorerCount"
              @click="assignFixedTaskCount">分配</n-button>
          </div>
          <n-upload :show-file-list="false"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            :custom-request="importAllocationSheet" :disabled="!taskScorers.length || allocationImporting">
            <n-button size="small" secondary :loading="allocationImporting"
              :disabled="!taskScorers.length">读取分配表</n-button>
          </n-upload>
        </div>
        <n-alert v-if="allocationImportFeedback" class="task-allocation-import-result" :type="allocationFeedbackType"
          :show-icon="false">
          <div>
            <strong>{{ allocationImportFeedback.filename }}</strong>
            已读取 {{ allocationImportFeedback.parsedCount }} 行，匹配 {{ allocationImportFeedback.appliedCount }} 人，合计
            {{ allocationImportFeedback.totalTaskCount }} 个任务
          </div>
          <div v-if="allocationImportFeedback.ignoredCount">
            未匹配 {{ allocationImportFeedback.ignoredCount }} 人：{{ allocationImportFeedback.ignoredScorers.slice(0,
              6).join('、') }}
          </div>
          <div v-if="allocationImportFeedback.invalidCount">
            无效行 {{ allocationImportFeedback.invalidCount }} 条：{{ allocationImportFeedback.errors.slice(0, 3).join('；') }}
          </div>
          <div v-if="allocationImportFeedback.overflow">
            超出可下发任务池 {{ allocationImportFeedback.overflow }} 个，请调整后再创建任务
          </div>
        </n-alert>
        <div v-if="taskScorersLoading" class="task-allocation-empty">正在加载团队成员...</div>
        <div v-else-if="taskScorers.length" class="task-allocation-list" aria-label="按打分人分配任务">
          <div v-for="user in taskScorers" :key="user.id" class="task-allocation-row"
            :class="{ 'is-selected': selectedTaskScorerSet.has(user.username) }">
            <n-checkbox :checked="selectedTaskScorerSet.has(user.username)"
              @update:checked="(checked: boolean) => updateTaskScorerSelected(user.username, checked)" />
            <span class="task-allocation-scorer">{{ user.username }}</span>
            <n-input-number :value="taskAllocations[user.username] ?? 0" :min="0" :max="maxAssignableTaskCount"
              :show-button="true" :disabled="!selectedTaskScorerSet.has(user.username)"
              @update:value="(value: number | null) => updateTaskAllocation(user.username, value)"
              @blur="() => normalizeTaskAllocations(user.username)" />
            <span class="task-allocation-unit">个任务</span>
          </div>
        </div>
        <div v-else class="task-allocation-empty">请选择至少一个含有打分账号的团队。</div>
      </n-form>
      <n-space justify="end">
        <n-button @click="taskModalVisible = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="startTask">创建任务</n-button>
      </n-space>
    </n-modal>
  </div>
</template>
