<script setup lang="ts">
import { NText, NSelect, NDataTable, NPagination, NModal, NImage, NSpin, NTable, NForm, NFormItem, NInputNumber } from 'naive-ui';
import { computed, h, onMounted, reactive, ref, watch } from 'vue';
import { NButton, NTag, useMessage, type DataTableColumns } from 'naive-ui';
import { useRoute, useRouter } from 'vue-router';
import { taskApi } from '../services/tasks';
import { taskCriteria } from '../constants/scoreCriteria';
import { useTaskOperations } from '../features/tasks/useTaskOperations';
import type { AdminTaskListItem, ProjectItem, RankingRelation, RatingTask, RatingTaskItem, SubjectItem } from '../types/image';
import { formatDateTime as formatBusinessDateTime } from '../utils/time';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const projectId = decodeURIComponent(String(route.params.subjectId));
const subject = ref<SubjectItem | null>(null);
const project = ref<ProjectItem | null>(null);
const tasks = ref<AdminTaskListItem[]>([]);
const loading = ref(false);
const taskPage = ref(1);
const taskPageSize = ref(10);
const taskTotal = ref(0);
const taskScorers = ref<string[]>([]);
const detailTask = ref<RatingTask | null>(null);
const detailVisible = ref(false);
const detailLoadingTaskId = ref<string | null>(null);
const taskFilters = reactive({
  status: null as RatingTask['status'] | null,
  scorer: null as string | null,
  criterion: null as RatingTask['criterion'] | null
});

const taskStatusOptions = [
  { label: '未分配', value: 'pending' },
  { label: '已分配', value: 'assigned' },
  { label: '已完成', value: 'completed' }
];
function scorerOptions() {
  return taskScorers.value.map(scorer => ({ label: scorer, value: scorer }));
}

const criterionOptions = taskCriteria.map(criterion => ({
  label: criterion.label,
  value: criterion.key
}));

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function criterionLabel(key: RatingTask['criterion']) {
  return taskCriteria.find(item => item.key === key)?.label || key || '未指定维度';
}

function taskStatusLabel(status: RatingTask['status']) {
  return { pending: '未分配', assigned: '已分配', completed: '已完成' }[status] || status;
}

function renderBacktestTag(row: Pick<AdminTaskListItem | RatingTask, 'isBacktest'>) {
  return row.isBacktest
    ? h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => '回测' })
    : h('span', { class: 'table-muted' }, '普通');
}

function rankingRelation(task: RatingTask, index: number): RankingRelation {
  return task.rankingRelations?.[index] === '=' ? '=' : '>';
}

const isDetailCorrectnessCriterion = computed(() => detailTask.value?.criterion === 'textCorrectness' || detailTask.value?.criterion === 'anatomyNormality');

function detailRank(task: RatingTask, index: number) {
  let rank = 1;
  for (let current = 1; current <= index; current++) {
    if (rankingRelation(task, current - 1) === '>') rank += 1;
  }
  return rank;
}

function orderedTaskItems(task: RatingTask): RatingTaskItem[] {
  const itemById = new Map(task.items.map(item => [item.imageId, item]));
  const excludedImageIds = new Set(task.excludedImageIds || []);
  const ordered: RatingTaskItem[] = [];
  const used = new Set<string>();

  task.ranking?.forEach(imageId => {
    if (excludedImageIds.has(imageId)) return;
    const item = itemById.get(imageId);
    if (!item || used.has(imageId)) return;
    ordered.push(item);
    used.add(imageId);
  });

  task.items
    .slice()
    .sort((left, right) => left.position - right.position)
    .forEach(item => {
      if (excludedImageIds.has(item.imageId) || used.has(item.imageId)) return;
      ordered.push(item);
    });

  return ordered;
}

const detailRankedItems = computed(() => detailTask.value ? orderedTaskItems(detailTask.value) : []);
const detailCorrectnessItems = computed(() => {
  const task = detailTask.value;
  if (!task) return [];
  const correctIds = new Set(task.correctImageIds || []);
  const excludedIds = new Set(task.excludedImageIds || []);
  return task.items
    .slice()
    .sort((left, right) => left.position - right.position)
    .map(item => ({
      item,
      state: correctIds.has(item.imageId) ? 'correct' : excludedIds.has(item.imageId) ? 'excluded' : 'incorrect'
    }));
});
const detailExcludedItems = computed(() => {
  const task = detailTask.value;
  if (!task) return [];
  const excludedImageIds = new Set(task.excludedImageIds || []);
  return task.items
    .filter(item => excludedImageIds.has(item.imageId))
    .sort((left, right) => left.position - right.position);
});

