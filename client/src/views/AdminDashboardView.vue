<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import type { ChartData, ChartOptions } from 'chart.js';
import BaseChart from '../components/BaseChart.vue';
import { useAppTheme } from '../composables/theme';
import { authApi } from '../services/auth';
import { imageApi } from '../services/images';
import { useTaskStackStore } from '../stores/taskStack';
import type { AccountTeam } from '../types/auth';
import type { AdminDashboard, AdminDashboardCharts, AdminDashboardProjectSection, AdminDashboardStats, AdminDashboardWorkloadSection, ProjectItem } from '../types/image';

type TagType = 'default' | 'success' | 'warning' | 'error' | 'info';
type WorkloadRow = {
  id: string;
  title: string;
  tagLabel: string;
  tagType: TagType;
  totalTaskCount: number;
  pendingTaskCount: number;
  completedTaskCount: number;
  averageDurationSeconds: number | null;
};

const message = useMessage();
const taskStack = useTaskStackStore();
const { isDark } = useAppTheme();
const loading = ref(false);
const exportingProjects = ref(false);
const exportingTeams = ref(false);
const exportingScorers = ref(false);
const dashboardReady = ref(false);
const averageDurationVisible = ref(false);
const averageDurationLoading = ref(false);
const averageDurationLoaded = ref(false);
const selectedProjectId = ref<string | null>(null);
const selectedScorerId = ref<string | null>(null);
const selectedTeamId = ref<string | null>(null);
const exportProjectIds = ref<string[]>([]);
const exportTeamIds = ref<string[]>([]);
const exportScorerIds = ref<string[]>([]);
const exportTeamExcludeInactiveScorers = ref(false);
const exportScorerCompletedRange = ref<[number, number] | null>(null);
const workloadViewMode = ref<'scorer' | 'team'>('scorer');
const projects = ref<ProjectItem[]>([]);
const teams = ref<AccountTeam[]>([]);

function createEmptyDashboard(): AdminDashboard {
  return {
    projectCount: 0,
    completedProjectCount: 0,
    teamCount: 0,
    scorerCount: 0,
    totalTaskCount: 0,
    unassignedTaskCount: 0,
    assignedTaskCount: 0,
    pendingTaskCount: 0,
    completedTaskCount: 0,
    averageDurationSeconds: null,
    selectedProjectId: null,
    projectSummary: null,
    peakHours: [],
    progressSummary: { scorers: [], teams: [] },
    workloadSummary: {
      selectedScorerId: null,
      selectedTeamId: null,
      scorers: [],
      teams: [],
      scorer: null,
      team: null
    },
    total: 0,
    page: 1,
    pageSize: 10,
    tasks: []
  };
}

const dashboard = ref<AdminDashboard>(createEmptyDashboard());

