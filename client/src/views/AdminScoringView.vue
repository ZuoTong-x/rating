<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NTag, useDialog, useMessage, type DataTableColumns, type DataTableRowKey, type UploadFileInfo } from 'naive-ui';
import { imageApi } from '../services/images';
import { useTaskStackStore } from '../stores/taskStack';
import type {
  ScoringManagementSummary,
  ScoringRollbackPreview,
  ScoringSummaryScorer,
  TaskSubmissionModeFilter
} from '../types/image';

const message = useMessage();
const dialog = useDialog();
const taskStack = useTaskStackStore();
const loading = ref(false);
const previewing = ref(false);
const rollbackSubmitting = ref(false);
const scorerRollbackPreviewing = ref(false);
const scorerRollbackSubmitting = ref(false);
const exporting = ref(false);
const riskReportExporting = ref(false);
const projects = ref<Array<{ _id: string; name: string }>>([]);
const scorerOptions = ref<Array<{ label: string; value: string }>>([]);
const scorersLoading = ref(false);
const summary = ref<ScoringManagementSummary | null>(null);
const detailVisible = ref(false);
const detailScorer = ref<ScoringSummaryScorer | null>(null);
const scorerPage = ref(1);
const scorerPageSize = ref(10);
const rollbackVisible = ref(false);
const rollbackPreview = ref<ScoringRollbackPreview | null>(null);
const rollbackFileName = ref('');
const selectedRollbackScorers = ref<string[]>([]);
const scorerRollbackVisible = ref(false);
const scorerRollbackPreview = ref<ScoringRollbackPreview | null>(null);
const rollbackReturnMode = ref<'original' | 'reassign'>('original');
const rollbackRecipientScorers = ref<string[]>([]);
const rollbackRecipientAllocations = ref<Record<string, number | null>>({});
type ScoringRiskFilter = 'high' | 'fast' | 'no_large_image' | 'no_order_change' | 'page_blur';

const filters = reactive({
  scorer: null as string | null,
  projectId: null as string | null,
  submissionMode: null as TaskSubmissionModeFilter | null,
  riskFilter: null as ScoringRiskFilter | null
});

const submissionModeOptions = [
  { label: '未拖动排序', value: 'direct' },
  { label: '已操作排序', value: 'ranked' },
  { label: '未记录', value: 'untracked' }
];

const riskFilterOptions = [
  { label: '高风险', value: 'high' },
  { label: '提交过快', value: 'fast' },
  { label: '未看大图', value: 'no_large_image' },
  { label: '排序未变化', value: 'no_order_change' },
  { label: '频繁切页', value: 'page_blur' }
];

const projectOptions = computed(() => projects.value.map(project => ({
  label: project.name,
  value: project._id
})));

