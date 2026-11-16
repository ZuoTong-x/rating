<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useDialog, useMessage } from 'naive-ui';
import { imageApi } from '../services/images';
import type { ThumbnailPackageQueue, ThumbnailQueueOverview } from '../types/image';
import { formatDateTime } from '../utils/time';

const message = useMessage();
const dialog = useDialog();
const loading = ref(false);
const savingSettings = ref(false);
const overview = ref<ThumbnailQueueOverview | null>(null);
const packageBusy = ref(new Set<string>());
const priorityDraft = reactive<Record<string, number>>({});
const settingsDraft = reactive({
  daytimeConcurrency: 2,
  nighttimeConcurrency: 6,
  nightStartHour: 22,
  nightEndHour: 8,
  timeZone: 'Asia/Shanghai'
});
let refreshTimer: number | null = null;

const hourOptions = Array.from({ length: 24 }, (_, hour) => ({
  label: `${String(hour).padStart(2, '0')}:00`,
  value: hour
}));

const counts = computed(() => overview.value?.counts ?? {
  pending: 0, eligiblePending: 0, excludedPending: 0, processing: 0, ready: 0, failed: 0, total: 0,
  oldestPendingAt: null, completedLastFiveMinutes: 0, ratePerMinute: 0
});
const settings = computed(() => overview.value?.settings ?? null);
const packages = computed(() => overview.value?.packages ?? []);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function syncDraft(data: ThumbnailQueueOverview, syncSettings: boolean) {
  if (syncSettings) {
    settingsDraft.daytimeConcurrency = data.settings.daytimeConcurrency;
    settingsDraft.nighttimeConcurrency = data.settings.nighttimeConcurrency;
    settingsDraft.nightStartHour = data.settings.nightStartHour;
    settingsDraft.nightEndHour = data.settings.nightEndHour;
    settingsDraft.timeZone = data.settings.timeZone;
  }
  data.packages.forEach(item => {
    if (packageBusy.value.has(item.subjectId)) return;
    priorityDraft[item.subjectId] = item.priority;
  });
}

async function loadOverview(silent = false) {
  if (!silent) loading.value = true;
  try {
    const data = await imageApi.thumbnailQueueOverview();
    overview.value = data;
    syncDraft(data, !silent);
  } catch (error) {
    if (!silent) message.error(errorMessage(error));
  } finally {
    if (!silent) loading.value = false;
  }
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
    await loadOverview(true);
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
    await loadOverview(true);
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
    await loadOverview(true);
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
  const highest = packages.value.reduce((maximum, current) => Math.max(maximum, current.priority), 0);
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
    await loadOverview(true);
  } catch (error) {
    message.error(errorMessage(error));
  }
}

function stateLabel(item: ThumbnailPackageQueue) {
  return {
    disabled: '不生成', paused: '已暂停', processing: '生成中', queued: '等待中',
    failed: '存在失败', completed: '已完成'
  }[item.state];
}

function stateType(item: ThumbnailPackageQueue) {
  return ({
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
  refreshTimer = window.setInterval(() => void loadOverview(true), 10_000);
});

onBeforeUnmount(() => {
  if (refreshTimer != null) window.clearInterval(refreshTimer);
});
</script>

<template>
  <div class="admin-page thumbnail-queue-page">
    <n-alert type="info" :bordered="false">
      暂停、停止生成和调整优先级只影响后续领取的任务；正在编码的图片会正常完成。优先级数值越大，越先处理。
    </n-alert>

    <section class="thumbnail-queue-summary">
      <div class="thumbnail-summary-card"><span>等待生成</span><strong>{{ counts.eligiblePending.toLocaleString() }}</strong></div>
      <div class="thumbnail-summary-card"><span>已停用图包待处理</span><strong>{{ counts.excludedPending.toLocaleString() }}</strong></div>
      <div class="thumbnail-summary-card"><span>正在生成</span><strong>{{ counts.processing.toLocaleString() }}</strong></div>
      <div class="thumbnail-summary-card"><span>已完成</span><strong>{{ counts.ready.toLocaleString() }}</strong></div>
      <div class="thumbnail-summary-card is-error"><span>失败</span><strong>{{ counts.failed.toLocaleString() }}</strong></div>
      <div class="thumbnail-summary-card"><span>近 5 分钟速度</span><strong>{{ formatRate(counts.ratePerMinute) }}</strong></div>
    </section>

    <n-card title="全局调度与闲时策略" :bordered="false" class="thumbnail-policy-card">
      <template #header-extra>
        <n-space>
          <n-tag v-if="settings" :type="settings.globallyPaused ? 'warning' : 'success'" size="small">
            {{ settings.globallyPaused ? '全局已暂停' : `${settings.activeSchedule.period === 'night' ? '夜间' : '白天'}模式 · 并发 ${settings.activeSchedule.concurrency}` }}
          </n-tag>
          <n-button :type="settings?.globallyPaused ? 'primary' : 'warning'" secondary :loading="savingSettings"
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
        <n-form-item label="时区">
          <n-input v-model:value="settingsDraft.timeZone" placeholder="Asia/Shanghai" />
        </n-form-item>
        <div class="thumbnail-policy-actions">
          <n-button type="primary" :loading="savingSettings" @click="saveSettings">保存策略</n-button>
          <n-button v-if="counts.failed" secondary type="error" @click="retryFailed()">重试全部失败</n-button>
        </div>
      </div>
    </n-card>

    <div class="table-shell thumbnail-package-table">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>图包生成顺序</strong>
          <n-text depth="3">共 {{ packages.length }} 个图包，每 10 秒自动刷新</n-text>
        </div>
        <n-button secondary :loading="loading" @click="loadOverview()">刷新</n-button>
      </div>
      <n-spin :show="loading">
        <div class="thumbnail-table-scroll">
          <n-table v-if="packages.length" :bordered="false" :single-line="false" size="small">
            <thead>
              <tr>
                <th>图包</th><th>状态</th><th>进度</th><th>速度 / 预计</th><th>优先级</th><th>生成</th><th>暂停</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in packages" :key="item.subjectId">
                <td class="thumbnail-package-name">
                  <strong>{{ item.name }}</strong>
                  <span>{{ item.imageCount.toLocaleString() }} 张图片</span>
                </td>
                <td><n-tag :type="stateType(item)" size="small">{{ stateLabel(item) }}</n-tag></td>
                <td class="thumbnail-progress-cell">
                  <n-progress type="line" :show-indicator="false" :height="6"
                    :percentage="item.counts.total ? Math.round(item.counts.ready / item.counts.total * 100) : 0" />
                  <span>完成 {{ item.counts.ready.toLocaleString() }} · {{ item.generationEnabled ? '等待' : '不再生成' }} {{ item.counts.pending.toLocaleString() }} · 失败 {{ item.counts.failed.toLocaleString() }}</span>
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
                    <n-button v-if="item.counts.failed" size="small" type="error" secondary @click="retryFailed(item)">重试失败</n-button>
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
      </div>
    </div>
  </div>
</template>
