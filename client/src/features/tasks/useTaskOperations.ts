import { computed, reactive, ref, watch, type Ref } from 'vue';
import { useMessage } from 'naive-ui';
import { taskApi } from '../../services/tasks';
import { useTaskStackStore } from '../../stores/taskStack';
import type { ProjectItem, SubjectItem, SubjectTaskReport } from '../../types/image';

interface TaskOperationsOptions {
  projectId: string;
  project: Ref<ProjectItem | null>;
  subject: Ref<SubjectItem | null>;
  taskPageSize: Ref<number>;
  loadTasks: (page: number, pageSize: number) => Promise<void>;
  loadTaskOptions: () => Promise<void>;
}

export function useTaskOperations({ projectId, project, subject, taskPageSize, loadTasks, loadTaskOptions }: TaskOperationsOptions) {
  const message = useMessage();
  const taskStack = useTaskStackStore();
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求失败';
  const reassignmentVisible = ref(false);
  const reportVisible = ref(false);
  const reportLoading = ref(false);
  const reportExporting = ref(false);
  const report = ref<SubjectTaskReport | null>(null);
  const reassignmentOptionsLoading = ref(false);
  const reassignmentSubmitting = ref(false);
  const availableScorers = ref<Array<{ id: string; username: string }>>([]);
  const sourceScorers = ref<Array<{ username: string; taskCount: number }>>([]);
  const availableTaskCount = ref(0);
  const reassignmentForm = reactive({
    scorers: [] as string[],
    allocations: {} as Record<string, number | null>,
    sourceScorers: [] as string[],
    taskCount: null as number | null,
    source: 'assigned_uncompleted' as 'assigned_uncompleted' | 'selected_scorers'
  });

  const availableScorerOptions = computed(() => availableScorers.value.map(user => ({
    label: user.username,
    value: user.username
  })));
  const sourceScorerOptions = computed(() => sourceScorers.value.map(item => ({
    label: `${item.username}（${item.taskCount} 个未完成）`,
    value: item.username
  })));
  const reassignmentSourceOptions = [
    { label: '从全部未完成任务中按总数分配', value: 'assigned_uncompleted' },
    { label: '从指定已分配打分人领取任务', value: 'selected_scorers' }
  ];
  const sourceTaskCountMax = computed(() => {
    if (reassignmentForm.source !== 'selected_scorers') return availableTaskCount.value;
    if (!reassignmentForm.sourceScorers.length) return 0;
    const counts = reassignmentForm.sourceScorers
      .map(username => sourceScorers.value.find(item => item.username === username)?.taskCount || 0)
      .filter(count => count > 0);
    return counts.length === reassignmentForm.sourceScorers.length ? Math.min(...counts) : 0;
  });
  const selectedReassignmentTaskTotal = computed(() => {
    if (reassignmentForm.source === 'assigned_uncompleted') {
      return reassignmentForm.scorers.reduce(
        (total, scorer) => total + Math.max(0, Math.floor(Number(reassignmentForm.allocations[scorer]) || 0)),
        0
      );
    }
    if (!reassignmentForm.taskCount) return 0;
    return reassignmentForm.source === 'selected_scorers'
      ? reassignmentForm.taskCount * reassignmentForm.sourceScorers.length
      : reassignmentForm.taskCount;
  });

  function updateReassignmentScorers(scorers: string[]) {
    const nextAllocations: Record<string, number | null> = {};
    scorers.forEach(scorer => {
      nextAllocations[scorer] = reassignmentForm.allocations[scorer] ?? 0;
    });
    reassignmentForm.scorers = scorers;
    reassignmentForm.allocations = nextAllocations;
  }

  function updateReassignmentAllocation(scorer: string, value: number | null) {
    reassignmentForm.allocations = {
      ...reassignmentForm.allocations,
      [scorer]: Math.max(0, Math.floor(Number(value) || 0))
    };
  }

  function normalizeReassignmentAllocations(editedScorer: string) {
    const next = Object.fromEntries(reassignmentForm.scorers.map(scorer => [
      scorer,
      Math.min(availableTaskCount.value, Math.max(0, Math.floor(Number(reassignmentForm.allocations[scorer]) || 0)))
    ])) as Record<string, number>;
    let overflow = Object.values(next).reduce((total, count) => total + count, 0) - availableTaskCount.value;
    if (overflow <= 0) {
      reassignmentForm.allocations = next;
      return;
    }

    const otherScorers = reassignmentForm.scorers
      .filter(scorer => scorer !== editedScorer)
      .sort((left, right) => next[right] - next[left]);
    for (const scorer of otherScorers) {
      if (overflow <= 0) break;
      const reduction = Math.min(next[scorer], overflow);
      next[scorer] -= reduction;
      overflow -= reduction;
    }
    if (overflow > 0) next[editedScorer] = Math.max(0, next[editedScorer] - overflow);
    reassignmentForm.allocations = next;
  }

  async function openTaskReassignment() {
    reassignmentVisible.value = true;
    reassignmentOptionsLoading.value = true;
    reassignmentForm.scorers = [];
    reassignmentForm.allocations = {};
    reassignmentForm.sourceScorers = [];
    reassignmentForm.taskCount = null;
    reassignmentForm.source = 'assigned_uncompleted';
    try {
      const result = await taskApi.projectTaskReassignmentOptions(projectId);
      availableScorers.value = result.users;
      sourceScorers.value = result.sourceScorers;
      availableTaskCount.value = result.availableTaskCount;
      reassignmentForm.taskCount = result.availableTaskCount ? 1 : null;
    } catch (error) {
      message.error(errorMessage(error));
      reassignmentVisible.value = false;
    } finally {
      reassignmentOptionsLoading.value = false;
    }
  }

  async function submitTaskReassignment() {
    const allocations = reassignmentForm.source === 'assigned_uncompleted'
      ? reassignmentForm.scorers.map(scorer => ({
        scorer,
        taskCount: Math.max(0, Math.floor(Number(reassignmentForm.allocations[scorer]) || 0))
      }))
      : undefined;
    const taskCount = allocations
      ? allocations.reduce((total, allocation) => total + allocation.taskCount, 0)
      : reassignmentForm.taskCount;
    if (!reassignmentForm.scorers.length) {
      message.error('请选择打分账号');
      return;
    }
    if (reassignmentForm.source === 'selected_scorers' && !reassignmentForm.sourceScorers.length) {
      message.error('请选择已分配打分人');
      return;
    }
    if (!taskCount || taskCount > sourceTaskCountMax.value) {
      message.error(`每个来源打分人的任务数量不能超过 ${sourceTaskCountMax.value}`);
      return;
    }
    if (selectedReassignmentTaskTotal.value < reassignmentForm.scorers.length) {
      message.error('可分配任务数量不能少于所选打分账号数');
      return;
    }

    reassignmentSubmitting.value = true;
    const taskId = taskStack.addTask({
      kind: 'assign',
      title: `重新分配：${project.value?.name || subject.value?.name || '评分任务'}`,
      description: `${reassignmentForm.scorers.length} 个打分人 / ${selectedReassignmentTaskTotal.value} 个任务`,
      stage: '正在重新分配任务',
      progress: 35
    });
    try {
      const result = await taskApi.reassignProjectTasks(projectId, {
        scorers: reassignmentForm.scorers,
        taskCount,
        source: reassignmentForm.source,
        sourceScorers: reassignmentForm.sourceScorers,
        allocations
      });
      taskStack.finishTask(taskId, {
        stage: '任务重新分配完成',
        description: `已重新分配 ${result.reassignedCount} 个任务`
      });
      message.success(`已重新分配 ${result.reassignedCount} 个任务`);
      reassignmentVisible.value = false;
      await Promise.all([loadTasks(1, taskPageSize.value), loadTaskOptions()]);
    } catch (error) {
      taskStack.failTask(taskId, error);
      message.error(errorMessage(error));
    } finally {
      reassignmentSubmitting.value = false;
    }
  }

  async function openTaskReport() {
    reportVisible.value = true;
    reportLoading.value = true;
    try {
      report.value = await taskApi.projectTaskReport(projectId);
    } catch (error) {
      message.error(errorMessage(error));
      reportVisible.value = false;
    } finally {
      reportLoading.value = false;
    }
  }

  async function downloadTaskReport() {
    reportExporting.value = true;
    const taskId = taskStack.addTask({
      kind: 'export',
      title: `导出打分详情：${report.value?.subject.name || project.value?.name || subject.value?.name || '项目'}`,
      stage: '正在生成 Excel',
      progress: 25
    });
    try {
      await taskApi.exportProjectTaskReport(projectId, {
        onProgress: job => taskStack.updateTask(taskId, {
          progress: job.progress,
          stage: job.stage
        })
      });
      taskStack.finishTask(taskId, { stage: 'Excel 已生成', description: '浏览器已开始下载' });
      message.success('打分详情已导出');
    } catch (error) {
      taskStack.failTask(taskId, error);
      message.error(errorMessage(error));
    } finally {
      reportExporting.value = false;
    }
  }

  function reportPercent(value: number) {
    return `${(value * 100).toFixed(1)}%`;
  }

  function reportStatusLabel(status: 'pending' | 'assigned' | 'completed') {
    return { pending: '待分配', assigned: '未完成', completed: '已完成' }[status];
  }

  const reportStatusRows = computed(() => {
    if (!report.value) return [];
    const statuses: Array<'pending' | 'assigned' | 'completed'> = ['pending', 'assigned', 'completed'];
    return statuses.map(status => ({
      status,
      label: reportStatusLabel(status),
      count: report.value!.statusCounts[status],
      rate: report.value!.totalTasks ? report.value!.statusCounts[status] / report.value!.totalTasks : 0
    }));
  });

  watch(() => reassignmentForm.source, source => {
    reassignmentForm.sourceScorers = [];
    if (source === 'selected_scorers') {
      reassignmentForm.taskCount = 1;
      return;
    }
    reassignmentForm.taskCount = availableTaskCount.value
      ? Math.min(reassignmentForm.taskCount || 1, availableTaskCount.value)
      : null;
  });

  return {
    reassignmentVisible, reportVisible, reportLoading, reportExporting, report,
    reassignmentOptionsLoading, reassignmentSubmitting, availableTaskCount,
    reassignmentForm, availableScorerOptions, sourceScorerOptions,
    reassignmentSourceOptions, sourceTaskCountMax, selectedReassignmentTaskTotal,
    updateReassignmentScorers, updateReassignmentAllocation,
    normalizeReassignmentAllocations, openTaskReassignment, submitTaskReassignment,
    openTaskReport, downloadTaskReport, reportPercent, reportStatusRows
  };
}
