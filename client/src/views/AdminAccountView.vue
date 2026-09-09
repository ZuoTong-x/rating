<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import { NButton, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import BulkNameTagEditor from '../components/BulkNameTagEditor.vue';
import { authApi } from '../services/auth';
import type { AuthUser, AvailabilityStatus } from '../types/auth';
import { formatDateTime, shanghaiDateToUtc } from '../utils/time';

const dialog = useDialog();
const message = useMessage();
const loading = ref(false);
const creating = ref(false);
const createVisible = ref(false);
const batchCreating = ref(false);
const batchVisible = ref(false);
const editVisible = ref(false);
const passwordVisible = ref(false);
const editingUser = ref<AuthUser | null>(null);
const passwordUser = ref<AuthUser | null>(null);
const users = ref<AuthUser[]>([]);
const teamOptions = ref<Array<{ label: string; value: string }>>([]);
const teamFilterOptions = ref<Array<{ label: string; value: string }>>([]);
const userTotal = ref(0);
const userPage = ref(1);
const userPageSize = ref(10);
const filters = reactive({
  username: '',
  teamId: null as string | null,
  lastLoginRange: null as [string, string] | null
});
const createForm = reactive({
  username: '',
  password: '',
  teamNames: [] as string[]
});
const batchForm = reactive({
  usernames: [] as string[],
  password: '',
  teamName: null as string | null
});
const editForm = reactive({
  teamNames: [] as string[]
});
const passwordForm = reactive({
  newPassword: ''
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

const hasFilters = computed(() => Boolean(
  filters.username.trim() || filters.teamId || filters.lastLoginRange
));

function loginRangeQuery() {
  if (!filters.lastLoginRange) return {};
  const [start, end] = filters.lastLoginRange;
  return {
    lastLoginStart: shanghaiDateToUtc(start),
    lastLoginEnd: shanghaiDateToUtc(end, 1)
  };
}

function userQuery(page: number, pageSize: number) {
  return {
    page,
    pageSize,
    username: filters.username.trim() || null,
    teamId: filters.teamId,
    ...loginRangeQuery()
  };
}

async function loadUsers(page = userPage.value, pageSize = userPageSize.value) {
  loading.value = true;
  try {
    const result = await authApi.scorerUsers(userQuery(page, pageSize));
    users.value = result.users;
    userTotal.value = result.total;
    userPage.value = result.page;
    userPageSize.value = result.pageSize;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function loadTeamOptions() {
  try {
    const teams = await authApi.scorerTeams();
    teamOptions.value = teams.map(team => ({
      label: team.status === 'disabled' ? `${team.name}（禁用）` : team.name,
      value: team.name
    }));
    teamFilterOptions.value = teams.map(team => ({
      label: `${team.name}${team.status === 'disabled' ? '（禁用）' : ''}${team.userCount != null ? ` (${team.userCount} 人)` : ''}`,
      value: team.id
    }));
  } catch (error) {
    message.error(errorMessage(error));
  }
}

function changeAccountPage(page: number) {
  void loadUsers(page, userPageSize.value);
}

function changeAccountPageSize(pageSize: number) {
  void loadUsers(1, pageSize);
}

function accountPaginationPrefix({ itemCount }: { itemCount?: number }) {
  return `共 ${itemCount ?? userTotal.value} 个账号`;
}

function applyFilters() {
  void loadUsers(1, userPageSize.value);
}

function resetFilters() {
  filters.username = '';
  filters.teamId = null;
  filters.lastLoginRange = null;
  void loadUsers(1, userPageSize.value);
}

function accountStatusLabel(user: AuthUser) {
  if (user.status === 'disabled') return '已禁用';
  if (user.disabledByTeam) return '团队禁用';
  return '启用';
}

function accountStatusType(user: AuthUser) {
  if (user.status === 'disabled') return 'error';
  if (user.disabledByTeam) return 'warning';
  return 'success';
}

function openCreateModal() {
  createForm.username = '';
  createForm.password = '';
  createForm.teamNames = [];
  createVisible.value = true;
}

function openBatchModal() {
  batchForm.usernames = [];
  batchForm.password = '';
  batchForm.teamName = null;
  batchVisible.value = true;
}

function openEditModal(user: AuthUser) {
  editingUser.value = user;
  editForm.teamNames = (user.teams || []).map(team => team.name);
  editVisible.value = true;
}

function openPasswordModal(user: AuthUser) {
  passwordUser.value = user;
  passwordForm.newPassword = '';
  passwordVisible.value = true;
}

function strongPassword(value: string) {
  return value.length >= 8 && value.length <= 100
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /[^A-Za-z0-9]/.test(value);
}

function randomIndex(maxExclusive: number) {
  const values = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  do {
    window.crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return values[0] % maxExclusive;
}

function randomCharacter(characters: string) {
  return characters[randomIndex(characters.length)];
}

function shuffleCharacters(characters: string[]) {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join('');
}

function generateRandomPassword() {
  const groups = [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz',
    '0123456789',
    '!@#$%^&*_-+=?'
  ];
  const allCharacters = groups.join('');
  const characters = groups.map(group => randomCharacter(group));
  while (characters.length < 16) characters.push(randomCharacter(allCharacters));
  passwordForm.newPassword = shuffleCharacters(characters);
  message.success('已生成 16 位随机密码，可点击输入框右侧图标查看');
}

async function createUser() {
  const username = createForm.username.trim();
  if (!username) {
    message.error('请输入打分人');
    return;
  }
  if (!createForm.password) {
    message.error('请输入符合规则的密码');
    return;
  }
  creating.value = true;
  try {
    const result = await authApi.createScorerUser(username, createForm.password || undefined, createForm.teamNames);
    createVisible.value = false;
    message.success(`已创建“${result.user.username}”`);
    await Promise.all([loadUsers(1, userPageSize.value), loadTeamOptions()]);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}

async function createUsersInBatch() {
  if (!batchForm.usernames.length) {
    message.error('请先粘贴或输入至少一个打分人');
    return;
  }
  if (!batchForm.password) {
    message.error('请输入符合规则的统一密码');
    return;
  }
  batchCreating.value = true;
  try {
    const result = await authApi.createScorerUsers({
      usernames: batchForm.usernames,
      password: batchForm.password || undefined,
      teamNames: batchForm.teamName ? [batchForm.teamName] : []
    });
    batchVisible.value = false;
    const skippedText = result.skippedCount
      ? `，跳过 ${result.skippedCount} 个已存在账号`
      : '';
    message.success(`已创建 ${result.createdCount} 个账号${skippedText}`);
    await Promise.all([loadUsers(1, userPageSize.value), loadTeamOptions()]);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    batchCreating.value = false;
  }
}

async function updateUser() {
  const user = editingUser.value;
  if (!user) return;
  creating.value = true;
  try {
    const result = await authApi.updateScorerUser(user.id, {
      teamNames: editForm.teamNames
    });
    editVisible.value = false;
    message.success(`已更新“${result.user.username}”`);
    await Promise.all([loadUsers(userPage.value, userPageSize.value), loadTeamOptions()]);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}

async function updatePassword() {
  const user = passwordUser.value;
  if (!user) return;
  if (!passwordForm.newPassword) {
    message.error('请输入新密码');
    return;
  }
  if (!strongPassword(passwordForm.newPassword)) {
    message.error('密码至少 8 位，并包含大写字母、小写字母和特殊字符');
    return;
  }
  creating.value = true;
  try {
    await authApi.updateScorerUser(user.id, { password: passwordForm.newPassword });
    passwordVisible.value = false;
    message.success(`已更新“${user.username}”的密码，下次登录需修改密码`);
    await loadUsers(userPage.value, userPageSize.value);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}

function deleteUser(user: AuthUser) {
  dialog.warning({
    title: '删除打分账号',
    content: `确认删除“${user.username}”？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await authApi.deleteScorerUser(user.id);
        message.success(`已删除“${user.username}”`);
        const nextPage = users.value.length === 1 && userPage.value > 1 ? userPage.value - 1 : userPage.value;
        await loadUsers(nextPage, userPageSize.value);
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      }
    }
  });
}

function toggleUserStatus(user: AuthUser) {
  const nextStatus: AvailabilityStatus = user.status === 'disabled' ? 'enabled' : 'disabled';
  dialog.warning({
    title: nextStatus === 'disabled' ? '禁用账号' : '启用账号',
    content: nextStatus === 'disabled'
      ? `禁用后“${user.username}”将无法登录，也不能被分配到新项目。`
      : `确认启用“${user.username}”？`,
    positiveText: nextStatus === 'disabled' ? '禁用' : '启用',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await authApi.updateScorerUser(user.id, { status: nextStatus });
        message.success(nextStatus === 'disabled' ? '账号已禁用' : '账号已启用');
        await loadUsers(userPage.value, userPageSize.value);
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      }
    }
  });
}

const columns: DataTableColumns<AuthUser> = [
  { title: '打分人', key: 'username', minWidth: 180 },
  {
    title: '团队',
    key: 'teams',
    minWidth: 180,
    render: row => h('div', { class: 'account-team-tags' }, (row.teams || []).length
      ? (row.teams || []).map(team => h(
        NTag,
        { size: 'small', type: team.status === 'disabled' ? 'warning' : 'info', bordered: false },
        { default: () => team.status === 'disabled' ? `${team.name}（禁用）` : team.name }
      ))
      : [h('span', { class: 'table-muted' }, '未分组')])
  },
  {
    title: '状态',
    key: 'status',
    width: 120,
    render: row => h(NTag, { size: 'small', type: accountStatusType(row) }, { default: () => accountStatusLabel(row) })
  },
  {
    title: '密码状态',
    key: 'passwordStatus',
    width: 130,
    render: row => h(NTag, {
      size: 'small',
      type: row.mustChangePassword ? 'warning' : 'success'
    }, { default: () => row.mustChangePassword ? '待首次修改' : '已设置' })
  },
  {
    title: '角色',
    key: 'role',
    width: 160,
    render: () => h(NTag, { size: 'small', type: 'info' }, { default: () => '打分人' })
  },
  { title: '最后登录', key: 'lastLoginAt', width: 180, render: row => row.lastLoginAt ? formatDateTime(row.lastLoginAt) : '未登录' },
  { title: '创建时间', key: 'createdAt', width: 180, render: row => row.createdAt ? formatDateTime(row.createdAt) : '-' },
  {
    title: '操作',
    key: 'actions',
    width: 300,
    fixed: 'right',
    render: row => h('div', { class: 'table-actions' }, [
      h(NButton, {
        size: 'small',
        secondary: true,
        onClick: () => openEditModal(row)
      }, { default: () => '编辑' }),
      h(NButton, {
        size: 'small',
        secondary: true,
        onClick: () => openPasswordModal(row)
      }, { default: () => '密码管理' }),
      h(NButton, {
        size: 'small',
        tertiary: true,
        type: row.status === 'disabled' ? 'success' : 'warning',
        onClick: () => toggleUserStatus(row)
      }, { default: () => row.status === 'disabled' ? '启用' : '禁用' }),
      h(NButton, {
        size: 'small',
        tertiary: true,
        type: 'error',
        onClick: () => deleteUser(row)
      }, { default: () => '删除' })
    ])
  }
];

async function initialize() {
  await Promise.all([loadUsers(), loadTeamOptions()]);
}

onMounted(() => void initialize());
</script>

<template>
  <div class="admin-page admin-account-content">
    <div class="table-shell account-table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>打分账号</strong>
          <n-text depth="3">共 {{ userTotal }} 个打分账号</n-text>
        </div>
        <n-space>
          <n-button secondary @click="openBatchModal">批量添加</n-button>
          <n-button type="primary" @click="openCreateModal">添加账号</n-button>
        </n-space>
      </div>
      <div class="account-filter-bar">
        <n-input v-model:value="filters.username" clearable placeholder="按名称筛选" @keyup.enter="applyFilters" />
        <n-select v-model:value="filters.teamId" clearable filterable :options="teamFilterOptions" placeholder="按团队筛选" />
        <n-date-picker v-model:value="filters.lastLoginRange" type="daterange" value-format="yyyy-MM-dd" clearable placeholder="按最后登录日期筛选" />
        <div class="account-filter-actions">
          <n-button type="primary" @click="applyFilters">查询</n-button>
          <n-button :disabled="!hasFilters" @click="resetFilters">重置</n-button>
        </div>
      </div>
      <div class="account-table-body">
        <n-data-table v-if="users.length" class="account-data-table" :columns="columns" :data="users" :loading="loading"
          :bordered="false" remote :scroll-x="1110" />
        <div v-else class="empty">{{ loading ? '正在加载...' : (hasFilters ? '没有符合条件的账号' : '暂无打分账号') }}</div>
      </div>
      <div class="account-table-footer">
        <n-pagination v-if="userTotal" :page="userPage" :page-size="userPageSize" :item-count="userTotal"
          show-size-picker :page-sizes="[10, 20, 50, 100]" :prefix="accountPaginationPrefix"
          @update:page="changeAccountPage" @update:page-size="changeAccountPageSize" />
      </div>
    </div>

    <n-modal v-model:show="batchVisible" preset="card" class="account-batch-modal" title="批量添加打分账号" :bordered="false">
      <n-form label-placement="top">
        <n-form-item label="打分人名单">
          <BulkNameTagEditor v-model="batchForm.usernames" />
        </n-form-item>
        <n-form-item label="统一密码">
          <n-input
            v-model:value="batchForm.password"
            type="password"
            show-password-on="click"
            maxlength="100"
            placeholder="至少 8 位，含大小写字母和特殊字符"
          />
        </n-form-item>
        <n-form-item label="统一所属团队">
          <n-select
            v-model:value="batchForm.teamName"
            clearable
            filterable
            :options="teamOptions"
            placeholder="选择团队（可不选）"
          />
        </n-form-item>
      </n-form>
      <div class="batch-account-summary">
        本次将创建 <strong>{{ batchForm.usernames.length }}</strong> 个账号
      </div>
      <n-space justify="end">
        <n-button @click="batchVisible = false">取消</n-button>
        <n-button type="primary" :loading="batchCreating" @click="createUsersInBatch">批量创建</n-button>
      </n-space>
    </n-modal>

    <n-modal v-model:show="createVisible" preset="card" class="account-create-modal" title="创建打分账号" :bordered="false">
      <n-form label-placement="top">
        <n-form-item label="打分人">
          <n-input v-model:value="createForm.username" autofocus maxlength="100" placeholder="请输入打分人" />
        </n-form-item>
        <n-form-item label="密码">
          <n-input
            v-model:value="createForm.password"
            type="password"
            show-password-on="click"
            maxlength="100"
            placeholder="至少 8 位，含大小写字母和特殊字符"
            @keyup.enter="createUser"
          />
        </n-form-item>
        <n-form-item label="所属团队">
          <n-select v-model:value="createForm.teamNames" multiple filterable tag clearable :options="teamOptions"
            placeholder="选择或输入团队名称" />
        </n-form-item>
      </n-form>
      <n-space justify="end">
        <n-button @click="createVisible = false">取消</n-button>
        <n-button type="primary" :loading="creating" @click="createUser">创建账号</n-button>
      </n-space>
    </n-modal>

    <n-modal v-model:show="editVisible" preset="card" class="account-create-modal" title="编辑打分账号" :bordered="false">
      <n-form label-placement="top">
        <n-form-item label="打分人">
          <n-input :value="editingUser?.username || ''" disabled />
        </n-form-item>
        <n-form-item label="所属团队">
          <n-select v-model:value="editForm.teamNames" multiple filterable tag clearable :options="teamOptions"
            placeholder="选择或输入团队名称" />
        </n-form-item>
      </n-form>
      <n-space justify="end">
        <n-button @click="editVisible = false">取消</n-button>
        <n-button type="primary" :loading="creating" @click="updateUser">保存</n-button>
      </n-space>
    </n-modal>

    <n-modal v-model:show="passwordVisible" preset="card" class="account-password-modal" title="密码管理" :bordered="false">
      <n-alert type="info" :bordered="false" class="account-password-notice">
        系统只保存密码哈希，无法查看旧密码明文。你可以在这里查看密码状态并设置新密码。
      </n-alert>
      <n-form label-placement="top">
        <n-form-item label="打分人">
          <n-input :value="passwordUser?.username || ''" readonly />
        </n-form-item>
        <n-form-item label="当前密码状态">
          <n-tag :type="passwordUser?.mustChangePassword ? 'warning' : 'success'">
            {{ passwordUser?.mustChangePassword ? '待首次修改' : '已设置' }}
          </n-tag>
        </n-form-item>
        <n-form-item label="设置新密码">
          <div class="account-password-input-row">
            <n-input v-model:value="passwordForm.newPassword" type="password" show-password-on="click"
              maxlength="100" placeholder="至少 8 位，含大小写字母和特殊字符" @keyup.enter="updatePassword" />
            <n-button secondary @click="generateRandomPassword">生成随机密码</n-button>
          </div>
        </n-form-item>
      </n-form>
      <n-text depth="3">重置后，该打分人下次登录必须修改密码。</n-text>
      <n-space justify="end" class="account-password-actions">
        <n-button @click="passwordVisible = false">取消</n-button>
        <n-button type="primary" :loading="creating" @click="updatePassword">保存新密码</n-button>
      </n-space>
    </n-modal>
  </div>
</template>
