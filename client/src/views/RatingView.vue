<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { NButton, NTag, useMessage, type DataTableColumns } from 'naive-ui';
import { currentUser } from '../composables/auth';
import TaskRankingDialog from '../features/tasks/components/TaskRankingDialog.vue';
import AsyncStatePlaceholder from '../components/AsyncStatePlaceholder.vue';
import { taskCriteria } from '../constants/scoreCriteria';
import { imageApi } from '../services/images';
import { isQueryUnavailable } from '../services/http';
import type { RatingTask, ScorerDashboard, ScorerProjectOption, ScorerTaskListItem } from '../types/image';

const message = useMessage();
const tasks = ref<ScorerTaskListItem[]>([]);
const loading = ref(false);
const taskListState = ref<'loading' | 'ready' | 'stale' | 'unavailable'>('loading');
const taskStatsState = ref<'loading' | 'ready' | 'stale' | 'unavailable'>('loading');
const taskPage = ref(1);
const taskPageSize = ref(5);
const taskHasMore = ref(false);
const taskPageCursors = new Map<number, string>();
const activeTask = ref<RatingTask | null>(null);
const rankingVisible = ref(false);
const openingTaskId = ref<string | null>(null);
const projects = ref<ScorerProjectOption[]>([]);
const taskStats = ref<Pick<ScorerDashboard, 'pendingTasks' | 'completedTasks' | 'totalTasks' | 'projectCount'>>({
  pendingTasks: 0,
  completedTasks: 0,
  totalTasks: 0,
  projectCount: 0
});
const taskTotal = computed(() => taskStats.value.totalTasks);
const taskStatsRefreshMinIntervalMs = 10_000;
let taskStatsRefreshTimer: number | null = null;
let taskStatsLoadPromise: Promise<void> | null = null;
let lastTaskStatsLoadAt = 0;
let taskStatsRefreshVersion = 0;
const taskFilters = reactive({
  projectId: null as string | null,
  criterion: null as RatingTask['criterion'] | null,
  status: null as 'assigned' | 'completed' | null
});
let taskLoadTimer: number | null = null;
let taskListRefreshPending = false;

const criterionOptions = taskCriteria.map(item => ({ label: item.label, value: item.key }));
const projectOptions = computed(() => projects.value
  .map(project => ({ label: project.name, value: project._id })));
const taskProgress = computed(() => {
  const total = taskStats.value.totalTasks;
  return total ? Math.round((taskStats.value.completedTasks / total) * 100) : 0;
});
const taskProgressTotal = computed(() => taskStats.value.totalTasks);
const taskProgressLabel = computed(() => taskStatsState.value === 'unavailable' ? '—' : `${taskProgress.value}%`);
const taskProgressDetail = computed(() => taskStatsState.value === 'unavailable'
  ? '统计暂不可用'
  : `${taskStats.value.completedTasks} / ${taskProgressTotal.value} 已完成`);

