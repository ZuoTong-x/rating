<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import { NButton, NSwitch, NTag, NTooltip, useMessage, type DataTableColumns } from 'naive-ui';
import { useRouter } from 'vue-router';
import { imageApi } from '../services/images';
import type { ProjectItem } from '../types/image';
import { formatDateTime } from '../utils/time';

const router = useRouter();
const message = useMessage();
const loading = ref(false);
const subjects = ref<ProjectItem[]>([]);
const lockBusy = ref(new Set<string>());

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function taskStatusLabel(row: ProjectItem) {
  if (row.tasksLocked) return '任务已锁定';
  if (row.totalTaskCount > 0 && row.completedTaskCount === row.totalTaskCount && row.availableTaskCount > 0) {
    return '已下发任务完成';
  }
  return {
    task_pending: '任务未开始',
    scoring: '打分中',
    task_completed: '打分任务已完成'
  }[row.taskStatus] || '任务未开始';
}

function taskStatusType(row: ProjectItem) {
  if (row.tasksLocked) return 'warning';
  if (row.totalTaskCount > 0 && row.completedTaskCount === row.totalTaskCount) return 'success';
  if (row.taskStatus === 'scoring') return 'warning';
  return 'default';
}

function setLockBusy(projectId: string, busy: boolean) {
  const next = new Set(lockBusy.value);
  if (busy) next.add(projectId);
  else next.delete(projectId);
  lockBusy.value = next;
}

async function updateTaskLock(row: ProjectItem, locked: boolean) {
  setLockBusy(row._id, true);
  try {
    const result = await imageApi.updateProjectTaskLock(row._id, locked);
    const index = subjects.value.findIndex(item => item._id === row._id);
    if (index >= 0) subjects.value.splice(index, 1, result.project);
    message.success(locked
      ? '项目任务已锁定，打分人将看不到任务和数量'
      : '项目任务已解锁，已分配任务现在对打分人可见');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    setLockBusy(row._id, false);
  }
}

async function loadSubjects() {
  loading.value = true;
  try {
    subjects.value = await imageApi.projects();
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

const columns: DataTableColumns<ProjectItem> = [
  { title: '项目', key: 'name', minWidth: 180 },
  { title: '图片数', key: 'imageCount', width: 90 },
  { title: '目录数', key: 'categoryCount', width: 90 },
  {
    title: '任务状态',
    key: 'taskStatus',
    width: 150,
    render: row => h(NTag, { size: 'small', type: taskStatusType(row) }, {
      default: () => taskStatusLabel(row)
    })
  },
  {
    title: () => h('span', { class: 'admin-task-lock-heading' }, [
      '任务锁定',
      h(NTooltip, { placement: 'top-start' }, {
        trigger: () => h('span', {
          class: 'admin-task-lock-help',
          tabindex: 0,
          'aria-label': '查看任务锁定说明'
        }, 'i'),
        default: () => h('span', { class: 'admin-task-lock-tooltip' },
          '新建项目默认锁定。锁定期间可以继续生成和分配任务，但打分人的项目列表、任务列表和任务数量均不会显示；完成下发后请在此手动解锁。')
      })
    ]),
    key: 'tasksLocked',
    width: 150,
    render: row => h('div', { class: 'admin-task-lock-control' }, [
      h(NSwitch, {
        value: row.tasksLocked,
        loading: lockBusy.value.has(row._id),
        onUpdateValue: (locked: boolean) => void updateTaskLock(row, locked)
      }),
      h('span', row.tasksLocked ? '打分人不可见' : '已开放')
    ])
  },
  { title: '更新时间', key: 'updatedAt', width: 180, render: row => formatDateTime(row.updatedAt) },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    fixed: 'right',
    render: row => h(NButton, {
      size: 'small',
      secondary: true,
      disabled: row.taskStatus === 'task_pending',
      onClick: () => router.push(`/admin/projects/${encodeURIComponent(row._id)}/tasks`)
    }, { default: () => '查看任务' })
  }
];

onMounted(() => void loadSubjects());
</script>

<template>
  <div class="admin-page">
    <div class="table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>任务概览</strong>
          <n-text depth="3">共 {{ subjects.length }} 个项目</n-text>
        </div>
      </div>
      <n-data-table v-if="subjects.length" :columns="columns" :data="subjects" :loading="loading" :bordered="false"
        :scroll-x="980" />
      <div v-else class="empty">{{ loading ? '正在加载...' : '暂无任务数据' }}</div>
    </div>
  </div>
</template>
