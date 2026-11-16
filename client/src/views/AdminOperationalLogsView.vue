<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useMessage } from 'naive-ui';
import { imageApi } from '../services/images';
import type { AdminOperationalLogEntry, AdminOperationalLogPage } from '../types/image';
import { formatDateTime } from '../utils/time';

const message = useMessage();
const loading = ref(false);
const result = ref<AdminOperationalLogPage | null>(null);
const page = ref(1);
const pageSize = ref(50);
const level = ref<string | null>(null);
const source = ref<string | null>(null);
const code = ref<string | null>(null);
const search = ref('');
const activeEntry = ref<AdminOperationalLogEntry | null>(null);
const detailVisible = ref(false);
const autoRefresh = ref(true);
let refreshTimer: number | null = null;

const entries = computed(() => result.value?.entries || []);
const total = computed(() => result.value?.total || 0);
const summary = computed(() => result.value?.summary || { byLevel: {}, bySource: {}, byCode: {} });
const sourceOptions = computed(() => (result.value?.availableSources || []).map(value => ({ label: sourceLabel(value), value })));
const levelOptions = [
  { label: '严重错误', value: 'critical' },
  { label: '错误', value: 'error' },
  { label: '警告', value: 'warning' }
];

function sourceLabel(value: string) {
  return {
    api: 'API 服务',
    'thumbnail-worker': '缩略图 Worker',
    'task-generation-worker': '任务下发 Worker'
  }[value] || value;
}

function levelLabel(value: string) {
  return { critical: '严重', error: '错误', warning: '警告' }[value] || value;
}

function levelType(value: string) {
  return value === 'critical' || value === 'error' ? 'error' : 'warning';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '读取日志失败';
}

async function loadLogs(nextPage = page.value, silent = false) {
  if (!silent) loading.value = true;
  try {
    result.value = await imageApi.adminOperationalLogs({
      page: nextPage,
      pageSize: pageSize.value,
      level: level.value,
      source: source.value,
      code: code.value,
      search: search.value.trim() || null
    });
    page.value = result.value.page;
  } catch (error) {
    if (!silent) message.error(errorMessage(error));
  } finally {
    if (!silent) loading.value = false;
  }
}

function applyFilters() {
  void loadLogs(1);
}

function clearFilters() {
  level.value = null;
  source.value = null;
  code.value = null;
  search.value = '';
  void loadLogs(1);
}

function openDetail(entry: AdminOperationalLogEntry) {
  activeEntry.value = entry;
  detailVisible.value = true;
}

function paginationPrefix({ itemCount }: { itemCount?: number }) {
  return `共 ${itemCount ?? total.value} 条日志`;
}

function jsonText(value: unknown) {
  return value == null ? '-' : JSON.stringify(value, null, 2);
}

onMounted(() => {
  void loadLogs();
  refreshTimer = window.setInterval(() => {
    if (autoRefresh.value && page.value === 1) void loadLogs(1, true);
  }, 15_000);
});

