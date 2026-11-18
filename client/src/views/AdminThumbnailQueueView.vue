<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useDialog, useMessage, type GlobalThemeOverrides } from 'naive-ui';
import { imageApi } from '../services/images';
import { useAppTheme } from '../composables/theme';
import type { ThumbnailPackageQueue, ThumbnailQueueOverview } from '../types/image';
import { formatDateTime } from '../utils/time';

const message = useMessage();
const dialog = useDialog();
const { isDark } = useAppTheme();
const darkPolicyTheme: NonNullable<GlobalThemeOverrides['Card']> = {
  color: 'var(--surface-bg)',
  textColor: 'var(--text-color)',
  titleTextColor: 'var(--text-color)',
  borderColor: 'var(--border-color)'
};
const darkTableTheme: NonNullable<GlobalThemeOverrides['Table']> = {
  borderColor: 'var(--border-soft-color)',
  tdColor: 'var(--surface-bg)',
  thColor: 'var(--surface-muted-bg)',
  tdTextColor: 'var(--text-color)',
  thTextColor: 'var(--text-muted-color)'
};
const loading = ref(false);
const savingSettings = ref(false);
const skippingCompleted = ref(false);
const overview = ref<ThumbnailQueueOverview | null>(null);
const page = ref(1);
const pageSize = ref(25);
const search = ref('');
const searchDraft = ref('');
const packageBusy = ref(new Set<string>());
const priorityDraft = reactive<Record<string, number>>({});
const settingsDraft = reactive({
  daytimeConcurrency: 2,
  nighttimeConcurrency: 6,
  nightStartHour: 22,
  nightEndHour: 8
});
let refreshTimer: number | null = null;
let loadRequestId = 0;
let backgroundLoading = false;

const hourOptions = Array.from({ length: 24 }, (_, hour) => ({
  label: `${String(hour).padStart(2, '0')}:00`,
  value: hour
}));

const counts = computed(() => overview.value?.counts ?? {
  statsReady: false,
  pending: 0, eligiblePending: null, excludedPending: null, processing: 0, ready: 0, failed: 0, total: 0,
  oldestPendingAt: null, completedLastFiveMinutes: 0, ratePerMinute: 0
});
const settings = computed(() => overview.value?.settings ?? null);
const packages = computed(() => overview.value?.packages ?? []);
const totalPackages = computed(() => overview.value?.totalPackages ?? 0);

function formatCount(value: number | null) {
  return value == null ? '统计中' : value.toLocaleString();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function syncDraft(data: ThumbnailQueueOverview, syncSettings: boolean) {
  if (syncSettings) {
    settingsDraft.daytimeConcurrency = data.settings.daytimeConcurrency;
    settingsDraft.nighttimeConcurrency = data.settings.nighttimeConcurrency;
    settingsDraft.nightStartHour = data.settings.nightStartHour;
    settingsDraft.nightEndHour = data.settings.nightEndHour;
  }
  data.packages.forEach(item => {
    if (packageBusy.value.has(item.subjectId)) return;
    priorityDraft[item.subjectId] = item.priority;
  });
}

async function loadOverview(silent = false, force = false) {
  if (silent && !force && (backgroundLoading || loading.value)) return;
  const requestId = ++loadRequestId;
  if (!silent) loading.value = true;
  else backgroundLoading = true;
  try {
    const data = await imageApi.thumbnailQueueOverview({
      page: page.value,
      pageSize: pageSize.value,
      search: search.value
    });
    if (requestId !== loadRequestId) return;
    overview.value = data;
    syncDraft(data, !silent);
  } catch (error) {
    if (!silent && requestId === loadRequestId) {
      page.value = overview.value?.page ?? 1;
      pageSize.value = overview.value?.pageSize ?? 25;
      message.error(errorMessage(error));
    }
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false;
      backgroundLoading = false;
    }
  }
}

function changePage(nextPage: number) {
  page.value = nextPage;
  void loadOverview();
}

function changePageSize(nextPageSize: number) {
  pageSize.value = nextPageSize;
  page.value = 1;
  void loadOverview();
}

function applySearch() {
  search.value = searchDraft.value.trim();
  page.value = 1;
  void loadOverview();
}

async function saveSettings() {
  if (settingsDraft.nightStartHour === settingsDraft.nightEndHour) {
    message.warning('夜间开始和结束时间不能相同');
    return;
  }
  savingSettings.value = true;
  try {
    await imageApi.updateThumbnailQueueSettings({ ...settingsDraft });
    message.success('闲时策略已保存，Worker 最迟数秒内生效');
    await loadOverview(true, true);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    savingSettings.value = false;
  }
}