const hasFilters = computed(() => Boolean(filters.scorer || filters.projectId || filters.submissionMode || filters.riskFilter));
const rollbackUsesRecipients = computed(() => rollbackReturnMode.value === 'reassign');
const selectedRollbackScorerSet = computed(() => new Set(selectedRollbackScorers.value));
const rollbackRecipientOptions = computed(() => scorerOptions.value.filter(option =>
  !selectedRollbackScorerSet.value.has(option.value)
));
const rollbackRecipientAllocationTotal = computed(() => rollbackRecipientScorers.value.reduce(
  (total, scorer) => total + Math.max(0, Math.floor(Number(rollbackRecipientAllocations.value[scorer]) || 0)),
  0
));
const rollbackRecipientRemaining = computed(() => Math.max(
  (scorerRollbackPreview.value?.rollbackTaskCount || 0) - rollbackRecipientAllocationTotal.value,
  0
));
const rollbackRecipientOverflow = computed(() => Math.max(
  rollbackRecipientAllocationTotal.value - (scorerRollbackPreview.value?.rollbackTaskCount || 0),
  0
));
const rollbackRecipientAllocationValid = computed(() => Boolean(
  scorerRollbackPreview.value?.rollbackTaskCount &&
  rollbackRecipientScorers.value.length &&
  rollbackRecipientAllocationTotal.value === scorerRollbackPreview.value.rollbackTaskCount
));
const scorerRollbackReady = computed(() => Boolean(
  scorerRollbackPreview.value?.rollbackTaskCount &&
  (!rollbackUsesRecipients.value || rollbackRecipientAllocationValid.value)
));
const detailRiskConclusion = computed(() => {
  const scorer = detailScorer.value;
  if (!scorer) return { type: 'default' as const, title: '', text: '' };
  if (!scorer.behaviorTrackedCount) {
    return {
      type: 'default' as const,
      title: '暂无行为样本',
      text: '当前打分记录没有可用于行为风险判断的采集数据。'
    };
  }
  if (scorer.averageRiskScore >= 60 || scorer.highRiskRate >= 0.2) {
    return {
      type: 'error' as const,
      title: '高风险',
      text: `平均风险分 ${formatRiskScore(scorer.averageRiskScore)}，高风险任务占行为样本 ${formatPercent(scorer.highRiskRate)}，建议复核。`
    };
  }
  if (
    scorer.fastSubmitRate >= 0.1 ||
    scorer.noLargeImageRate >= 0.5 ||
    scorer.orderUnchangedRate >= 0.5
  ) {
    return {
      type: 'warning' as const,
      title: '需要关注',
      text: `存在提交过快、未查看大图或排序未变化行为，建议结合任务抽查。`
    };
  }
  return {
    type: 'success' as const,
    title: '行为正常',
    text: '当前已采集行为未发现明显异常集中趋势。'
  };
});
const scorerRollbackScopeText = computed(() => {
  const parts = [];
  if (filters.projectId) {
    parts.push(projects.value.find(project => project._id === filters.projectId)?.name || '当前项目');
  }
  if (filters.submissionMode) parts.push(submissionModeLabel(filters.submissionMode));
  if (filters.riskFilter) parts.push(riskFilterLabel(filters.riskFilter));
  return parts.length ? `范围：${parts.join(' / ')}` : '范围：全部项目和提交方式';
});
const riskReportScopeText = computed(() => {
  const parts = [];
  if (filters.projectId) {
    parts.push(projects.value.find(project => project._id === filters.projectId)?.name || '当前项目');
  }
  if (filters.submissionMode) parts.push(submissionModeLabel(filters.submissionMode));
  return parts.length ? `范围：${parts.join(' / ')}` : '范围：全部项目和提交方式';
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatPercent(value: number) {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '-';
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} 分 ${rest} 秒`;
}

function submissionModeLabel(mode: TaskSubmissionModeFilter | null | undefined) {
  if (mode === 'direct') return '未拖动排序';
  if (mode === 'ranked') return '已操作排序';
  return '未记录';
}

function riskTagType(score: number) {
  if (score >= 60) return 'error';
  if (score >= 30) return 'warning';
  return 'success';
}

function formatRiskScore(score: number | null | undefined) {
  return Math.round(Number(score || 0));
}

function riskFilterLabel(value: ScoringRiskFilter | null | undefined) {
  return riskFilterOptions.find(option => option.value === value)?.label || '';
}

function taskIdFromItem(item: unknown) {
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  return String(record.id ?? record.taskId ?? record._id ?? '').trim();
}

function extractTaskIdsFromJson(payload: unknown) {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.taskIds)
      ? record.taskIds
      : Array.isArray(record?.ids)
        ? record.ids
        : Array.isArray(record?.tasks)
          ? record.tasks
          : Array.isArray(record?.rows)
            ? record.rows
            : [];
  const taskIds = [...new Set(source.map(taskIdFromItem).filter(Boolean))];
  if (!taskIds.length) throw new Error('JSON 中未找到可回退的任务 ID');
  return taskIds;
}

async function loadOptions() {
  scorersLoading.value = true;
  try {
    const result = await imageApi.adminScoringOptions();
    projects.value = result.projects;
    scorerOptions.value = result.scorers.map(scorer => ({
      label: scorer,
      value: scorer
    }));
  } finally {
    scorersLoading.value = false;
  }
}

async function loadSummary(page = scorerPage.value, pageSize = scorerPageSize.value) {
  loading.value = true;
  try {
    summary.value = await imageApi.adminScoringSummary({
      page,
      pageSize,
      scorer: filters.scorer,
      projectId: filters.projectId,
      submissionMode: filters.submissionMode,
      riskFilter: filters.riskFilter
    });
    scorerPage.value = summary.value.page;
    scorerPageSize.value = summary.value.pageSize;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function reloadSummary() {
  await loadSummary();
  if (detailVisible.value && detailScorer.value) {
    const nextScorer = summary.value?.scorers.find(item => item.scorer === detailScorer.value?.scorer);
    detailScorer.value = nextScorer || detailScorer.value;
  }
}

async function exportScoringOperations() {
  exporting.value = true;
  let taskId = '';
  try {
    taskId = taskStack.addTask({
      kind: 'export',
      title: '导出打分操作记录',
      description: hasFilters.value ? '按当前筛选条件导出 JSON' : '导出全部打分操作 JSON',
      stage: '正在提交导出作业',
      progress: 0
    });
    await imageApi.exportScoringOperations({
      scorer: filters.scorer,
      projectId: filters.projectId,
      submissionMode: filters.submissionMode,
      riskFilter: filters.riskFilter
    }, {
      onProgress: job => taskStack.updateTask(taskId, {
        progress: job.progress,
        stage: job.stage || '正在导出打分操作记录'
      })
    });
    taskStack.finishTask(taskId);
    message.success('打分操作 JSON 已导出');
  } catch (error) {
    if (taskId) taskStack.failTask(taskId, error);
    message.error(errorMessage(error));
  } finally {
    exporting.value = false;
  }
}

async function exportScoringRiskReport() {
  if (!selectedRollbackScorers.value.length) {
    message.error('请先勾选需要导出风险报告的打分人');
    return;
  }
  riskReportExporting.value = true;
  let taskId = '';
  try {
    taskId = taskStack.addTask({
      kind: 'export',
      title: '导出打分风险报告',
      description: `${selectedRollbackScorers.value.length} 位打分人 / ${riskReportScopeText.value}`,
      stage: '正在提交导出作业',
      progress: 0
    });
    await imageApi.exportScoringRiskReport({
      scorers: selectedRollbackScorers.value,
      projectId: filters.projectId,
      submissionMode: filters.submissionMode
    }, {
      onProgress: job => taskStack.updateTask(taskId, {
        progress: job.progress,
        stage: job.stage || '正在导出打分风险报告'
      })
    });
    taskStack.finishTask(taskId);
    message.success('打分风险报告 JSON 已导出');
  } catch (error) {
    if (taskId) taskStack.failTask(taskId, error);
    message.error(errorMessage(error));
  } finally {
    riskReportExporting.value = false;
  }
}

function applyFilters() {
  selectedRollbackScorers.value = [];
  scorerPage.value = 1;
  void reloadSummary();
}

function resetFilters() {
  filters.scorer = null;
  filters.projectId = null;
  filters.submissionMode = null;
  filters.riskFilter = null;
  selectedRollbackScorers.value = [];
  scorerPage.value = 1;
  void reloadSummary();
}

function changeScorerPage(page: number) {
  void loadSummary(page, scorerPageSize.value);
}

function changeScorerPageSize(pageSize: number) {
  void loadSummary(1, pageSize);
}

function scorerPaginationPrefix({ itemCount }: { itemCount?: number }) {
  return `共 ${itemCount ?? summary?.value?.scorerCount ?? 0} 位打分人`;
}

function scorerRowKey(row: ScoringSummaryScorer) {
  return row.scorer;
}

function updateSelectedRollbackScorers(keys: DataTableRowKey[]) {
  selectedRollbackScorers.value = keys.map(key => String(key));
}

function updateRollbackRecipientScorers(scorers: string[]) {
  const next = new Set(scorers);
  rollbackRecipientScorers.value = rollbackRecipientOptions.value
    .map(option => option.value)
    .filter(scorer => next.has(scorer));
  rollbackRecipientAllocations.value = Object.fromEntries(rollbackRecipientScorers.value.map(scorer => [
    scorer,
    rollbackRecipientAllocations.value[scorer] ?? 0
  ]));
}

function updateRollbackRecipientAllocation(scorer: string, value: number | null) {
  rollbackRecipientAllocations.value = {
    ...rollbackRecipientAllocations.value,
    [scorer]: Math.max(0, Math.floor(Number(value) || 0))
  };
}

function distributeRollbackRecipientsEvenly() {
  const total = scorerRollbackPreview.value?.rollbackTaskCount || 0;
  const recipients = rollbackRecipientScorers.value;
  if (!total || !recipients.length) return;
  const base = Math.floor(total / recipients.length);
  const remainder = total % recipients.length;
  rollbackRecipientAllocations.value = Object.fromEntries(recipients.map((scorer, index) => [
    scorer,
    base + (index < remainder ? 1 : 0)
  ]));
}

function rollbackAllocationPayload() {
  return rollbackRecipientScorers.value
    .map(scorer => ({
      scorer,
      taskCount: Math.max(0, Math.floor(Number(rollbackRecipientAllocations.value[scorer]) || 0))
    }))
    .filter(item => item.taskCount > 0);
}

async function openScorerRollback() {
  if (!selectedRollbackScorers.value.length) {
    message.error('请先勾选需要全量回退的打分人');
    return;
  }
  scorerRollbackPreviewing.value = true;
  scorerRollbackPreview.value = null;
  rollbackReturnMode.value = 'original';
  rollbackRecipientScorers.value = [];
  rollbackRecipientAllocations.value = {};
  try {
    const preview = await imageApi.previewScoringRollback({
      source: 'scorer_full',
      scorers: selectedRollbackScorers.value,
      projectId: filters.projectId,
      submissionMode: filters.submissionMode
    });
    if (!preview.rollbackTaskCount) {
      message.warning('所选打分人没有可回退的已完成任务');
      return;
    }
    scorerRollbackPreview.value = preview;
    scorerRollbackVisible.value = true;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    scorerRollbackPreviewing.value = false;
  }
}

function openScorerDetails(row: ScoringSummaryScorer) {
  detailScorer.value = row;
  detailVisible.value = true;
}

function closeScorerDetails() {
  detailVisible.value = false;
  detailScorer.value = null;
}

function wait(milliseconds: number) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function waitForRollback(jobId: string, taskId: string) {
  while (true) {
    const job = await imageApi.scoringRollbackStatus(jobId);
    taskStack.updateTask(taskId, {
      progress: job.progress,
      stage: job.stage || '正在回退任务'
    });
    if (job.status === 'completed') {
      const result = job.result;
      if (!result) throw new Error('任务回退完成，但没有返回结果');
      const reassignedText = result.reassignedTaskCount ? `，已分配给承接人 ${result.reassignedTaskCount} 个` : '';
      taskStack.finishTask(taskId, {
        stage: '任务回退完成',
        description: `已回退 ${result.rolledBackTaskCount} 个任务${reassignedText}`
      });
      message.success(`已回退 ${result.rolledBackTaskCount} 个任务${reassignedText}`);
      await reloadSummary();
      return;
    }
    if (job.status === 'failed') {
      throw new Error(job.message || '任务回退失败');
    }
    await wait(800);
  }
}

async function handleRollbackFileChange(options: { file: UploadFileInfo }) {
  const file = options.file.file;
  if (!file) return;
  rollbackPreview.value = null;
  rollbackFileName.value = file.name;
  previewing.value = true;
  try {
    const payload = JSON.parse(await file.text()) as unknown;
    const taskIds = extractTaskIdsFromJson(payload);
    rollbackPreview.value = await imageApi.previewScoringRollback({ taskIds });
    rollbackVisible.value = true;
  } catch (error) {
    rollbackFileName.value = '';
    message.error(errorMessage(error));
  } finally {
    previewing.value = false;
  }
}

function confirmRollback() {
  const preview = rollbackPreview.value;
  if (!preview || !preview.taskIds.length) {
    message.error('没有可回退的任务');
    return;
  }
  dialog.warning({
    title: '确认回退任务',
    content: `将回退 ${preview.rollbackTaskCount} 个已完成任务，涉及 ${preview.scorers.length} 个打分人。回退后任务会重新出现在原打分人的任务列表中。`,
    positiveText: '确认回退',
    negativeText: '取消',
    onPositiveClick: async () => {
      rollbackSubmitting.value = true;
      let taskId = '';
      try {
        taskId = taskStack.addTask({
          kind: 'rollback',
          title: '批量回退任务',
          description: `${preview.rollbackTaskCount} 个任务 / ${preview.scorers.length} 个打分人`,
          stage: '正在提交回退作业',
          progress: 0
        });
        const job = await imageApi.rollbackScoringTasks({ taskIds: preview.taskIds });
        rollbackVisible.value = false;
        rollbackPreview.value = null;
        rollbackFileName.value = '';
        taskStack.updateTask(taskId, {
          progress: job.progress,
          stage: job.stage || '等待回退任务'
        });
        void waitForRollback(job.jobId, taskId).catch(error => {
          taskStack.failTask(taskId, error);
          message.error(`批量回退失败：${errorMessage(error)}`);
        });
        message.info('回退作业已提交，可在右下角任务栈查看进度');
      } catch (error) {
        if (taskId) taskStack.failTask(taskId, error);
        message.error(errorMessage(error));
        throw error;
      } finally {
        rollbackSubmitting.value = false;
      }
    }
  });
}

function confirmScorerRollback() {
  const preview = scorerRollbackPreview.value;
  if (!preview || !preview.rollbackTaskCount) {
    message.error('没有可回退的任务');
    return;
  }
  if (rollbackUsesRecipients.value && !rollbackRecipientAllocationValid.value) {
    message.error(`承接数量合计必须等于 ${preview.rollbackTaskCount}`);
    return;
  }
  const allocations = rollbackUsesRecipients.value ? rollbackAllocationPayload() : [];
  dialog.warning({
    title: '确认人员全量回退',
    content: rollbackUsesRecipients.value
      ? `将回退 ${preview.scorers.length} 位打分人的 ${preview.rollbackTaskCount} 个已完成任务，并按设置分配给 ${allocations.length} 位承接人。`
      : `将回退 ${preview.scorers.length} 位打分人的 ${preview.rollbackTaskCount} 个已完成任务，任务会回到原打分人的未完成列表。`,
    positiveText: '确认回退',
    negativeText: '取消',
    onPositiveClick: async () => {
      scorerRollbackSubmitting.value = true;
      let taskId = '';
      try {
        taskId = taskStack.addTask({
          kind: 'rollback',
          title: rollbackUsesRecipients.value ? '人员全量回退并分配' : '人员全量原路回退',
          description: rollbackUsesRecipients.value
            ? `${preview.rollbackTaskCount} 个任务 / ${allocations.length} 位承接人`
            : `${preview.rollbackTaskCount} 个任务 / 原路返回`,
          stage: '正在提交回退作业',
          progress: 0
        });
        const job = await imageApi.rollbackScoringTasks({
          source: 'scorer_full',
          scorers: preview.sourceScorers?.length ? preview.sourceScorers : selectedRollbackScorers.value,
          projectId: preview.projectId ?? filters.projectId,
          submissionMode: preview.submissionMode ?? filters.submissionMode,
          returnMode: rollbackReturnMode.value,
          allocations
        });
        scorerRollbackVisible.value = false;
        scorerRollbackPreview.value = null;
        rollbackReturnMode.value = 'original';
        rollbackRecipientScorers.value = [];
        rollbackRecipientAllocations.value = {};
        selectedRollbackScorers.value = [];
        taskStack.updateTask(taskId, {
          progress: job.progress,
          stage: job.stage || '等待回退任务'
        });
        void waitForRollback(job.jobId, taskId).catch(error => {
          taskStack.failTask(taskId, error);
          message.error(`人员全量回退失败：${errorMessage(error)}`);
        });
        message.info('人员全量回退作业已提交，可在右下角任务栈查看进度');
      } catch (error) {
        if (taskId) taskStack.failTask(taskId, error);
        message.error(errorMessage(error));
        throw error;
      } finally {
        scorerRollbackSubmitting.value = false;
      }
    }
  });
}

const scorerColumns: DataTableColumns<ScoringSummaryScorer> = [
  { type: 'selection', width: 52 },
  { title: '打分人', key: 'scorer', minWidth: 180 },
  { title: '涉及项目', key: 'projectCount', width: 110 },
  { title: '完成任务', key: 'totalTaskCount', width: 120 },
  {
    title: '未拖动排序',
    key: 'undraggedSubmitCount',
    width: 170,
    render: row => h('div', { class: 'scoring-inline-tags' }, [
      h(NTag, {
        size: 'small',
        type: row.undraggedSubmitCount ? 'error' : 'default',
        bordered: false
      }, { default: () => formatNumber(row.undraggedSubmitCount) }),
      h('span', { class: 'table-muted' }, formatPercent(row.undraggedSubmitRate))
    ])
  },
  { title: '已操作排序', key: 'rankedSubmitCount', width: 120 },
  {
    title: '点击大图',
    key: 'largeImageOpenedCount',
    width: 140,
    render: row => h('div', { class: 'scoring-inline-tags' }, [
      h(NTag, {
        size: 'small',
        type: row.largeImageOpenedCount ? 'info' : 'default',
        bordered: false
      }, { default: () => formatNumber(row.largeImageOpenedCount) }),
      h('span', { class: 'table-muted' }, formatPercent(row.largeImageOpenedRate))
    ])
  },
  {
    title: '行为风险',
    key: 'averageRiskScore',
    width: 120,
    render: row => !row.behaviorTrackedCount
      ? h('span', { class: 'table-muted' }, '暂无样本')
      : h(NTag, {
      size: 'small',
      type: riskTagType(row.averageRiskScore),
      bordered: false
    }, { default: () => `${formatRiskScore(row.averageRiskScore)} / ${formatNumber(row.highRiskCount)}` })
  },
  {
    title: '过快提交',
    key: 'fastSubmitCount',
    width: 120,
    render: row => h('div', { class: 'scoring-inline-tags' }, [
      h(NTag, {
        size: 'small',
        type: row.fastSubmitCount ? 'warning' : 'default',
        bordered: false
      }, { default: () => formatNumber(row.fastSubmitCount) }),
      h('span', { class: 'table-muted' }, formatPercent(row.fastSubmitRate))
    ])
  },
  {
    title: '平均打分时间',
    key: 'averageDurationSeconds',
    width: 150,
    render: row => formatDuration(row.averageDurationSeconds)
  },
  { title: '回退次数', key: 'rollbackCount', width: 110 },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    fixed: 'right',
    render: row => h(NButton, {
      size: 'small',
      secondary: true,
      onClick: () => openScorerDetails(row)
    }, { default: () => '详情' })
  }
];

async function initialize() {
  try {
    await loadOptions();
  } catch (error) {
    message.error(errorMessage(error));
  }
  await loadSummary();
}

onMounted(() => void initialize());
</script>

<template>
  <div class="admin-page admin-account-content admin-scoring-content">
    <div class="table-shell account-table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>打分管理</strong>
          <n-text depth="3">共 {{ summary?.scorerCount || 0 }} 位打分人</n-text>
        </div>
        <div class="table-shell-header-actions">
          <n-button type="error" secondary :loading="scorerRollbackPreviewing" :disabled="!selectedRollbackScorers.length"
            @click="openScorerRollback">
            人员全量回退
          </n-button>
          <n-button type="warning" secondary :loading="riskReportExporting" :disabled="!selectedRollbackScorers.length"
            @click="exportScoringRiskReport">
            导出风险报告
          </n-button>
          <n-button type="primary" secondary :loading="exporting" @click="exportScoringOperations">
            导出 JSON
          </n-button>
          <n-upload accept=".json,application/json" :default-upload="false" :show-file-list="false"
            @change="handleRollbackFileChange" style="width:100px">
            <n-button type="warning" secondary :loading="previewing">批量回退</n-button>
          </n-upload>
        </div>
      </div>

      <div class="account-filter-bar scoring-account-filter-bar">
        <n-select v-model:value="filters.scorer" clearable filterable :loading="scorersLoading" :options="scorerOptions"
          placeholder="按打分人筛选" />
        <n-select v-model:value="filters.projectId" clearable filterable :options="projectOptions" placeholder="按项目筛选" />
        <n-select v-model:value="filters.submissionMode" clearable :options="submissionModeOptions"
          placeholder="按提交方式筛选" />
        <n-select v-model:value="filters.riskFilter" clearable :options="riskFilterOptions" placeholder="风险筛选" />
        <div class="account-filter-actions">
          <n-button type="primary" @click="applyFilters">查询</n-button>
          <n-button :disabled="!hasFilters" @click="resetFilters">重置</n-button>
        </div>
      </div>

      <div class="account-table-body">
        <n-data-table v-if="summary?.scorers.length" class="account-data-table" :columns="scorerColumns"
          :data="summary.scorers" :loading="loading" :bordered="false" :scroll-x="1100"
          :row-key="scorerRowKey" :checked-row-keys="selectedRollbackScorers"
          @update:checked-row-keys="updateSelectedRollbackScorers" />
        <div v-else class="empty">
          {{ loading ? '正在加载...' : (hasFilters ? '没有符合条件的打分人' : '暂无打分记录') }}
        </div>
      </div>
      <div class="account-table-footer">
        <n-pagination v-if="summary?.scorerCount" :page="scorerPage" :page-size="scorerPageSize"
          :item-count="summary.scorerCount" show-size-picker :page-sizes="[10, 20, 50, 100]"
          :prefix="scorerPaginationPrefix" @update:page="changeScorerPage"
          @update:page-size="changeScorerPageSize" />
      </div>
    </div>

    <n-modal v-model:show="detailVisible" preset="card" class="scoring-detail-modal" :bordered="false"
      :title="detailScorer ? `${detailScorer.scorer} 的打分详情` : '打分详情'" @after-leave="closeScorerDetails">
      <template v-if="detailScorer">
        <div class="scoring-detail-summary">
          <div>
            <span>涉及项目</span>
            <strong>{{ formatNumber(detailScorer.projectCount) }}</strong>
          </div>
          <div>
            <span>完成任务</span>
            <strong>{{ formatNumber(detailScorer.totalTaskCount) }}</strong>
          </div>
          <div>
            <span>未拖动排序</span>
            <strong class="is-danger">{{ formatNumber(detailScorer.undraggedSubmitCount) }}</strong>
          </div>
          <div>
            <span>点击大图</span>
            <strong>{{ formatNumber(detailScorer.largeImageOpenedCount) }}</strong>
          </div>
          <div>
            <span>平均打分时间</span>
            <strong>{{ formatDuration(detailScorer.averageDurationSeconds) }}</strong>
          </div>
          <div>
            <span>高风险任务</span>
            <strong class="is-danger">{{ formatNumber(detailScorer.highRiskCount) }}</strong>
          </div>
          <div>
            <span>平均风险分</span>
            <strong>{{ detailScorer.behaviorTrackedCount ? formatRiskScore(detailScorer.averageRiskScore) : '-' }}</strong>
          </div>
        </div>
        <div class="scoring-detail-conclusion">
          <div class="scoring-detail-conclusion-header">
            <span>行为结论</span>
            <n-tag :type="detailRiskConclusion.type" size="small" :bordered="false">
              {{ detailRiskConclusion.title }}
            </n-tag>
          </div>
          <n-text depth="3">{{ detailRiskConclusion.text }}</n-text>
          <div v-if="detailScorer.behaviorTrackedCount" class="scoring-detail-rates">
            <span>过快提交 {{ formatPercent(detailScorer.fastSubmitRate) }}</span>
            <span>未看大图 {{ formatPercent(detailScorer.noLargeImageRate) }}</span>
            <span>排序未变化 {{ formatPercent(detailScorer.orderUnchangedRate) }}</span>
            <span>频繁切页 {{ formatNumber(detailScorer.pageBlurCountTotal ?? 0) }} 次</span>
          </div>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="rollbackVisible" preset="card" class="scoring-rollback-modal" :bordered="false" title="批量回退任务">
      <div v-if="rollbackPreview" class="scoring-rollback-body">
        <div class="scoring-rollback-summary">
          <n-text depth="3">{{ rollbackFileName || '已读取任务 JSON' }}</n-text>
          <n-tag size="small" type="success" :bordered="false">可回退 {{ rollbackPreview.rollbackTaskCount }} 个</n-tag>
          <n-tag size="small" type="warning" :bordered="false">忽略 {{ rollbackPreview.ignoredTaskCount }} 个</n-tag>
          <n-button type="warning" :loading="rollbackSubmitting" :disabled="!rollbackPreview.taskIds.length"
            @click="confirmRollback">
            确认回退
          </n-button>
        </div>

        <div class="scoring-rollback-overview">
          <div>
            <span>涉及打分人</span>
            <strong>{{ rollbackPreview.scorers.length }} 人</strong>
          </div>
          <div>
            <span>涉及任务</span>
            <strong>{{ rollbackPreview.rollbackTaskCount }} 个</strong>
          </div>
        </div>

        <n-text v-if="rollbackPreview.scorers.length" depth="3">
          {{ rollbackPreview.scorers.map(item => `${item.name}：${item.taskCount} 个`).join('，') }}
        </n-text>
      </div>
    </n-modal>

    <n-modal v-model:show="scorerRollbackVisible" preset="card" class="scoring-rollback-modal" :bordered="false"
      title="人员全量回退">
      <div v-if="scorerRollbackPreview" class="scoring-rollback-body">
        <div class="scoring-rollback-summary">
          <n-text depth="3">{{ scorerRollbackScopeText }}</n-text>
          <n-tag size="small" type="success" :bordered="false">可回退 {{ scorerRollbackPreview.rollbackTaskCount }} 个</n-tag>
          <n-tag size="small" type="info" :bordered="false">来源 {{ scorerRollbackPreview.scorers.length }} 人</n-tag>
          <n-tag v-if="rollbackUsesRecipients" size="small" type="warning" :bordered="false">
            承接 {{ rollbackRecipientAllocationTotal }} 个
          </n-tag>
          <n-tag v-else size="small" type="warning" :bordered="false">原路返回</n-tag>
        </div>

        <div class="scoring-rollback-mode">
          <span class="scoring-rollback-mode-label">回退方式</span>
          <n-radio-group v-model:value="rollbackReturnMode" size="small" button-style="solid">
            <n-radio-button value="original">原路返回</n-radio-button>
            <n-radio-button value="reassign">分配承接人</n-radio-button>
          </n-radio-group>
          <n-text depth="3" class="scoring-rollback-mode-help">
            {{ rollbackUsesRecipients ? '回退后随机分配给承接人继续处理' : '回退后任务仍归属原打分人，回到其未完成列表' }}
          </n-text>
        </div>

        <div class="scoring-rollback-overview">
          <div>
            <span>回退人员</span>
            <strong>{{ scorerRollbackPreview.scorers.length }} 人</strong>
          </div>
          <div>
            <span>回退任务</span>
            <strong>{{ formatNumber(scorerRollbackPreview.rollbackTaskCount) }} 个</strong>
          </div>
        </div>

        <n-text v-if="scorerRollbackPreview.scorers.length" depth="3">
          {{ scorerRollbackPreview.scorers.map(item => `${item.name}：${formatNumber(item.taskCount)} 个`).join('，') }}
        </n-text>

        <n-form v-if="rollbackUsesRecipients" label-placement="top">
          <n-form-item label="承接人">
            <n-select :value="rollbackRecipientScorers" multiple filterable :options="rollbackRecipientOptions"
              placeholder="选择承接回退任务的打分人" @update:value="updateRollbackRecipientScorers" />
          </n-form-item>
          <div v-if="rollbackRecipientScorers.length" class="scoring-rollback-assignee-list">
            <div v-for="scorer in rollbackRecipientScorers" :key="scorer" class="scoring-rollback-assignee-row">
              <span>{{ scorer }}</span>
              <n-input-number :value="rollbackRecipientAllocations[scorer] ?? 0" :min="0"
                :max="scorerRollbackPreview.rollbackTaskCount" :show-button="true"
                @update:value="(value: number | null) => updateRollbackRecipientAllocation(scorer, value)" />
              <span>个任务</span>
            </div>
          </div>
        </n-form>

        <div class="scoring-rollback-summary">
          <n-text v-if="!rollbackUsesRecipients" type="warning">
            将原路回退 {{ formatNumber(scorerRollbackPreview.rollbackTaskCount) }} 个任务
          </n-text>
          <n-text v-else-if="rollbackRecipientRemaining" type="warning">
            还需分配 {{ formatNumber(rollbackRecipientRemaining) }} 个
          </n-text>
          <n-text v-else-if="rollbackRecipientOverflow" type="error">
            超出 {{ formatNumber(rollbackRecipientOverflow) }} 个
          </n-text>
          <n-text v-else type="success">承接数量已对齐</n-text>
          <n-button v-if="rollbackUsesRecipients" secondary :disabled="!rollbackRecipientScorers.length"
            @click="distributeRollbackRecipientsEvenly">
            平均承接
          </n-button>
          <n-button type="error" :loading="scorerRollbackSubmitting" :disabled="!scorerRollbackReady"
            @click="confirmScorerRollback">
            {{ rollbackUsesRecipients ? '确认回退并分配' : '确认原路回退' }}
          </n-button>
        </div>
      </div>
    </n-modal>
  </div>
</template>
