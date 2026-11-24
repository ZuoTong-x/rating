<script setup lang="ts">
import { NText, NDataTable, NModal, NForm, NFormItem, NInput, NSpace } from 'naive-ui';
import { h, onMounted, reactive, ref } from 'vue';
import { NButton, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import { authApi } from '../services/auth';
import type { AccountTeam, AvailabilityStatus } from '../types/auth';
import { formatDateTime } from '../utils/time';

const dialog = useDialog();
const message = useMessage();
const loading = ref(false);
const submitting = ref(false);
const modalVisible = ref(false);
const editingTeam = ref<AccountTeam | null>(null);
const teams = ref<AccountTeam[]>([]);
const form = reactive({
  name: ''
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function statusLabel(status: AvailabilityStatus) {
  return status === 'disabled' ? '已禁用' : '启用';
}

function statusType(status: AvailabilityStatus) {
  return status === 'disabled' ? 'error' : 'success';
}

async function loadTeams() {
  loading.value = true;
  try {
    teams.value = await authApi.teams();
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

function openCreateModal() {
  editingTeam.value = null;
  form.name = '';
  modalVisible.value = true;
}

function openEditModal(team: AccountTeam) {
  editingTeam.value = team;
  form.name = team.name;
  modalVisible.value = true;
}

async function submitTeam() {
  const name = form.name.trim();
  if (!name) {
    message.error('请输入团队名称');
    return;
  }
  submitting.value = true;
  try {
    if (editingTeam.value) {
      await authApi.updateTeam(editingTeam.value.id, { name });
      message.success('团队已更新');
    } else {
      await authApi.createTeam(name);
      message.success('团队已创建');
    }
    modalVisible.value = false;
    await loadTeams();
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    submitting.value = false;
  }
}

function toggleTeamStatus(team: AccountTeam) {
  const nextStatus: AvailabilityStatus = team.status === 'disabled' ? 'enabled' : 'disabled';
  dialog.warning({
    title: nextStatus === 'disabled' ? '禁用团队' : '启用团队',
    content: nextStatus === 'disabled'
      ? `禁用后“${team.name}”下的账号将无法登录，也不能被分配到项目。`
      : `确认启用“${team.name}”？`,
    positiveText: nextStatus === 'disabled' ? '禁用' : '启用',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await authApi.updateTeam(team.id, { status: nextStatus });
        message.success(nextStatus === 'disabled' ? '团队已禁用' : '团队已启用');
        await loadTeams();
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      }
    }
  });
}

function deleteTeam(team: AccountTeam) {
  const hasUsage = Boolean((team.userCount || 0) || (team.projectCount || 0));
  if (hasUsage) return;
  dialog.warning({
    title: '删除团队',
    content: `确认删除“${team.name}”？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await authApi.deleteTeam(team.id);
        message.success('团队已删除');
        await loadTeams();
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      }
    }
  });
}

const columns: DataTableColumns<AccountTeam> = [
  { title: '团队名称', key: 'name', minWidth: 200 },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render: row => h(NTag, { size: 'small', type: statusType(row.status) }, { default: () => statusLabel(row.status) })
  },
  { title: '账号数', key: 'userCount', width: 110, render: row => row.userCount || 0 },
  { title: '关联项目', key: 'projectCount', width: 120, render: row => row.projectCount || 0 },
  { title: '创建时间', key: 'createdAt', width: 180, render: row => row.createdAt ? formatDateTime(row.createdAt) : '-' },
  {
    title: '操作',
    key: 'actions',
    width: 220,
    fixed: 'right',
    render: row => h('div', { class: 'table-actions' }, [
      h(NButton, { size: 'small', secondary: true, onClick: () => openEditModal(row) }, { default: () => '编辑' }),
      h(NButton, {
        size: 'small',
        tertiary: true,
        type: row.status === 'disabled' ? 'success' : 'warning',
        onClick: () => toggleTeamStatus(row)
      }, { default: () => row.status === 'disabled' ? '启用' : '禁用' }),
      h(NButton, {
        size: 'small',
        tertiary: true,
        type: 'error',
        disabled: Boolean((row.userCount || 0) || (row.projectCount || 0)),
        title: (row.userCount || 0) || (row.projectCount || 0) ? '仍有关联账号或项目，不能删除' : undefined,
        onClick: () => deleteTeam(row)
      }, { default: () => '删除' })
    ])
  }
];

onMounted(() => void loadTeams());
</script>

<template>
  <div class="admin-page">
    <div class="table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>团队管理</strong>
          <n-text depth="3">共 {{ teams.length }} 个团队</n-text>
        </div>
        <n-button type="primary" @click="openCreateModal">新建团队</n-button>
      </div>
      <n-data-table v-if="teams.length" :columns="columns" :data="teams" :loading="loading" :bordered="false"
        :scroll-x="900" />
      <div v-else class="empty">{{ loading ? '正在加载...' : '暂无团队' }}</div>
    </div>

    <n-modal v-model:show="modalVisible" preset="card" class="account-create-modal"
      :title="editingTeam ? '编辑团队' : '新建团队'" :bordered="false">
      <n-form label-placement="top">
        <n-form-item label="团队名称">
          <n-input v-model:value="form.name" autofocus maxlength="60" placeholder="请输入团队名称" @keyup.enter="submitTeam" />
        </n-form-item>
      </n-form>
      <n-space justify="end">
        <n-button @click="modalVisible = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submitTeam">保存</n-button>
      </n-space>
    </n-modal>
  </div>
</template>