const statIconPaths = {
  project: 'M4 5h6l2 2h8v12H4z M4 5v14',
  'done-project': 'M5 13l4 4L19 7 M4 5h16v14H4z',
  team: 'M8 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zM3 20c0-3 2.5-5 5-5s5 2 5 5M11 20c0-2.5 2.2-4 5-4s5 1.5 5 4',
  scorer: 'M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm-7 8c0-3.314 3.134-6 7-6s7 2.686 7 6',
  task: 'M7 7h10M7 12h10M7 17h7 M5 5h14v14H5z',
  pending: 'M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  completed: 'M9 12l2 2 4-5 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  duration: 'M12 8v4l3 2 M9 2h6 M12 5a8 8 0 1 1-8 8 8 8 0 0 1 8-8z'
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function formatNumber(value: number | null | undefined) {
  return Number(value || 0).toLocaleString();
}

function formatPercent(value: number | null | undefined) {
  return `${Math.round((value || 0) * 100)}%`;
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '暂无';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 0 : 1)} 分钟`;
  const hours = minutes / 60;
  return `${hours.toFixed(hours >= 10 ? 0 : 1)} 小时`;
}

function taskStatusLabel(status: ProjectItem['taskStatus']) {
  return {
    task_pending: '未开始',
    scoring: '打分中',
    task_completed: '已完成'
  }[status] || '未开始';
}

function taskStatusType(status: ProjectItem['taskStatus']): TagType {
  return status === 'task_completed' ? 'success' : status === 'scoring' ? 'warning' : 'default';
}

function statusText(status: string | null | undefined) {
  return status === 'disabled' ? '禁用' : '启用';
}

function statusTagType(status: string | null | undefined): TagType {
  return status === 'disabled' ? 'warning' : 'success';
}

const projectOptions = computed(() => projects.value.map(project => ({
  label: project.name,
  value: project._id
})));

const exportTeamOptions = computed(() => teams.value.map(team => ({
  label: team.status === 'disabled' ? `${team.name}（禁用）` : team.name,
  value: team.id
})));

const scorerSummaryOptions = computed(() => dashboard.value.workloadSummary.scorers.map(scorer => ({
  label: `${scorer.name} / ${formatNumber(scorer.totalTaskCount)} 个任务`,
  value: scorer.id
})));

const teamSummaryOptions = computed(() => dashboard.value.workloadSummary.teams.map(team => ({
  label: `${team.name} / ${formatNumber(team.userCount || 0)} 人`,
  value: team.id
})));
const exportScorerOptions = computed(() => dashboard.value.workloadSummary.scorers.map(scorer => ({
  label: `${scorer.name} / ${formatNumber(scorer.totalTaskCount)} 个任务`,
  value: scorer.id
})));

const selectedProjectName = computed(() => (
  projects.value.find(project => project._id === selectedProjectId.value)?.name
  || dashboard.value.projectSummary?.projectName
  || '全部项目'
));

const chartColors = computed(() => isDark.value
  ? {
    text: '#cbd5e1',
    muted: '#94a3b8',
    grid: 'rgba(148, 163, 184, 0.18)',
    surface: '#162033',
    line: '#38bdf8',
    lineFill: 'rgba(56, 189, 248, 0.18)',
    completed: '#34d399',
    pending: '#fbbf24'
  }
  : {
    text: '#334155',
    muted: '#64748b',
    grid: 'rgba(100, 116, 139, 0.18)',
    surface: '#ffffff',
    line: '#2563eb',
    lineFill: 'rgba(37, 99, 235, 0.12)',
    completed: '#10b981',
    pending: '#f59e0b'
  });

const hasPeakData = computed(() => dashboard.value.peakHours.some(item => item.count > 0));
const peakHourChartData = computed<ChartData<'line', number[], string>>(() => ({
  labels: dashboard.value.peakHours.map(item => item.label),
  datasets: [{
    label: '完成任务数',
    data: dashboard.value.peakHours.map(item => item.count),
    borderColor: chartColors.value.line,
    backgroundColor: chartColors.value.lineFill,
    fill: true,
    tension: 0.38,
    pointRadius: 4,
    pointHoverRadius: 6,
    pointBackgroundColor: chartColors.value.line,
    pointBorderColor: chartColors.value.surface,
    pointBorderWidth: 2
  }]
}));

const peakHourChartOptions = computed<ChartOptions<'line'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { display: false },
    tooltip: {
      displayColors: false,
      callbacks: {
        label: context => `${context.parsed.y || 0} 个任务`
      }
    }
  },
  scales: {
    x: {
      grid: { color: chartColors.value.grid },
      ticks: {
        color: chartColors.value.muted,
        maxRotation: 0,
        autoSkip: true,
        maxTicksLimit: 8
      }
    },
    y: {
      beginAtZero: true,
      grid: { color: chartColors.value.grid },
      ticks: {
        color: chartColors.value.muted,
        precision: 0
      }
    }
  }
}));

const uncompletedProjectCount = computed(() => Math.max(0, dashboard.value.projectCount - dashboard.value.completedProjectCount));
const hasProjectStatusData = computed(() => dashboard.value.projectCount > 0);
const projectStatusChartData = computed<ChartData<'doughnut', number[], string>>(() => ({
  labels: ['已完成项目', '未完成项目'],
  datasets: [{
    data: [dashboard.value.completedProjectCount, uncompletedProjectCount.value],
    backgroundColor: [chartColors.value.completed, chartColors.value.pending],
    borderColor: [chartColors.value.surface, chartColors.value.surface],
    borderWidth: 3,
    hoverOffset: 6
  }]
}));

const projectStatusChartOptions = computed<ChartOptions<'doughnut'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '66%',
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label: context => `${context.label}: ${context.parsed} 个`
      }
    }
  }
}));

const projectStatusBreakdown = computed(() => [
  { key: 'total', label: '项目总数', value: dashboard.value.projectCount, color: '#60a5fa' },
  { key: 'completed', label: '已完成', value: dashboard.value.completedProjectCount, color: chartColors.value.completed },
  { key: 'pending', label: '未完成', value: uncompletedProjectCount.value, color: chartColors.value.pending }
]);

const statCards = computed(() => [
  { key: 'project', label: '项目总数', value: formatNumber(dashboard.value.projectCount), note: '已创建项目', icon: statIconPaths.project },
  { key: 'done-project', label: '已完成项目', value: formatNumber(dashboard.value.completedProjectCount), note: '任务全部完成', icon: statIconPaths['done-project'] },
  { key: 'team', label: '团队数', value: formatNumber(dashboard.value.teamCount), note: '标注团队', icon: statIconPaths.team },
  { key: 'scorer', label: '可用打分人', value: formatNumber(dashboard.value.scorerCount), note: '可登录账号', icon: statIconPaths.scorer },
  { key: 'task', label: '任务总数', value: formatNumber(dashboard.value.totalTaskCount), note: '当前任务版本', icon: statIconPaths.task },
  { key: 'pending', label: '待完成任务', value: formatNumber(dashboard.value.pendingTaskCount), note: `未分配 ${formatNumber(dashboard.value.unassignedTaskCount)} / 已分配 ${formatNumber(dashboard.value.assignedTaskCount)}`, icon: statIconPaths.pending },
  { key: 'completed', label: '已完成任务', value: formatNumber(dashboard.value.completedTaskCount), note: '已提交结果', icon: statIconPaths.completed },
  { key: 'duration', label: '平均打分时间', value: averageDurationLoaded.value ? formatDuration(dashboard.value.averageDurationSeconds) : '点击查看', note: '点击加载已完成任务平均值', icon: statIconPaths.duration }
]);

async function openAverageDuration() {
  averageDurationVisible.value = true;
  if (averageDurationLoaded.value || averageDurationLoading.value) return;
  averageDurationLoading.value = true;
  try {
    const result = await imageApi.adminDashboardAverageDuration();
    dashboard.value = {
      ...dashboard.value,
      averageDurationSeconds: result.averageDurationSeconds
    };
    averageDurationLoaded.value = true;
  } catch (error) {
    averageDurationVisible.value = false;
    message.error(errorMessage(error));
  } finally {
    averageDurationLoading.value = false;
  }
}

function handleStatCardClick(key: string) {
  if (key === 'duration') void openAverageDuration();
}

const projectMetricCards = computed(() => {
  const summary = dashboard.value.projectSummary;
  if (!summary) return [];
  return [
    { label: '任务总数', value: formatNumber(summary.totalTasks) },
    { label: '已完成', value: formatNumber(summary.completedTaskCount) },
    { label: '未完成', value: formatNumber(summary.pendingTaskCount) },
    { label: '完成率', value: formatPercent(summary.completionRate) },
    { label: '平均完成时间', value: formatDuration(summary.averageDurationSeconds) },
    { label: '参与打分人', value: formatNumber(summary.scorerCount) },
    { label: '图片数量', value: formatNumber(summary.imageCount) },
    { label: '评分维度', value: formatNumber(summary.criterionCount) }
  ];
});

const workloadSummary = computed(() => dashboard.value.workloadSummary);
const activeWorkload = computed(() => (
  workloadViewMode.value === 'scorer'
    ? workloadSummary.value.scorer
    : workloadSummary.value.team
));

const workloadMetricCards = computed(() => {
  const summary = activeWorkload.value;
  if (!summary) return [];
  const baseCards = [
    { label: '涉及项目', value: formatNumber(summary.projectCount) },
    { label: '任务总数', value: formatNumber(summary.totalTaskCount) },
    { label: '已完成', value: formatNumber(summary.completedTaskCount) },
    { label: '未完成', value: formatNumber(summary.pendingTaskCount) },
    { label: '平均打分时间', value: formatDuration(summary.averageDurationSeconds) }
  ];
  if (workloadViewMode.value === 'team' && workloadSummary.value.team) {
    return [{ label: '团队成员', value: formatNumber(workloadSummary.value.team.userCount) }, ...baseCards];
  }
  return baseCards;
});

const workloadRows = computed<WorkloadRow[]>(() => {
  if (workloadViewMode.value === 'scorer') {
    return (workloadSummary.value.scorer?.projects || []).map(project => ({
      id: project.projectId,
      title: project.projectName,
      tagLabel: taskStatusLabel(project.taskStatus),
      tagType: taskStatusType(project.taskStatus),
      totalTaskCount: project.totalTaskCount,
      pendingTaskCount: project.pendingTaskCount,
      completedTaskCount: project.completedTaskCount,
      averageDurationSeconds: project.averageDurationSeconds
    }));
  }
  return (workloadSummary.value.team?.members || []).map(member => ({
    id: member.id,
    title: member.name,
    tagLabel: member.status === 'disabled' ? '禁用' : `${formatNumber(member.projectCount)} 个项目`,
    tagType: statusTagType(member.status),
    totalTaskCount: member.totalTaskCount,
    pendingTaskCount: member.pendingTaskCount,
    completedTaskCount: member.completedTaskCount,
    averageDurationSeconds: member.averageDurationSeconds
  }));
});

async function loadProjects() {
  projects.value = await imageApi.projects();
  if (!selectedProjectId.value && projects.value.length) {
    selectedProjectId.value = projects.value[0]._id;
  }
}

async function loadTeams() {
  teams.value = await authApi.teams({ status: 'all' });
}

async function loadDashboardStats() {
  const stats: AdminDashboardStats = await imageApi.adminDashboardStats();
  dashboard.value = {
    ...dashboard.value,
    ...stats
  };
}

async function loadDashboardProjectSection() {
  const result: AdminDashboardProjectSection = await imageApi.adminDashboardProjectSection({
    projectId: selectedProjectId.value
  });
  dashboard.value = {
    ...dashboard.value,
    selectedProjectId: result.selectedProjectId,
    projectSummary: result.projectSummary
  };
  if (!selectedProjectId.value && result.selectedProjectId) {
    selectedProjectId.value = result.selectedProjectId;
  }
}

async function loadDashboardCharts() {
  const result: AdminDashboardCharts = await imageApi.adminDashboardCharts();
  dashboard.value = {
    ...dashboard.value,
    peakHours: result.peakHours
  };
}

async function loadDashboardWorkload() {
  const result: AdminDashboardWorkloadSection = await imageApi.adminDashboardWorkload({
    scorerId: selectedScorerId.value,
    teamId: selectedTeamId.value,
    mode: workloadViewMode.value
  });
  dashboard.value = {
    ...dashboard.value,
    workloadSummary: result
  };
  if (!selectedScorerId.value && result.selectedScorerId) {
    selectedScorerId.value = result.selectedScorerId;
  }
  if (!selectedTeamId.value && result.selectedTeamId) {
    selectedTeamId.value = result.selectedTeamId;
  }
}

async function loadDashboardDetails() {
  for (const loader of [loadDashboardProjectSection, loadDashboardWorkload, loadDashboardCharts]) {
    try {
      await loader();
    } catch (error) {
      message.error(errorMessage(error));
    }
  }
}

function selectAllExportProjects() {
  exportProjectIds.value = projects.value.map(project => project._id);
}

function clearExportProjects() {
  exportProjectIds.value = [];
}

function selectAllExportTeams() {
  exportTeamIds.value = teams.value.map(team => team.id);
}

function clearExportTeams() {
  exportTeamIds.value = [];
}

function selectAllExportScorers() {
  exportScorerIds.value = exportScorerOptions.value.map(scorer => scorer.value);
}

function clearExportScorers() {
  exportScorerIds.value = [];
}

function exportProjectName(projectId: string) {
  return projects.value.find(project => project._id === projectId)?.name || '项目';
}

function exportTeamName(teamId: string) {
  return teams.value.find(team => team.id === teamId)?.name || '团队';
}

function exportScorerName(scorerId: string) {
  return dashboard.value.workloadSummary.scorers.find(scorer => scorer.id === scorerId)?.name || '打分人';
}

function combinedExportProgress(index: number, total: number, progress: number) {
  return Math.round(((index + Math.max(0, Math.min(100, progress)) / 100) / total) * 100);
}

function localDayStartIso(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function localDayEndIso(timestamp: number) {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}

function exportDateLabel(timestamp: number) {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function exportScorerCompletedRangePayload() {
  const range = exportScorerCompletedRange.value;
  if (!range) return {};
  const [start, end] = range;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return {};
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return {
    completedFrom: localDayStartIso(from),
    completedTo: localDayEndIso(to)
  };
}

function exportScorerCompletedRangeLabel() {
  const range = exportScorerCompletedRange.value;
  if (!range) return '';
  const [start, end] = range;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
  return `${exportDateLabel(Math.min(start, end))} 至 ${exportDateLabel(Math.max(start, end))}`;
}

async function exportProjectCompletedTasks() {
  if (!exportProjectIds.value.length) {
    message.error('请选择需要导出的项目');
    return;
  }
  const projectIds = [...exportProjectIds.value];
  exportingProjects.value = true;
  const taskId = taskStack.addTask({
    kind: 'export',
    title: '导出项目任务明细',
    description: `将按项目依次导出 ${projectIds.length} 个 JSON 文件`,
    stage: '正在生成完成任务 JSON',
    progress: 0
  });
  try {
    for (const [index, projectId] of projectIds.entries()) {
      const name = exportProjectName(projectId);
      await imageApi.exportCompletedTasks(projectId, {
        onProgress: job => taskStack.updateTask(taskId, {
          progress: combinedExportProgress(index, projectIds.length, job.progress),
          stage: `${index + 1}/${projectIds.length} ${name}：${job.stage}`
        })
      });
    }
    taskStack.finishTask(taskId, { stage: 'JSON 已生成', description: `已触发 ${projectIds.length} 个文件下载` });
    message.success(`已开始下载 ${projectIds.length} 个项目任务明细 JSON`);
  } catch (error) {
    taskStack.failTask(taskId, error);
    message.error(errorMessage(error));
  } finally {
    exportingProjects.value = false;
  }
}

async function exportTeamTaskSummary() {
  if (!exportTeamIds.value.length) {
    message.error('请选择需要导出的团队');
    return;
  }
  const teamIds = [...exportTeamIds.value];
  const excludeInactiveScorers = exportTeamExcludeInactiveScorers.value;
  exportingTeams.value = true;
  const taskId = taskStack.addTask({
    kind: 'export',
    title: '导出团队成员汇总',
    description: `将按团队依次导出 ${teamIds.length} 个 JSON 文件${excludeInactiveScorers ? '，仅包含近 7 天有打分的成员' : ''}`,
    stage: '正在生成成员任务统计',
    progress: 0
  });
  try {
    for (const [index, teamId] of teamIds.entries()) {
      const name = exportTeamName(teamId);
      await imageApi.exportTeamTaskSummary([teamId], {
        excludeInactiveScorers,
        onProgress: job => taskStack.updateTask(taskId, {
          progress: combinedExportProgress(index, teamIds.length, job.progress),
          stage: `${index + 1}/${teamIds.length} ${name}：${job.stage}`
        })
      });
    }
    taskStack.finishTask(taskId, { stage: '团队汇总已生成', description: `已触发 ${teamIds.length} 个文件下载` });
    message.success(`已开始下载 ${teamIds.length} 个团队成员汇总 JSON`);
  } catch (error) {
    taskStack.failTask(taskId, error);
    message.error(errorMessage(error));
  } finally {
    exportingTeams.value = false;
  }
}

async function exportScorerTaskSummary() {
  if (!exportScorerIds.value.length) {
    message.error('请选择需要导出的打分人');
    return;
  }
  const scorerIds = [...exportScorerIds.value];
  const completedRange = exportScorerCompletedRangePayload();
  const completedRangeLabel = exportScorerCompletedRangeLabel();
  exportingScorers.value = true;
  const taskId = taskStack.addTask({
    kind: 'export',
    title: '导出打分人任务明细',
    description: `将按打分人依次导出 ${scorerIds.length} 个 JSON 文件${completedRangeLabel ? `，完成时间：${completedRangeLabel}` : ''}`,
    stage: '正在生成已完成任务 JSON',
    progress: 0
  });
  try {
    for (const [index, scorerId] of scorerIds.entries()) {
      const name = exportScorerName(scorerId);
      await imageApi.exportScorerTaskSummary([scorerId], {
        ...completedRange,
        onProgress: job => taskStack.updateTask(taskId, {
          progress: combinedExportProgress(index, scorerIds.length, job.progress),
          stage: `${index + 1}/${scorerIds.length} ${name}：${job.stage}`
        })
      });
    }
    taskStack.finishTask(taskId, { stage: '任务明细已生成', description: `已触发 ${scorerIds.length} 个文件下载` });
    message.success(`已开始下载 ${scorerIds.length} 个打分人已完成任务 JSON`);
  } catch (error) {
    taskStack.failTask(taskId, error);
    message.error(errorMessage(error));
  } finally {
    exportingScorers.value = false;
  }
}

watch(selectedProjectId, () => {
  if (!dashboardReady.value) return;
  void loadDashboardProjectSection();
});

watch([selectedScorerId, selectedTeamId, workloadViewMode], () => {
  if (!dashboardReady.value) return;
  void loadDashboardWorkload();
});

onMounted(async () => {
  loading.value = true;
  try {
    await Promise.all([loadProjects(), loadTeams(), loadDashboardStats()]);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
  void loadDashboardDetails().finally(() => {
    dashboardReady.value = true;
  });
});
</script>

<template>
  <div class="admin-page admin-dashboard-content">
    <div class="admin-page-header admin-dashboard-page-header">
      <div>
        <n-h2 class="page-title">仪表盘</n-h2>
        <n-text depth="3">项目、团队与打分进度总览</n-text>
      </div>

    </div>

    <section class="admin-dashboard-stat-grid" aria-label="核心指标">
      <article v-for="card in statCards" :key="card.key" class="admin-dashboard-stat-card"
        :class="[`is-${card.key}`, { 'is-clickable': card.key === 'duration' }]"
        :role="card.key === 'duration' ? 'button' : undefined"
        :tabindex="card.key === 'duration' ? 0 : undefined"
        @click="handleStatCardClick(card.key)" @keydown.enter="handleStatCardClick(card.key)">
        <div class="admin-dashboard-stat-icon" :class="`is-${card.key}`">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true">
            <path :d="card.icon" />
          </svg>
        </div>
        <div class="admin-dashboard-stat-copy">
          <span>{{ card.label }}</span>
          <strong>{{ card.value }}</strong>
          <n-text depth="3">{{ card.note }}</n-text>
        </div>
      </article>
    </section>

    <section class="dashboard-main-grid">
      <div class="table-shell dashboard-workload-card">
        <div class="table-shell-header dashboard-card-header dashboard-workload-header">
          <div class="table-shell-header-flex">
            <strong>{{ workloadViewMode === 'scorer' ? '打分人汇总' : '团队汇总' }}</strong>

          </div>
          <div class="dashboard-summary-controls">
            <div class="dashboard-progress-switch">
              <n-button size="small" :type="workloadViewMode === 'scorer' ? 'primary' : 'default'" secondary
                @click="workloadViewMode = 'scorer'">打分人</n-button>
              <n-button size="small" :type="workloadViewMode === 'team' ? 'primary' : 'default'" secondary
                @click="workloadViewMode = 'team'">团队</n-button>
            </div>
            <n-select v-if="workloadViewMode === 'scorer'" v-model:value="selectedScorerId" filterable
              :options="scorerSummaryOptions" placeholder="选择打分人" />
            <n-select v-else v-model:value="selectedTeamId" filterable :options="teamSummaryOptions" placeholder="选择团队" />
          </div>
        </div>
        <div v-if="activeWorkload" class="dashboard-workload-body">
          <div class="dashboard-workload-title-row">
            <div>
              <strong>{{ activeWorkload.name }}</strong>
              <n-text depth="3">
                完成率 {{ formatPercent(activeWorkload.completionRate) }} / 平均 {{
                  formatDuration(activeWorkload.averageDurationSeconds) }}
              </n-text>
            </div>

          </div>
          <div class="dashboard-workload-metrics">
            <div v-for="metric in workloadMetricCards" :key="metric.label" class="dashboard-workload-metric">
              <span>{{ metric.label }}</span>
              <strong>{{ metric.value }}</strong>
            </div>
          </div>
          <div v-if="workloadRows.length" class="dashboard-workload-list">
            <div v-for="row in workloadRows" :key="row.id" class="dashboard-workload-row">
              <div class="dashboard-workload-row-main">
                <strong>{{ row.title }}</strong>
                <n-tag size="tiny" :bordered="false" :type="row.tagType">{{ row.tagLabel }}</n-tag>
              </div>
              <div class="dashboard-workload-row-stats">
                <span>任务 {{ formatNumber(row.totalTaskCount) }}</span>
                <span>已完成 {{ formatNumber(row.completedTaskCount) }}</span>
                <span>未完成 {{ formatNumber(row.pendingTaskCount) }}</span>
                <span>平均 {{ formatDuration(row.averageDurationSeconds) }}</span>
              </div>
            </div>
          </div>
          <div v-else class="empty dashboard-workload-empty">
            {{ workloadViewMode === 'scorer' ? '该打分人暂无任务' : '该团队暂无成员任务' }}
          </div>
        </div>
        <div v-else class="empty dashboard-empty">暂无可展示汇总</div>
      </div>

      <div class="dashboard-export-column">
        <div class="table-shell dashboard-export-tool">
          <div class="table-shell-header dashboard-card-header">
            <div class="table-shell-header-flex">
              <strong>项目导出</strong>
              <n-text depth="3">导出所选项目的完成任务明细 JSON</n-text>
            </div>
          </div>
          <div class="dashboard-export-body">
            <n-select v-model:value="exportProjectIds" multiple filterable clearable :options="projectOptions"
              placeholder="选择要导出的项目" />
            <div class="dashboard-export-meta">
              <n-tag size="small" :bordered="false">已选 {{ exportProjectIds.length }} 个项目</n-tag>
            </div>
            <div class="dashboard-export-actions">
              <n-button size="small" secondary :disabled="!projects.length" @click="selectAllExportProjects">全选</n-button>
              <n-button size="small" secondary :disabled="!exportProjectIds.length"
                @click="clearExportProjects">清空</n-button>
              <n-button type="primary" :loading="exportingProjects" :disabled="!exportProjectIds.length"
                @click="exportProjectCompletedTasks">
                导出项目 JSON
              </n-button>
            </div>
          </div>
        </div>

        <div class="table-shell dashboard-export-tool">
          <div class="table-shell-header dashboard-card-header">
            <div class="table-shell-header-flex">
              <strong>打分人导出</strong>
              <n-text depth="3">导出所选打分人的已完成任务明细 JSON</n-text>
            </div>
          </div>
          <div class="dashboard-export-body">
            <n-select v-model:value="exportScorerIds" multiple filterable clearable :options="exportScorerOptions"
              placeholder="选择要导出的打分人" />
            <div class="dashboard-export-filter">
              <n-text depth="3">完成时间范围</n-text>
              <n-date-picker v-model:value="exportScorerCompletedRange" type="daterange" clearable
                start-placeholder="开始日期" end-placeholder="结束日期" />
            </div>
            <div class="dashboard-export-meta">
              <n-tag size="small" :bordered="false">已选 {{ exportScorerIds.length }} 位打分人</n-tag>
              <n-text depth="3">包含任务图片、排序/判断结果、提交方式和打分耗时。</n-text>
            </div>
            <div class="dashboard-export-actions">
              <n-button size="small" secondary :disabled="!exportScorerOptions.length" @click="selectAllExportScorers">
                全选
              </n-button>
              <n-button size="small" secondary :disabled="!exportScorerIds.length" @click="clearExportScorers">清空</n-button>
              <n-button type="primary" :loading="exportingScorers" :disabled="!exportScorerIds.length"
                @click="exportScorerTaskSummary">
                导出任务 JSON
              </n-button>
            </div>
          </div>
        </div>

        <div class="table-shell dashboard-export-tool">
          <div class="table-shell-header dashboard-card-header">
            <div class="table-shell-header-flex">
              <strong>团队导出</strong>
              <n-text depth="3">导出团队当前成员的任务汇总 JSON</n-text>
            </div>
          </div>
          <div class="dashboard-export-body">
            <n-select v-model:value="exportTeamIds" multiple filterable clearable :options="exportTeamOptions"
              placeholder="选择要导出的团队" />
            <div class="dashboard-export-option">
              <n-text depth="3">去掉最近 7 天没有打分的人</n-text>
              <n-switch v-model:value="exportTeamExcludeInactiveScorers" size="small" />
            </div>
            <div class="dashboard-export-meta">
              <n-tag size="small" :bordered="false">已选 {{ exportTeamIds.length }} 个团队</n-tag>
              <n-text depth="3">包含打分人、任务总数、已完成、未完成、完成率。</n-text>
            </div>
            <div class="dashboard-export-actions">
              <n-button size="small" secondary :disabled="!teams.length" @click="selectAllExportTeams">全选</n-button>
              <n-button size="small" secondary :disabled="!exportTeamIds.length" @click="clearExportTeams">清空</n-button>
              <n-button type="primary" :loading="exportingTeams" :disabled="!exportTeamIds.length"
                @click="exportTeamTaskSummary">
                导出团队 JSON
              </n-button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="dashboard-insight-grid">
      <div class="table-shell dashboard-project-summary">
        <div class="table-shell-header dashboard-card-header">
          <div class="table-shell-header-flex">
            <strong>按项目汇总</strong>
            <n-text depth="3">{{ selectedProjectName }}</n-text>
          </div>
          <n-select v-model:value="selectedProjectId" filterable :options="projectOptions" placeholder="选择项目" />
        </div>
        <div v-if="dashboard.projectSummary" class="dashboard-project-body">
          <div class="dashboard-project-title-row">
            <div>
              <strong>{{ dashboard.projectSummary.projectName }}</strong>
              <n-text depth="3">
                {{ dashboard.projectSummary.packageCount }} 个图包 / {{ dashboard.projectSummary.taskTemplateCount }} 个模板任务
              </n-text>
            </div>
            <n-tag class="dashboard-project-status-tag" size="small"
              :type="taskStatusType(dashboard.projectSummary.taskStatus)" :bordered="false">
              {{ taskStatusLabel(dashboard.projectSummary.taskStatus) }}
            </n-tag>
          </div>
          <div class="dashboard-project-progress">
            <n-progress type="line" :percentage="Math.round(dashboard.projectSummary.completionRate * 100)"
              :show-indicator="false" />
            <n-text depth="3">完成率 {{ formatPercent(dashboard.projectSummary.completionRate) }}</n-text>
          </div>
          <div class="dashboard-project-metrics">
            <div v-for="metric in projectMetricCards" :key="metric.label" class="dashboard-project-metric">
              <span>{{ metric.label }}</span>
              <strong>{{ metric.value }}</strong>
            </div>
          </div>
        </div>
        <div v-else class="empty dashboard-empty">暂无可汇总项目</div>
      </div>

      <div class="table-shell dashboard-chart-card dashboard-insight-chart-card">
        <div class="table-shell-header dashboard-card-header">
          <div class="table-shell-header-flex">
            <strong>打分高峰期</strong>
            <n-text depth="3">全部任务 / 按完成时间小时统计</n-text>
          </div>
        </div>
        <div class="dashboard-chart-stack">
          <section class="dashboard-chart-panel" aria-label="按小时统计的完成任务数">
            <div class="dashboard-chart-panel-header">
              <strong>完成任务趋势</strong>
              <n-text depth="3">按完成时间小时统计</n-text>
            </div>
            <div class="dashboard-chart-body">
              <BaseChart type="line" :data="peakHourChartData" :options="peakHourChartOptions" :empty="!hasPeakData"
                empty-text="暂无已完成任务" />
            </div>
          </section>

          <section class="dashboard-chart-panel dashboard-project-status-panel" aria-label="项目状态分布">
            <div class="dashboard-chart-panel-header">
              <strong>项目状态分布</strong>
              <n-text depth="3">项目总数 / 已完成 / 未完成</n-text>
            </div>
            <div class="dashboard-project-status-body">
              <div class="dashboard-pie-figure">
                <BaseChart type="doughnut" :data="projectStatusChartData" :options="projectStatusChartOptions"
                  :empty="!hasProjectStatusData" empty-text="暂无项目数据" />
                <div v-if="hasProjectStatusData" class="dashboard-pie-center">
                  <span>项目总数</span>
                  <strong>{{ formatNumber(dashboard.projectCount) }}</strong>
                </div>
              </div>
              <div class="dashboard-pie-legend">
                <div v-for="item in projectStatusBreakdown" :key="item.key" class="dashboard-pie-legend-item">
                  <span :style="{ backgroundColor: item.color }" />
                  <div>
                    <small>{{ item.label }}</small>
                    <strong>{{ formatNumber(item.value) }}</strong>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  </div>

  <n-modal v-model:show="averageDurationVisible" preset="card" title="平均打分时间" :bordered="false"
    style="width: min(420px, calc(100vw - 32px));">
    <n-spin :show="averageDurationLoading">
      <div class="dashboard-average-duration-dialog">
        <n-text depth="3">统计范围：当前任务版本的已完成任务</n-text>
        <strong>{{ averageDurationLoaded ? formatDuration(dashboard.averageDurationSeconds) : '正在计算...' }}</strong>
      </div>
    </n-spin>
  </n-modal>
</template>