function detailCorrectnessStateLabel(state: string) {
  if (state === 'correct') return '正确';
  if (state === 'excluded') return '不评价';
  return '不正确';
}

function formatDateTime(value: string | null | undefined) {
  return value ? formatBusinessDateTime(value) : '未记录';
}

function formatDuration(value: number | null | undefined) {
  if (!value || value < 1000) return '少于 1 秒';
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

async function openTaskDetail(task: AdminTaskListItem) {
  if (task.status !== 'completed') return;
  detailLoadingTaskId.value = task.id;
  try {
    const result = await taskApi.adminProjectTaskDetail(projectId, task.id);
    detailTask.value = result.task;
    detailVisible.value = true;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    detailLoadingTaskId.value = null;
  }
}

const {
  reassignmentVisible, reportVisible, reportLoading, reportExporting, report,
  reassignmentOptionsLoading, reassignmentSubmitting, availableTaskCount,
  reassignmentForm, availableScorerOptions, sourceScorerOptions,
  reassignmentSourceOptions, sourceTaskCountMax, selectedReassignmentTaskTotal,
  updateReassignmentScorers, updateReassignmentAllocation,
  normalizeReassignmentAllocations, openTaskReassignment, submitTaskReassignment,
  openTaskReport, downloadTaskReport, reportPercent, reportStatusRows
} = useTaskOperations({
  projectId, project, subject, taskPageSize,
  loadTasks: (page, pageSize) => loadTasks(page, pageSize),
  loadTaskOptions: () => loadTaskOptions()
});

function renderTaskImages(task: AdminTaskListItem) {
  const items = [...task.items].sort((left, right) => {
    if (left.role === 'filler' && right.role !== 'filler') return -1;
    if (left.role !== 'filler' && right.role === 'filler') return 1;
    return left.position - right.position;
  });
  return h('div', { class: 'task-image-strip' }, items.map(item => h('div', {
    class: ['task-image-cell', { 'is-reference': item.role === 'filler' }],
    key: `${task.id}-${item.position}`,
    title: item.role === 'filler' ? `参考图：${item.image.filename}` : item.image.filename
  }, [
    h('img', {
      class: 'task-thumbnail',
      src: item.image.thumbnailUrl || item.image.imageUrl,
      alt: item.image.filename,
      loading: 'lazy',
      decoding: 'async'
    }),
    h('span', {
      class: ['task-thumbnail-position', { 'is-reference': item.role === 'filler' }]
    }, item.role === 'filler' ? '参考' : String(item.position + 1))
  ])));
}

const columns: DataTableColumns<AdminTaskListItem> = [
  { title: '任务图片', key: 'items', minWidth: 330, render: renderTaskImages },
  { title: '评分维度', key: 'criterion', minWidth: 180, render: row => criterionLabel(row.criterion) },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: row => h(NTag, { size: 'small', type: row.status === 'completed' ? 'success' : 'default' }, {
      default: () => taskStatusLabel(row.status)
    })
  },
  { title: '回测', key: 'isBacktest', width: 90, render: renderBacktestTag },
  { title: '打分人', key: 'scorer', width: 110, render: row => row.scorer || '未分配' },

  { title: '创建时间', key: 'createdAt', width: 180, render: row => formatBusinessDateTime(row.createdAt) },
  {
    title: '操作',
    key: 'actions',
    width: 110,
    fixed: 'right',
    render: row => h(NButton, {
      size: 'small',
      secondary: true,
      disabled: row.status !== 'completed',
      loading: detailLoadingTaskId.value === row.id,
      onClick: () => void openTaskDetail(row)
    }, { default: () => '查看详情' })
  }
];