onBeforeUnmount(() => {
  if (refreshTimer != null) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="admin-page operational-log-page">
    <div class="admin-page-header operational-log-header">
      <div>
        <n-h2 class="page-title">线上日志</n-h2>
        <n-text depth="3">集中查看 API、任务下发和缩略图 Worker 的结构化错误</n-text>
      </div>
      <n-space align="center">
        <n-switch v-model:value="autoRefresh" />
        <n-text depth="3">15 秒自动刷新</n-text>
        <n-button secondary :loading="loading" @click="loadLogs()">立即刷新</n-button>
      </n-space>
    </div>

    <section class="operational-log-summary">
      <div><span>筛选后日志</span><strong>{{ total.toLocaleString() }}</strong></div>
      <div class="is-critical"><span>严重错误</span><strong>{{ (summary.byLevel.critical || 0).toLocaleString() }}</strong></div>
      <div class="is-error"><span>错误</span><strong>{{ (summary.byLevel.error || 0).toLocaleString() }}</strong></div>
      <div><span>PostgreSQL XX002</span><strong>{{ (summary.byCode.XX002 || 0).toLocaleString() }}</strong></div>
    </section>

    <div class="table-shell operational-log-shell">
      <div class="operational-log-filters">
        <n-select v-model:value="level" clearable :options="levelOptions" placeholder="错误级别" />
        <n-select v-model:value="source" clearable :options="sourceOptions" placeholder="日志来源" />
        <n-input v-model:value="code" clearable placeholder="错误码，如 XX002" @keyup.enter="applyFilters" />
        <n-input v-model:value="search" clearable placeholder="搜索接口、用户、任务或错误信息" @keyup.enter="applyFilters" />
        <n-button type="primary" @click="applyFilters">查询</n-button>
        <n-button secondary @click="clearFilters">清空</n-button>
      </div>

      <n-alert v-if="result?.truncated" type="warning" :bordered="false" class="operational-log-truncated">
        日志数据量较大，当前只读取最近约 16 MB。请增加筛选条件定位问题。
      </n-alert>

      <div class="operational-log-table-wrap">
        <n-spin :show="loading">
          <n-table v-if="entries.length" :bordered="false" :single-line="false" size="small">
            <thead>
              <tr>
                <th>时间</th><th>级别 / 来源</th><th>API 说明</th><th>错误码</th><th>错误摘要</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in entries" :key="entry.id">
                <td class="operational-log-time">{{ formatDateTime(entry.timestamp) }}</td>
                <td>
                  <div class="operational-log-tags">
                    <n-tag size="small" :type="levelType(entry.level)">{{ levelLabel(entry.level) }}</n-tag>
                    <n-tag size="small" :bordered="false">{{ sourceLabel(entry.source) }}</n-tag>
                  </div>
                </td>
                <td class="operational-log-api">
                  <strong>{{ entry.api?.description || (entry.kind === 'console' ? '后台进程日志' : '系统运行错误') }}</strong>
                  <span v-if="entry.api?.path">{{ entry.api.method }} {{ entry.api.path }}</span>
                  <span v-if="entry.api?.actor?.username">操作人：{{ entry.api.actor.username }}</span>
                </td>
                <td>
                  <n-tag v-if="entry.code" size="small" :type="entry.code === 'XX002' ? 'error' : 'default'">
                    {{ entry.code }}
                  </n-tag>
                  <span v-else>-</span>
                  <small v-if="entry.status">HTTP {{ entry.status }}</small>
                </td>
                <td class="operational-log-message">{{ entry.message }}</td>
                <td><n-button size="small" secondary @click="openDetail(entry)">查看详情</n-button></td>
              </tr>
            </tbody>
          </n-table>
          <div v-else class="empty">{{ loading ? '正在读取日志...' : '当前筛选条件下没有日志' }}</div>
        </n-spin>
      </div>
      <div class="operational-log-footer">
        <n-pagination v-if="total" :page="page" :page-size="pageSize" :item-count="total" show-size-picker
          :page-sizes="[20, 50, 100]" :prefix="paginationPrefix"
          @update:page="(next: number) => void loadLogs(next)"
          @update:page-size="(next: number) => { pageSize = next; void loadLogs(1); }" />
      </div>
    </div>
  </div>

  <n-modal v-model:show="detailVisible" preset="card" title="日志详情" :bordered="false"
    class="operational-log-detail-modal" content-scrollable>
    <div v-if="activeEntry" class="operational-log-detail">
      <div class="operational-log-detail-grid">
        <div><span>时间</span><strong>{{ formatDateTime(activeEntry.timestamp) }}</strong></div>
        <div><span>来源</span><strong>{{ sourceLabel(activeEntry.source) }}</strong></div>
        <div><span>错误码</span><strong>{{ activeEntry.code || '-' }}</strong></div>
        <div><span>HTTP 状态</span><strong>{{ activeEntry.status || '-' }}</strong></div>
        <div><span>接口说明</span><strong>{{ activeEntry.api?.description || '-' }}</strong></div>
        <div><span>请求编号</span><strong>{{ activeEntry.api?.requestId || '-' }}</strong></div>
      </div>
      <section><span>错误摘要</span><p>{{ activeEntry.message }}</p></section>
      <section v-if="activeEntry.error?.detail"><span>PostgreSQL 详情</span><p>{{ activeEntry.error.detail }}</p></section>
      <section v-if="activeEntry.error?.hint"><span>PostgreSQL 建议</span><p>{{ activeEntry.error.hint }}</p></section>
      <section v-if="activeEntry.api"><span>API 元数据</span><pre>{{ jsonText(activeEntry.api) }}</pre></section>
      <section v-if="activeEntry.metadata"><span>运行元数据</span><pre>{{ jsonText(activeEntry.metadata) }}</pre></section>
      <section v-if="activeEntry.error"><span>错误元数据</span><pre>{{ jsonText(activeEntry.error) }}</pre></section>
    </div>
  </n-modal>
</template>