async function toggleGlobalPause() {
  if (!settings.value) return;
  savingSettings.value = true;
  try {
    await imageApi.updateThumbnailQueueSettings({ globallyPaused: !settings.value.globallyPaused });
    message.success(settings.value.globallyPaused ? '缩略图队列已启动' : '缩略图队列已暂停');
    await loadOverview(true, true);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    savingSettings.value = false;
  }
}

function setPackageBusy(subjectId: string, busy: boolean) {
  const next = new Set(packageBusy.value);
  if (busy) next.add(subjectId);
  else next.delete(subjectId);
  packageBusy.value = next;
}

async function updatePackage(item: ThumbnailPackageQueue, payload: {
  generationEnabled?: boolean;
  paused?: boolean;
  priority?: number;
}, successText: string) {
  setPackageBusy(item.subjectId, true);
  try {
    await imageApi.updateThumbnailPackageControl(item.subjectId, payload);
    message.success(successText);
    await loadOverview(true, true);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    setPackageBusy(item.subjectId, false);
  }
}

function toggleGeneration(item: ThumbnailPackageQueue, enabled: boolean) {
  if (enabled) {
    void updatePackage(item, { generationEnabled: true }, '该图包已加入缩略图队列');
    return;
  }
  dialog.warning({
    title: '停止生成缩略图',
    content: `停止后，“${item.name}”不会再领取新任务，页面将对缺失缩略图的图片使用原图。正在处理的少量图片仍会完成。`,
    positiveText: '停止生成',
    negativeText: '取消',
    onPositiveClick: () => updatePackage(item, { generationEnabled: false }, '该图包已停止生成缩略图')
  });
}

function togglePackagePause(item: ThumbnailPackageQueue, paused: boolean) {
  void updatePackage(item, { paused }, paused ? '该图包已暂停' : '该图包已恢复');
}

function prioritize(item: ThumbnailPackageQueue) {
  const highest = overview.value?.maxPriority ?? 0;
  const priority = Math.min(100000, highest + 10);
  priorityDraft[item.subjectId] = priority;
  void updatePackage(item, { priority }, '已将该图包调整为优先处理');
}

function savePriority(item: ThumbnailPackageQueue) {
  const priority = Number(priorityDraft[item.subjectId]);
  if (!Number.isInteger(priority) || priority < -100000 || priority > 100000) {
    message.warning('优先级必须是 -100000 到 100000 之间的整数');
    return;
  }
  void updatePackage(item, { priority }, '优先级已更新');
}

async function retryFailed(item?: ThumbnailPackageQueue) {
  try {
    const result = item
      ? await imageApi.retryThumbnailPackageFailed(item.subjectId)
      : await imageApi.retryAllThumbnailFailed();
    message.success(result.retried ? `已重新加入 ${result.retried} 个失败任务` : '没有可重试的失败任务');
    await loadOverview(true, true);
  } catch (error) {
    message.error(errorMessage(error));
  }
}

async function reviewCompletedPackages() {
  if (!counts.value.statsReady) {
    message.warning('历史图包统计正在补齐，请稍后再筛选已完成图包');
    return;
  }
  skippingCompleted.value = true;
  try {
    const { packages: candidates } = await imageApi.completedThumbnailCandidates();
    if (!candidates.length) {
      message.info('没有关联项目全部完成且仍待生成的图包');
      return;
    }
    const preview = candidates.slice(0, 8)
      .map(item => `${item.name}（待处理 ${item.pendingCount.toLocaleString()}）`).join('、');
    const pending = candidates.reduce((total, item) => total + item.pendingCount, 0);
    dialog.warning({
      title: '停用已完成项目的图包',
      content: `本次最多处理 ${candidates.length} 个图包、${pending.toLocaleString()} 个待生成任务。关联项目均已完成；停用后缺失缩略图的图片会使用原图。请核对：${preview}${candidates.length > 8 ? '等' : ''}。正在处理的任务仍可能完成。`,
      positiveText: '确认停用',
      negativeText: '取消',
      onPositiveClick: async () => {
        try {
          const result = await imageApi.disableCompletedThumbnailPackages(candidates.map(item => item.subjectId));
          message.success(`已停用 ${result.disabled} 个图包；状态变化的图包会被自动跳过`);
          await loadOverview(true, true);
        } catch (error) {
          message.error(errorMessage(error));
        }
      }
    });
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    skippingCompleted.value = false;
  }
}

function stateLabel(item: ThumbnailPackageQueue) {
  return {
    calculating: '统计中',
    disabled: '不生成', paused: '已暂停', processing: '生成中', queued: '等待中',
    failed: '存在失败', completed: '已完成'
  }[item.state];
}