const statIconPaths = {
  task: 'M7 7h10M7 12h10M7 17h7 M5 5h14v14H5z',
  completed: 'M9 12l2 2 4-5 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  pending: 'M12 8v5l3 2m6-3a9 9 0 1 1-18 0',
  progress: 'M5 19V9m7 10V5m7 14v-7 M3 19h18'
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function criterionLabel(key: RatingTask['criterion']) {
  return taskCriteria.find(item => item.key === key)?.label || key || '未指定维度';
}

function paginationPrefix({ itemCount }: { itemCount?: number }) {
  return taskTotal.value
    ? `共 ${itemCount ?? taskTotal.value} 个任务`
    : `第 ${taskPage.value} 页`;
}

function changePage(page: number) {
  void loadTasks(page, taskPageSize.value);
}

function changePageSize(pageSize: number) {
  taskPageCursors.clear();
  void loadTasks(1, pageSize);
}

function clearTaskStatsRefreshTimer() {
  if (taskStatsRefreshTimer !== null) {
    window.clearTimeout(taskStatsRefreshTimer);
    taskStatsRefreshTimer = null;
  }
}

function scheduleTaskStatsRefresh(force = false) {
  taskStatsRefreshVersion += 1;
  const requestVersion = taskStatsRefreshVersion;
  const elapsed = Date.now() - lastTaskStatsLoadAt;
  const delay = force || !lastTaskStatsLoadAt || elapsed >= taskStatsRefreshMinIntervalMs
    ? 0
    : taskStatsRefreshMinIntervalMs - elapsed;

  clearTaskStatsRefreshTimer();
  if (delay > 0 && taskStatsState.value === 'ready') {
    taskStatsState.value = 'stale';
  }
  taskStatsRefreshTimer = window.setTimeout(() => {
    taskStatsRefreshTimer = null;
    if (requestVersion !== taskStatsRefreshVersion) return;
    void loadTaskStats();
  }, delay);
}

async function loadTasks(page = taskPage.value, pageSize = taskPageSize.value) {
  const scorer = currentUser.value?.username;
  if (!scorer) return;
  if (page === 1) taskPageCursors.clear();
  const cursor = page > 1 ? taskPageCursors.get(page - 1) : null;
  if (page > 1 && !cursor) page = 1;
  loading.value = true;
  taskListState.value = tasks.value.length ? 'stale' : 'loading';
  try {
    const result = await imageApi.assignedTasks({
      scorer,
      page,
      pageSize,
      cursor,
      ...taskFilters
    });
    tasks.value = result.tasks;
    if (result.nextCursor) taskPageCursors.set(page, result.nextCursor);
    else taskPageCursors.delete(page);
    taskHasMore.value = result.hasMore;
    taskPage.value = result.page;
    taskPageSize.value = result.pageSize;
    taskListState.value = 'ready';
  } catch (error) {
    if (isQueryUnavailable(error)) taskListState.value = tasks.value.length ? 'stale' : 'unavailable';
    else {
      taskListState.value = tasks.value.length ? 'stale' : 'ready';
      message.error(errorMessage(error));
    }
  } finally {
    loading.value = false;
  }
}

async function loadProjects() {
  try {
    const result = await imageApi.assignedTaskOptions();
    projects.value = result.projects;
  } catch (error) {
    if (!isQueryUnavailable(error)) message.error(errorMessage(error));
  }
}

async function loadTaskStats() {
  if (taskStatsLoadPromise) return taskStatsLoadPromise;
  const scorer = currentUser.value?.username;
  if (!scorer) return;
  const requestVersion = taskStatsRefreshVersion;
  const request = (async () => {
    taskStatsState.value = taskStats.value.totalTasks ? 'stale' : 'loading';
    try {
      const result = await imageApi.scorerDashboard({
        scorer,
        projectId: null
      });
      taskStats.value = {
        pendingTasks: result.pendingTasks,
        completedTasks: result.completedTasks,
        totalTasks: result.totalTasks,
        projectCount: result.projectCount
      };
      taskStatsState.value = 'ready';
    } catch (error) {
      if (isQueryUnavailable(error)) taskStatsState.value = taskStats.value.totalTasks ? 'stale' : 'unavailable';
      else {
        taskStatsState.value = taskStats.value.totalTasks ? 'stale' : 'ready';
        message.error(errorMessage(error));
      }
    } finally {
      lastTaskStatsLoadAt = Date.now();
    }
  })();
  taskStatsLoadPromise = request;
  try {
    await request;
  } finally {
    if (taskStatsLoadPromise === request) taskStatsLoadPromise = null;
    if (requestVersion !== taskStatsRefreshVersion) {
      scheduleTaskStatsRefresh(true);
    }
  }
}

function resetTaskFilters() {
  taskFilters.projectId = null;
  taskFilters.criterion = null;
  taskFilters.status = null;
}

function toggleStatusFilter(status: 'assigned' | 'completed') {
  taskFilters.status = taskFilters.status === status ? null : status;
}

function markTaskListRefreshPending() {
  taskListRefreshPending = true;
}

function applyTaskStatsAfterSave(previousTask: RatingTask | null, savedTask: RatingTask) {
  if (taskStatsState.value === 'unavailable') return;
  if (!previousTask || previousTask.id !== savedTask.id) return;
  if (previousTask.status === 'assigned' && savedTask.status === 'completed') {
    taskStats.value = {
      ...taskStats.value,
      pendingTasks: Math.max(0, taskStats.value.pendingTasks - 1),
      completedTasks: taskStats.value.completedTasks + 1,
      totalTasks: taskStats.value.totalTasks
    };
  }
}

async function openRanking(task: ScorerTaskListItem) {
  if (openingTaskId.value) return;
  openingTaskId.value = task.id;
  try {
    const result = await imageApi.assignedTaskDetail(task.id);
    activeTask.value = result.task;
    rankingVisible.value = true;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    openingTaskId.value = null;
  }
}

function handleTaskSaved(task: RatingTask, advancing = false, previousTask: RatingTask | null = null) {
  if (activeTask.value?.id === task.id) activeTask.value = task;
  applyTaskStatsAfterSave(previousTask, task);
  markTaskListRefreshPending();
}

async function getNextTask(savedTask?: RatingTask) {
  const scorer = currentUser.value?.username;
  if (!scorer) throw new Error('未获取到当前打分人');

  const nextPage = await imageApi.assignedTasks({
    scorer,
    projectId: taskFilters.projectId,
    criterion: taskFilters.criterion,
    status: 'assigned',
    page: 1,
    pageSize: 1,
    summaryOnly: true,
    excludeTaskId: savedTask?.id || null
  });

  const nextTask = nextPage.tasks[0];
  if (nextTask?.id === savedTask?.id) {
    return null;
  }
  if (!nextTask) {
    return null;
  }
  const result = await imageApi.assignedTaskDetail(nextTask.id);
  return result.task;
}

function openNextTask(task: RatingTask) {
  activeTask.value = task;
  rankingVisible.value = true;
}

watch(rankingVisible, (show, oldShow) => {
  if (!oldShow || show) return;
  if (!taskListRefreshPending) return;
  taskListRefreshPending = false;
  void loadTasks(taskPage.value, taskPageSize.value);
});

function renderTaskImages(task: ScorerTaskListItem) {
  return h('div', { class: 'task-image-strip' }, task.items.map(item => h('div', {
    class: 'task-image-cell',
    key: `${task.id}-${item.position}`,
    title: item.image.filename
  }, [
    h('img', {
      class: 'task-thumbnail',
      src: item.image.thumbnailUrl || item.image.imageUrl,
      alt: item.image.filename,
      loading: 'lazy',
      decoding: 'async'
    }),
    h('span', { class: 'task-thumbnail-position' }, String(item.position + 1))
  ])));
}

const columns: DataTableColumns<ScorerTaskListItem> = [
  { title: '任务图片', key: 'items', minWidth: 320, render: renderTaskImages },
  { title: '项目', key: 'subjectName', minWidth: 160, render: row => row.subjectName || row.subjectId },
  { title: '评分维度', key: 'criterion', minWidth: 170, render: row => criterionLabel(row.criterion) },
  {
    title: '状态',
    key: 'status',
    width: 104,
    render: row => h(NTag, { size: 'small', type: row.status === 'completed' ? 'success' : 'warning' }, {
      default: () => row.status === 'completed' ? '已完成' : '待处理'
    })
  },
  {
    title: '操作',
    key: 'actions',
    width: 104,
    fixed: 'right',
    render: row => h(NButton, {
      size: 'small',
      type: row.status === 'completed' ? 'default' : 'primary',
      loading: openingTaskId.value === row.id,
      onClick: () => void openRanking(row)
    }, { default: () => row.status === 'completed' ? '修改' : '打分' })
  }
];

function scheduleTaskLoad() {
  if (taskLoadTimer != null) window.clearTimeout(taskLoadTimer);
  taskLoadTimer = window.setTimeout(() => {
    taskLoadTimer = null;
    taskPageCursors.clear();
    void loadTasks(1, taskPageSize.value);
  }, 150);
}

watch(taskFilters, scheduleTaskLoad, { deep: true });
onBeforeUnmount(() => {
  if (taskLoadTimer != null) window.clearTimeout(taskLoadTimer);
});

onMounted(() => {
  void loadProjects();
  void loadTasks();
  window.setTimeout(() => scheduleTaskStatsRefresh(true), 200);
});

onBeforeUnmount(() => {
  clearTaskStatsRefreshTimer();
});
</script>

<template>
  <div class="scorer-task-page">
    <div class="scorer-task-header">
      <section class="scorer-task-stat-grid" aria-label="任务统计">
        <article class="admin-dashboard-stat-card scorer-task-stat-card is-task" @click="toggleStatusFilter('assigned')"
          @keydown.enter="toggleStatusFilter('assigned')">
          <div class="admin-dashboard-stat-icon is-pending">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
              stroke-linejoin="round" aria-hidden="true">
              <path :d="statIconPaths.pending" />
            </svg>
          </div>
          <div class="admin-dashboard-stat-copy">
            <span>未完成任务</span>
            <strong>{{ taskStatsState === 'unavailable' ? '—' : taskStats.pendingTasks }}</strong>
            <n-text depth="3">点击筛选待处理</n-text>
          </div>
        </article>

        <article class="admin-dashboard-stat-card scorer-task-stat-card is-completed"
          :class="{ 'is-active': taskFilters.status === 'completed' }" role="button" tabindex="0"
          @click="toggleStatusFilter('completed')" @keydown.enter="toggleStatusFilter('completed')">
          <div class="admin-dashboard-stat-icon is-completed">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
              stroke-linejoin="round" aria-hidden="true">
              <path :d="statIconPaths.completed" />
            </svg>
          </div>
          <div class="admin-dashboard-stat-copy">
            <span>已完成任务</span>
            <strong>{{ taskStatsState === 'unavailable' ? '—' : taskStats.completedTasks }}</strong>
            <n-text depth="3">点击筛选已完成</n-text>
          </div>
        </article>

        <article class="admin-dashboard-stat-card scorer-task-composite-card" aria-label="未完成任务和完成进度">

          <div class="scorer-task-composite-metric is-progress">
            <div class="admin-dashboard-stat-icon is-task">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true">
                <path :d="statIconPaths.progress" />
              </svg>
            </div>
            <div class="admin-dashboard-stat-copy">
              <span>任务进度</span>
              <strong>{{ taskProgressLabel }}</strong>
              <n-text depth="3">{{ taskProgressDetail }}</n-text>
              <n-text v-if="taskStatsState === 'stale'" depth="3">统计正在刷新</n-text>
            </div>
          </div>
          <n-progress class="scorer-task-composite-progress" type="line" :percentage="taskProgress"
            :show-indicator="false" status="success" />
        </article>
      </section>
    </div>

    <div class="table-shell scorer-task-shell">
      <div class="scorer-task-filter-bar">
        <n-select v-model:value="taskFilters.projectId" clearable :options="projectOptions" placeholder="筛选项目" />
        <n-select v-model:value="taskFilters.criterion" clearable :options="criterionOptions" placeholder="筛选评分维度" />
        <n-button secondary @click="resetTaskFilters">重置筛选</n-button>
      </div>
      <div class="scorer-task-table-body">
        <AsyncStatePlaceholder v-if="taskListState === 'unavailable'" state="unavailable" title="任务列表暂时不可用"
          description="任务数据正在恢复，稍后重试即可继续工作。" :retrying="loading" @retry="() => void loadTasks()" />
        <template v-else-if="tasks.length">
          <AsyncStatePlaceholder v-if="taskListState === 'stale'" state="stale" title="任务列表正在刷新"
            description="先显示上次结果，刷新完成后会自动更新。" :retrying="loading" @retry="() => void loadTasks()" />
          <n-data-table :columns="columns" :data="tasks" :loading="loading" :bordered="false" remote
          :scroll-x="1080" />
        </template>
        <AsyncStatePlaceholder v-else-if="taskListState === 'loading'" state="loading" title="正在加载任务"
          description="正在准备你的任务列表。" />
        <div v-else class="empty">暂无任务</div>
      </div>
      <div class="scorer-task-table-footer">
        <n-pagination v-if="tasks.length || taskHasMore" :page="taskPage" :page-size="taskPageSize"
          :page-count="taskPage + (taskHasMore ? 1 : 0)" show-size-picker
          :page-sizes="[5, 10, 20, 50]" @update:page="changePage"
          @update:page-size="changePageSize" />
      </div>
    </div>
  </div>

  <TaskRankingDialog v-model:show="rankingVisible" :task="activeTask" :get-next-task="getNextTask"
    @saved="handleTaskSaved" @next="openNextTask" />
</template>
