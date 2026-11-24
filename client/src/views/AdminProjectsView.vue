<script setup lang="ts">
import { NText, NDataTable, NPagination, NModal, NForm, NFormItem, NSelect, NSpace, NRadioGroup, NRadioButton, NSwitch, NInputNumber, NUpload, NAlert, NCheckbox } from 'naive-ui';
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NInput, NPopover, NProgress, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import { authApi } from '../services/auth';
import { imageApi } from '../services/images';
import type { ProjectItem, SubjectItem } from '../types/image';
import { formatDateTime } from '../utils/time';
import { useProjectTaskGeneration } from '../features/projects/useProjectTaskGeneration';

const message = useMessage();
const dialog = useDialog();
const loading = ref(false);
const submitting = ref(false);
const projectModalVisible = ref(false);
const projects = ref<ProjectItem[]>([]);
const projectTotal = ref(0);
const projectPage = ref(1);
const projectPageSize = ref(10);
const packages = ref<SubjectItem[]>([]);
const teams = ref<Array<{ id: string; name: string; userCount?: number }>>([]);
const editingProject = ref<ProjectItem | null>(null);
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
const {
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
} = useProjectTaskGeneration({ message, submitting, loadData });

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function taskStatusLabel(status: ProjectItem['taskStatus'], row?: ProjectItem) {
  if (row && row.totalTaskCount > 0 && row.completedTaskCount === row.totalTaskCount && row.availableTaskCount > 0) {
    return '已下发任务完成';
  }
  return {
    task_pending: '任务未开始',
    scoring: '打分中',
    task_completed: '打分任务已完成'
  }[status] || '任务未开始';
}

function taskStatusType(status: ProjectItem['taskStatus'], row?: ProjectItem) {
  if (row && row.totalTaskCount > 0 && row.completedTaskCount === row.totalTaskCount) return 'success';
  if (status === 'task_completed') return 'success';
  if (status === 'scoring') return 'warning';
  return 'default';
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
  return h(NTag, { size: 'small', type: taskStatusType(row.taskStatus, row) }, {
    default: () => taskStatusLabel(row.taskStatus, row)
  });
}

function renderPackages(row: ProjectItem) {
  const packageNames = row.packages?.map(pkg => pkg.name) || [];
  if (!packageNames.length) return h('span', { class: 'table-muted' }, row.packageName || '未配置');
  const visibleTags = packageNames.slice(0, 2).map((name, index) =>
    h(NTag, { key: index, size: 'small', type: 'info', bordered: false, class: 'project-package-tag' }, {
      default: () => h('span', { title: name }, name)
    })
  );
  if (packageNames.length > 2) {
    visibleTags.push(h(NPopover, { trigger: 'hover', placement: 'bottom' }, {
      trigger: () => h(NTag, { size: 'small', bordered: false }, { default: () => `+${packageNames.length - 2}` }),
      default: () => h('div', { class: 'project-package-popover' }, packageNames.map(name => h('div', name)))
    }));
  }
  return h('div', { class: 'project-package-tags' }, visibleTags);
}

function taskActionLabel(row: ProjectItem) {
  const available = row.availableTaskCount ?? row.taskTemplateCount;
  if (available) return row.taskStatus === 'scoring' ? '继续下发' : '开始任务';
  return row.taskTemplateCount > 0 ? '任务已全部下发' : '缺少任务文件';
}

const columns: DataTableColumns<ProjectItem> = [
  { title: '项目名称', key: 'name', width: 200, ellipsis: { tooltip: true } },
  {
    title: '关联图包',
    key: 'packages',
    minWidth: 220,
    render: renderPackages
  },
  { title: '图片数', key: 'imageCount', width: 90 },
  { title: '任务数', key: 'totalTaskCount', width: 90 },
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
    <div class="table-shell project-list-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>项目列表</strong>
          <n-text depth="3">共 {{ projectTotal }} 个项目</n-text>
        </div>
        <n-button type="primary" @click="openCreateProject">新建项目</n-button>
      </div>
      <n-data-table v-if="projects.length" :columns="columns" :data="projects" :loading="loading" :bordered="false" remote
        :scroll-x="1440" />
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
          <n-select v-model:value="projectForm.packageIds" multiple filterable :max-tag-count="2" :options="packageOptions"
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
        <n-form-item label="分配方式">
          <n-radio-group v-model:value="taskGenerationMode" size="small">
            <n-radio-button value="random">按数量分配</n-radio-button>
            <n-radio-button value="exact">按清单精确分配</n-radio-button>
          </n-radio-group>
        </n-form-item>
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
        <template v-if="taskGenerationMode === 'random'">
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
        </template>
        <template v-else>
          <div class="task-allocation-summary" aria-label="精确任务分配汇总">
            <n-tag size="small" type="info" :bordered="false">模板任务 {{ taskTemplateCount }}</n-tag>
            <n-tag size="small" :bordered="false">可下发 {{ availableTaskCount }}</n-tag>
            <n-tag v-if="exactAssignmentSummary" size="small" type="success" :bordered="false">
              清单任务 {{ exactAssignmentSummary.taskCount }}
            </n-tag>
            <n-tag v-if="exactAssignmentSummary" size="small" :bordered="false">
              原人 {{ exactAssignmentSummary.mappedScorerCount }}
            </n-tag>
            <n-tag v-if="exactAssignmentSummary" size="small" type="warning" :bordered="false">
              兜底 {{ exactAssignmentSummary.fallbackTaskCount }}
            </n-tag>
          </div>
          <div class="exact-task-assignment-panel">
            <n-form-item label="精确分配清单">
              <n-upload accept=".json,application/json" :show-file-list="false" :custom-request="readExactAssignmentFile">
                <n-button secondary>选择 JSON 清单</n-button>
              </n-upload>
              <n-text v-if="exactAssignmentFile" depth="3" class="exact-task-assignment-filename">
                {{ exactAssignmentFile.name }}
              </n-text>
            </n-form-item>
            <n-form-item label="未匹配任务兜底账号">
              <n-select v-model:value="exactFallbackScorer" filterable clearable :options="taskScorerOptions"
                :loading="taskScorersLoading" placeholder="选择测试账号" />
            </n-form-item>
            <n-alert type="info" :show-icon="false">
              清单按 sourceTaskId 精确匹配当前项目图包；已填写 scorer 或 sourceScorer 的任务分给原打分人，其余任务分给兜底账号。
            </n-alert>
          </div>
        </template>
      </n-form>
      <n-space justify="end">
        <n-button @click="taskModalVisible = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="startTask">创建任务</n-button>
      </n-space>
    </n-modal>
  </div>
</template>