function stateType(item: ThumbnailPackageQueue) {
  return ({
    calculating: 'default',
    disabled: 'default', paused: 'warning', processing: 'info', queued: 'warning',
    failed: 'error', completed: 'success'
  } as const)[item.state];
}

function formatRate(rate: number) {
  return rate > 0 ? `${rate.toFixed(rate >= 10 ? 0 : 1)} 张/分` : '-';
}

function formatEstimate(minutes: number | null) {
  if (minutes == null) return '-';
  if (minutes < 60) return `约 ${minutes} 分钟`;
  return `约 ${(minutes / 60).toFixed(1)} 小时`;
}

onMounted(() => {
  void loadOverview();
  refreshTimer = window.setInterval(() => void loadOverview(true), 30_000);
});

onBeforeUnmount(() => {
  if (refreshTimer != null) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="admin-page thumbnail-queue-page">
    <section class="thumbnail-queue-summary">
      <div class="thumbnail-summary-card"><span>已停用图包待处理</span><strong>{{ counts.statsReady ? formatCount(counts.excludedPending) : '统计中' }}</strong></div>
      <div class="thumbnail-summary-card"><span>正在生成</span><strong>{{ counts.statsReady ? counts.processing.toLocaleString() : '统计中' }}</strong></div>
      <div class="thumbnail-summary-card"><span>已完成</span><strong>{{ counts.statsReady ? counts.ready.toLocaleString() : '统计中' }}</strong></div>
      <div class="thumbnail-summary-card is-error"><span>失败</span><strong>{{ counts.statsReady ? counts.failed.toLocaleString() : '统计中' }}</strong></div>
      <div class="thumbnail-summary-card"><span>近 5 分钟速度</span><strong>{{ formatRate(counts.ratePerMinute) }}</strong></div>
    </section>

    <n-card :bordered="false" class="thumbnail-policy-card" :theme-overrides="isDark ? darkPolicyTheme : undefined">
      <template #header>
        <span class="thumbnail-policy-title">
          全局调度与闲时策略
          <n-tooltip placement="top-start">
            <template #trigger>
              <span class="thumbnail-policy-help" tabindex="0" aria-label="查看调度策略说明">i</span>
            </template>
            <div class="thumbnail-policy-tooltip">
              <p>白天、夜间并发可设为 1–16，Worker 的并发上限也是 16；若服务器配置了更低上限，以较低值为准。时间按 {{ settings?.timeZone || 'Asia/Shanghai' }} 切换。</p>
              <p>暂停、停止生成和调整优先级只影响后续领取的任务；正在编码的图片会正常完成。优先级越大，越先处理；未手动优先处理的图包默认从最新导入的开始，重启后也按此顺序。</p>
            </div>
          </n-tooltip>
        </span>
      </template>
      <template #header-extra>
        <n-space align="center" :wrap="false" class="thumbnail-policy-header-actions">
          <n-tag v-if="settings" :type="settings.globallyPaused ? 'warning' : 'success'" size="medium">
            {{ settings.globallyPaused ? '全局已暂停' : `${settings.activeSchedule.period === 'night' ? '夜间' : '白天'}模式 · 并发 ${settings.activeSchedule.concurrency}` }}
          </n-tag>
          <n-button size="medium" :type="settings?.globallyPaused ? 'primary' : 'warning'" secondary :loading="savingSettings"
            @click="toggleGlobalPause">
            {{ settings?.globallyPaused ? '启动全部队列' : '暂停全部队列' }}
          </n-button>
        </n-space>
      </template>
      <div class="thumbnail-policy-grid">
        <n-form-item label="白天并发">
          <n-input-number v-model:value="settingsDraft.daytimeConcurrency" :min="1" :max="16" />
        </n-form-item>
        <n-form-item label="夜间并发">
          <n-input-number v-model:value="settingsDraft.nighttimeConcurrency" :min="1" :max="16" />
        </n-form-item>
        <n-form-item label="夜间开始">
          <n-select v-model:value="settingsDraft.nightStartHour" :options="hourOptions" />
        </n-form-item>
        <n-form-item label="夜间结束">
          <n-select v-model:value="settingsDraft.nightEndHour" :options="hourOptions" />
        </n-form-item>
        <n-form-item label="操作">
          <div class="thumbnail-policy-actions">
            <n-button type="primary" :loading="savingSettings" @click="saveSettings">保存策略</n-button>
            <n-button v-if="counts.statsReady && counts.failed" secondary type="error" @click="retryFailed()">重试全部失败</n-button>
          </div>
        </n-form-item>
      </div>
    </n-card>

    <div class="table-shell thumbnail-package-table">
      <div class="table-shell-header thumbnail-package-header">
        <div class="thumbnail-package-heading">
          <strong>图包生成顺序</strong>
          <n-text depth="3">共 {{ totalPackages }} 个图包 · 每 30 秒更新</n-text>
        </div>
        <div class="thumbnail-package-toolbar">
          <n-input v-model:value="searchDraft" clearable placeholder="搜索图包名称或 ID" class="thumbnail-package-search"
            @keyup.enter="applySearch" @clear="applySearch" />
          <n-button secondary @click="applySearch">搜索</n-button>
          <n-button secondary :loading="loading" @click="loadOverview()">刷新</n-button>
          <n-button secondary :loading="skippingCompleted" @click="reviewCompletedPackages">停用已完成图包</n-button>
        </div>
      </div>
      <n-spin :show="loading">
        <div class="thumbnail-table-scroll">
          <n-table v-if="packages.length" :bordered="false" :single-line="false" size="small"
            :theme-overrides="isDark ? darkTableTheme : undefined">
            <thead>
              <tr>
                <th>图包</th><th>状态</th><th>进度</th><th>速度 / 预计</th><th>优先级</th><th>生成</th><th>暂停</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in packages" :key="item.subjectId">
                <td class="thumbnail-package-name">
                  <n-tooltip placement="top-start">
                    <template #trigger>
                      <strong class="thumbnail-package-title">{{ item.name }}</strong>
                    </template>
                    {{ item.name }}
                  </n-tooltip>
                  <span>{{ item.imageCount.toLocaleString() }} 张图片</span>
                  <span>导入：{{ formatDateTime(item.importedAt) }}</span>
                </td>
                <td>
                  <n-tag :type="stateType(item)" size="small">{{ stateLabel(item) }}</n-tag>
                  <div v-if="item.skipReason"><n-text depth="3">{{ item.skipReason }}</n-text></div>
                </td>
                <td class="thumbnail-progress-cell">
                  <n-progress v-if="item.statsReady" type="line" :show-indicator="false" :height="6"
                    :percentage="item.counts.total ? Math.round(item.counts.ready / item.counts.total * 100) : 0" />
                  <span v-if="item.statsReady">完成 {{ item.counts.ready.toLocaleString() }} · {{ item.generationEnabled ? '等待' : '不再生成' }} {{ item.counts.pending.toLocaleString() }} · 失败 {{ item.counts.failed.toLocaleString() }}</span>
                  <span v-else>正在建立图包统计</span>
                </td>
                <td>
                  <div>{{ formatRate(item.ratePerMinute) }}</div>
                  <n-text depth="3">{{ formatEstimate(item.estimatedMinutes) }}</n-text>
                </td>
                <td>
                  <div class="thumbnail-priority-control">
                    <n-input-number v-model:value="priorityDraft[item.subjectId]" :min="-100000" :max="100000" size="small" />
                    <n-button size="small" secondary :disabled="packageBusy.has(item.subjectId)" @click="savePriority(item)">保存</n-button>
                  </div>
                </td>
                <td>
                  <n-switch :value="item.generationEnabled" :loading="packageBusy.has(item.subjectId)"
                    @update:value="toggleGeneration(item, $event)" />
                </td>
                <td>
                  <n-switch :value="item.paused" :disabled="!item.generationEnabled" :loading="packageBusy.has(item.subjectId)"
                    @update:value="togglePackagePause(item, $event)" />
                </td>
                <td>
                  <n-space :wrap="false">
                    <n-button size="small" type="primary" secondary :disabled="!item.generationEnabled || packageBusy.has(item.subjectId)"
                      @click="prioritize(item)">优先处理</n-button>
                    <n-button v-if="item.statsReady && item.counts.failed" size="small" type="error" secondary @click="retryFailed(item)">重试失败</n-button>
                  </n-space>
                </td>
              </tr>
            </tbody>
          </n-table>
          <div v-else class="empty">{{ loading ? '正在加载...' : '暂无图包' }}</div>
        </div>
      </n-spin>
      <div v-if="overview" class="thumbnail-queue-footer">
        <n-text depth="3">数据更新时间：{{ formatDateTime(overview.generatedAt) }}</n-text>
        <n-pagination :page="page" :page-size="pageSize" :item-count="totalPackages"
          :page-sizes="[10, 25, 50]" show-size-picker
          @update:page="changePage" @update:page-size="changePageSize" />
      </div>
    </div>
  </div>
</template>