async function loadTasks(page = taskPage.value, pageSize = taskPageSize.value) {
  loading.value = true;
  try {
    const result = await taskApi.projectTasks(projectId, {
      page,
      pageSize,
      includeTotal: true,
      ...taskFilters
    });
    subject.value = result.subject;
    project.value = result.project;
    tasks.value = result.tasks;
    taskTotal.value = result.total ?? 0;
    taskPage.value = result.page;
    taskPageSize.value = result.pageSize;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function loadTaskOptions() {
  try {
    const result = await taskApi.projectTaskOptions(projectId);
    taskScorers.value = result.scorers;
  } catch (error) {
    message.error(errorMessage(error));
  }
}

function resetTaskFilters() {
  taskFilters.status = null;
  taskFilters.scorer = null;
  taskFilters.criterion = null;
}

function changeTaskPage(page: number) {
  void loadTasks(page, taskPageSize.value);
}

function changeTaskPageSize(pageSize: number) {
  void loadTasks(1, pageSize);
}

function taskPaginationPrefix() {
  return taskTotal.value
    ? `共 ${taskTotal.value} 个任务`
    : `第 ${taskPage.value} 页`;
}

watch(taskFilters, () => void loadTasks(1, taskPageSize.value), { deep: true });

onMounted(() => {
  void loadTaskOptions();
  void loadTasks();
});
</script>

<template>
  <div class="admin-page admin-task-content">
    <div class="table-shell task-table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex task-table-title-stack">
          <div>
            <n-button text @click="router.push('/admin/projects')" style="margin-right: 8px">
              返回
            </n-button>
            <n-text depth="3">共 {{ taskTotal }} 个任务</n-text>
          </div>
        </div>
        <div class="table-shell-header-actions">
          <n-button secondary :disabled="!subject" @click="openTaskReport">
            打分详情
          </n-button>
          <n-button type="primary" :disabled="!project || project.taskStatus === 'task_pending'"
            @click="openTaskReassignment">分配新打分人</n-button>
        </div>
      </div>
      <div class="task-filter-bar">
        <n-select v-model:value="taskFilters.status" clearable :options="taskStatusOptions" placeholder="筛选状态" />
        <n-select v-model:value="taskFilters.criterion" clearable :options="criterionOptions" placeholder="筛选评分维度" />
        <n-select v-model:value="taskFilters.scorer" clearable :options="scorerOptions()" placeholder="筛选分配人" />
        <n-button secondary @click="resetTaskFilters">重置筛选</n-button>
      </div>
      <div class="task-table-body">
        <n-data-table v-if="tasks.length" class="task-data-table" :columns="columns" :data="tasks" :loading="loading"
          :bordered="false" remote :scroll-x="1180" />
        <div v-else class="empty">{{ loading ? '正在加载任务...' : '暂无任务' }}</div>
      </div>
      <div class="task-table-footer">
        <n-pagination v-if="taskTotal > 0" :page="taskPage" :page-size="taskPageSize"
          :page-count="Math.ceil(taskTotal / taskPageSize)" show-size-picker
          :page-sizes="[10, 20, 50, 100]" :prefix="taskPaginationPrefix" @update:page="changeTaskPage"
          @update:page-size="changeTaskPageSize" />
      </div>
    </div>
  </div>

  <n-modal v-model:show="detailVisible" preset="card" class="admin-task-detail-modal" title="打分详情" :bordered="false">
    <template v-if="detailTask">
      <div class="admin-task-detail-meta">
        <div>
          <span>评分维度</span>
          <strong>{{ criterionLabel(detailTask.criterion) }}</strong>
        </div>
        <div>
          <span>打分人</span>
          <strong>{{ detailTask.scorer || '未记录' }}</strong>
        </div>
        <div>
          <span>完成时间</span>
          <strong>{{ formatDateTime(detailTask.completedAt) }}</strong>
        </div>
        <div>
          <span>打分耗时</span>
          <strong>{{ formatDuration(detailTask.durationMs) }}</strong>
        </div>
        <div>
          <span>回测任务</span>
          <strong>
            <n-tag v-if="detailTask.isBacktest" size="small" type="warning" :bordered="false">回测</n-tag>
            <span v-else>普通</span>
          </strong>
        </div>
      </div>

      <section class="admin-task-detail-section">
        <div class="admin-task-detail-section-header">
          <strong>{{ isDetailCorrectnessCriterion ? '判断结果' : '排序结果' }}</strong>
          <n-text depth="3">{{ isDetailCorrectnessCriterion ? '绿色表示正确，红色表示不正确，黄色表示不评价' : '第 1 名为最佳' }}</n-text>
        </div>
        <template v-if="isDetailCorrectnessCriterion">
          <div class="admin-task-detail-correctness-grid">
            <article v-for="{ item, state } in detailCorrectnessItems" :key="item.imageId" class="admin-task-detail-image"
              :class="[`is-${state}`, { 'is-reference': item.role === 'filler' }]">
              <span class="admin-task-detail-state" :class="`is-${state}`">{{ detailCorrectnessStateLabel(state) }}</span>
              <span v-if="item.role === 'filler'" class="admin-task-detail-reference">参考图</span>
              <n-image :src="item.image.thumbnailUrl || item.image.imageUrl" :preview-src="item.image.imageUrl"
                :alt="item.image.filename" object-fit="cover" show-toolbar-tooltip />
            </article>
          </div>
        </template>
        <template v-else>
          <div class="admin-task-detail-ranking-flow">
            <template v-for="(item, index) in detailRankedItems" :key="item.imageId">
              <article class="admin-task-detail-image" :class="{ 'is-reference': item.role === 'filler' }">
                <span class="admin-task-detail-rank">{{ detailRank(detailTask, index) }}</span>
                <span v-if="item.role === 'filler'" class="admin-task-detail-reference">参考图</span>
                <n-image :src="item.image.thumbnailUrl || item.image.imageUrl" :preview-src="item.image.imageUrl"
                  :alt="item.image.filename" object-fit="cover" show-toolbar-tooltip />
                <span :title="item.image.filename">{{ item.image.filename }}</span>
              </article>
              <span v-if="index < detailRankedItems.length - 1" class="admin-task-detail-relation">
                {{ rankingRelation(detailTask, index) }}
              </span>
            </template>
          </div>
        </template>
      </section>

      <section v-if="detailExcludedItems.length && !isDetailCorrectnessCriterion" class="admin-task-detail-section">
        <div class="admin-task-detail-section-header">
          <strong>不评价图片</strong>
          <n-text depth="3">不参与当前维度排序</n-text>
        </div>
        <div class="admin-task-detail-grid admin-task-detail-grid--excluded">
          <article v-for="item in detailExcludedItems" :key="item.imageId" class="admin-task-detail-image">
            <span class="admin-task-detail-excluded">不评价</span>
            <n-image :src="item.image.thumbnailUrl || item.image.imageUrl" :preview-src="item.image.imageUrl"
              :alt="item.image.filename" object-fit="cover" show-toolbar-tooltip />
            <span :title="item.image.filename">{{ item.image.filename }}</span>
          </article>
        </div>
      </section>
    </template>
  </n-modal>

  <n-modal v-model:show="reportVisible" preset="card" class="subject-task-report-modal" title="打分详情" :bordered="false">
    <n-spin :show="reportLoading">
      <div v-if="report" class="subject-task-report-content">
        <div class="subject-task-report-project">
          <strong>{{ report.subject.name }}</strong>
          <n-text depth="3">项目任务统计</n-text>
        </div>
        <div class="subject-task-report-summary-grid">
          <div class="subject-task-report-summary-item">
            <span>图片总数</span>
            <strong>{{ report.imageCount }}</strong>
          </div>
          <div class="subject-task-report-summary-item">
            <span>任务总数</span>
            <strong>{{ report.totalTasks }}</strong>
          </div>
          <div class="subject-task-report-summary-item">
            <span>已完成任务</span>
            <strong class="is-success">{{ report.completedTasks }}</strong>
          </div>
          <div class="subject-task-report-summary-item">
            <span>未完成任务</span>
            <strong class="is-warning">{{ report.statusCounts.pending + report.statusCounts.assigned }}</strong>
          </div>
          <div class="subject-task-report-summary-item">
            <span>任务完成率</span>
            <strong>{{ reportPercent(report.completionRate) }}</strong>
          </div>
          <div class="subject-task-report-summary-item">
            <span>打分人数量</span>
            <strong>{{ report.scorerCount }}</strong>
          </div>
        </div>

        <section class="subject-task-report-section">
          <div class="subject-task-report-section-header">
            <strong>任务状态汇总</strong>
          </div>
          <n-table size="small" :bordered="false" striped>
            <thead>
              <tr>
                <th>状态</th>
                <th>任务数量</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in reportStatusRows" :key="item.status">
                <td>{{ item.label }}</td>
                <td>{{ item.count }}</td>
                <td>{{ reportPercent(item.rate) }}</td>
              </tr>
            </tbody>
          </n-table>
        </section>

        <section class="subject-task-report-section">
          <div class="subject-task-report-section-header">
            <strong>评分维度统计</strong>
            <n-text depth="3">共 {{ report.dimensions.length }} 个评分维度</n-text>
          </div>
          <n-table size="small" :bordered="false" striped>
            <thead>
              <tr>
                <th>评分维度</th>
                <th>任务总数</th>
                <th>未完成</th>
                <th>已完成</th>
                <th>完成率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in report.dimensions" :key="item.key">
                <td>{{ item.label }}</td>
                <td>{{ item.total }}</td>
                <td>{{ item.pending + item.assigned }}</td>
                <td>{{ item.completed }}</td>
                <td>{{ reportPercent(item.completionRate) }}</td>
              </tr>
            </tbody>
          </n-table>
        </section>

        <section class="subject-task-report-section">
          <div class="subject-task-report-section-header">
            <strong>打分人统计</strong>
          </div>
          <n-table size="small" :bordered="false" striped>
            <thead>
              <tr>
                <th>打分人</th>
                <th>任务总数</th>
                <th>未完成</th>
                <th>已完成</th>
                <th>完成率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in report.scorers" :key="item.scorer">
                <td>{{ item.scorer }}</td>
                <td>{{ item.total }}</td>
                <td>{{ item.uncompleted }}</td>
                <td>{{ item.completed }}</td>
                <td>{{ reportPercent(item.completionRate) }}</td>
              </tr>
            </tbody>
          </n-table>
        </section>
      </div>
    </n-spin>
    <template #footer>
      <div class="subject-task-report-actions">
        <n-button @click="reportVisible = false">关闭</n-button>
        <n-button type="primary" :loading="reportExporting" :disabled="!report" @click="downloadTaskReport">
          导出 Excel
        </n-button>
      </div>
    </template>
  </n-modal>

  <n-modal v-model:show="reassignmentVisible" preset="card" class="task-reassignment-modal" title="分配新打分人"
    :bordered="false">
    <n-form label-placement="top">
      <n-form-item label="打分账号">
        <n-select :value="reassignmentForm.scorers" multiple filterable :loading="reassignmentOptionsLoading"
          @update:value="updateReassignmentScorers" :options="availableScorerOptions" placeholder="选择一个或多个账号" />
      </n-form-item>
      <div v-if="reassignmentForm.source === 'assigned_uncompleted' && reassignmentForm.scorers.length"
        class="task-reassignment-allocation-list" aria-label="按打分人分配未分配任务">
        <div v-for="scorer in reassignmentForm.scorers" :key="scorer" class="task-reassignment-allocation-row">
          <span class="task-reassignment-allocation-scorer">{{ scorer }}</span>
          <n-input-number :value="reassignmentForm.allocations[scorer] ?? 0" :min="0" :max="availableTaskCount"
            :show-button="true" @update:value="(value: number | null) => updateReassignmentAllocation(scorer, value)"
            @blur="() => normalizeReassignmentAllocations(scorer)" />
          <span class="task-allocation-unit">个任务</span>
        </div>
      </div>
      <n-form-item label="任务来源">
        <n-select v-model:value="reassignmentForm.source" :options="reassignmentSourceOptions" />
      </n-form-item>
      <n-form-item v-if="reassignmentForm.source === 'selected_scorers'" label="已分配打分人">
        <n-select v-model:value="reassignmentForm.sourceScorers" multiple filterable :loading="reassignmentOptionsLoading"
          :options="sourceScorerOptions" placeholder="选择一个或多个来源打分人" />
      </n-form-item>
      <n-form-item v-if="reassignmentForm.source === 'selected_scorers'" label="每个来源打分人领取数量">
        <n-input-number v-model:value="reassignmentForm.taskCount" class="task-reassignment-count" :min="1"
          :max="sourceTaskCountMax" :disabled="!sourceTaskCountMax" placeholder="输入每人领取数量" />
      </n-form-item>
    </n-form>
    <n-text depth="3">
      {{ reassignmentForm.source === 'selected_scorers'
        ? `每个来源打分人最多领取 ${sourceTaskCountMax} 个任务，共将转移 ${selectedReassignmentTaskTotal} 个任务`
        : `当前剩余 ${availableTaskCount} 个未分配任务，已设置 ${selectedReassignmentTaskTotal} 个` }}
    </n-text>

    <template #footer>
      <div class="task-reassignment-actions">
        <n-button @click="reassignmentVisible = false">取消</n-button>
        <n-button type="primary" :loading="reassignmentSubmitting"
          :disabled="!sourceTaskCountMax || !availableScorerOptions.length"
          @click="submitTaskReassignment">确认分配</n-button>
      </div>
    </template>
  </n-modal>
</template>
