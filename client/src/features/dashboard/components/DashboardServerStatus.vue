<script setup lang="ts">
import { NText, NSpace, NTag, NButton, NProgress, useMessage } from 'naive-ui';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { adminDashboardApi } from '../../../services/admin-dashboard';
import type { AdminSystemStatus } from '../../../types/image';

type TagType = 'default' | 'success' | 'warning' | 'error' | 'info';

const message = useMessage();
const systemStatus = ref<AdminSystemStatus | null>(null);
const systemStatusStale = ref(false);
let systemStatusTimer: number | null = null;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null || !Number.isFinite(bytes)) return '不可用';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatUptime(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '不可用';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function loadLevel(percent: number | null | undefined): TagType {
  if (percent == null) return 'default';
  if (percent >= 90) return 'error';
  if (percent >= 75) return 'warning';
  return 'success';
}

function percentText(percent: number | null | undefined) {
  return percent == null ? '采集中' : `${percent.toFixed(1)}%`;
}

function formatMilliseconds(milliseconds: number | null | undefined) {
  if (milliseconds == null || !Number.isFinite(milliseconds)) return '不可用';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

const congestionView = computed(() => {
  const percent = systemStatus.value?.congestion.percent ?? 0;
  const views = {
    relaxed: { label: '空闲', emoji: '🙂' },
    moderate: { label: '适中', emoji: '😅' },
    busy: { label: '拥挤', emoji: '🥵' },
    critical: { label: '严重拥挤', emoji: '🚨' },
    unknown: { label: '采集中', emoji: '⏳' }
  } as const;
  const level = systemStatus.value?.congestion.level || 'unknown';
  return {
    percent,
    markerPosition: Math.max(2, Math.min(98, percent)),
    ...views[level]
  };
});

async function loadSystemStatus(silent = false) {
  try {
    systemStatus.value = await adminDashboardApi.adminSystemStatus();
    systemStatusStale.value = false;
  } catch (error) {
    systemStatusStale.value = true;
    if (!silent) message.error(errorMessage(error));
  }
}

onMounted(() => {
  void loadSystemStatus();
  systemStatusTimer = window.setInterval(() => void loadSystemStatus(true), 5_000);
});
onBeforeUnmount(() => {
  if (systemStatusTimer != null) window.clearInterval(systemStatusTimer);
});
</script>

<template>
    <section class="table-shell dashboard-server-status" aria-label="服务器状态">
      <div class="table-shell-header dashboard-card-header">
        <div class="table-shell-header-flex">
          <strong>服务器状态</strong>
          <n-text depth="3">
            {{ systemStatus ? `${systemStatus.hostname} · 每 5 秒刷新` : '正在读取服务器状态' }}
          </n-text>
        </div>
        <n-space>
          <n-tag v-if="systemStatusStale" type="warning" size="small">数据暂时中断</n-tag>
          <n-tag v-else-if="systemStatus" :type="systemStatus.status === 'healthy' ? 'success' : 'warning'" size="small">
            {{ systemStatus.status === 'healthy' ? '运行正常' : '部分异常' }}
          </n-tag>
          <n-button size="small" secondary @click="loadSystemStatus()">刷新</n-button>
        </n-space>
      </div>
      <div v-if="systemStatus" class="dashboard-server-grid">
        <article class="dashboard-server-metric">
          <div><span>系统 CPU</span><n-tag size="tiny" :type="loadLevel(systemStatus.cpu.systemUsagePercent)">{{ percentText(systemStatus.cpu.systemUsagePercent) }}</n-tag></div>
          <n-progress type="line" :show-indicator="false" :height="7" :percentage="systemStatus.cpu.systemUsagePercent || 0"
            :status="(systemStatus.cpu.systemUsagePercent || 0) >= 90 ? 'error' : 'default'" />
          <small>负载 {{ systemStatus.cpu.loadAverage1m }} / {{ systemStatus.cpu.loadAverage5m }} / {{ systemStatus.cpu.loadAverage15m }}，可用 {{ systemStatus.cpu.effectiveCount }} 核</small>
        </article>
        <article class="dashboard-server-metric">
          <div><span>内存</span><n-tag size="tiny" :type="loadLevel(systemStatus.memory.usagePercent)">{{ percentText(systemStatus.memory.usagePercent) }}</n-tag></div>
          <n-progress type="line" :show-indicator="false" :height="7" :percentage="systemStatus.memory.usagePercent || 0"
            :status="(systemStatus.memory.usagePercent || 0) >= 90 ? 'error' : 'default'" />
          <small>已用 {{ formatBytes(systemStatus.memory.usedBytes) }} / {{ formatBytes(systemStatus.memory.totalBytes) }}</small>
        </article>
        <article class="dashboard-server-metric">
          <div><span>图片磁盘</span><n-tag size="tiny" :type="loadLevel(systemStatus.disk.usagePercent)">{{ percentText(systemStatus.disk.usagePercent) }}</n-tag></div>
          <n-progress type="line" :show-indicator="false" :height="7" :percentage="systemStatus.disk.usagePercent || 0"
            :status="(systemStatus.disk.usagePercent || 0) >= 90 ? 'error' : 'default'" />
          <small v-if="systemStatus.disk.availableBytes != null">剩余 {{ formatBytes(systemStatus.disk.availableBytes) }} / {{ formatBytes(systemStatus.disk.totalBytes) }}</small>
          <small v-else>{{ systemStatus.disk.error || '磁盘数据不可用' }}</small>
        </article>
        <article class="dashboard-server-metric is-compact">
          <span>API 进程</span>
          <strong>{{ percentText(systemStatus.cpu.processUsagePercent) }}</strong>
          <small>RSS {{ formatBytes(systemStatus.process.rssBytes) }} · PID {{ systemStatus.process.pid }}</small>
        </article>
        <article class="dashboard-server-metric is-compact">
          <span>数据库</span>
          <strong :class="{ 'is-error': systemStatus.database.status !== 'healthy' }">
            {{ systemStatus.database.latencyMs == null ? '连接异常' : `${systemStatus.database.latencyMs} ms` }}
          </strong>
          <small>{{ systemStatus.database.status === 'healthy' ? '连接正常' : systemStatus.database.error }}</small>
        </article>
        <article class="dashboard-server-metric is-compact">
          <span>服务器运行时间</span>
          <strong>{{ formatUptime(systemStatus.systemUptimeSeconds) }}</strong>
          <small>API 已运行 {{ formatUptime(systemStatus.process.uptimeSeconds) }}</small>
        </article>
      </div>
      <div v-else class="async-state-placeholder dashboard-server-loading">
        <span class="async-state-placeholder-spinner" />
        <strong>正在读取服务器负载</strong>
      </div>
      <div v-if="systemStatus" class="dashboard-congestion">
        <div class="dashboard-congestion-heading">
          <div>
            <strong>当前服务器拥挤程度</strong>
            <n-text depth="3">
              综合 CPU、系统负载、内存与数据库延迟 · 近 {{ systemStatus.activity.windowSeconds }} 秒 API 活动
            </n-text>
          </div>
          <strong>{{ congestionView.label }} · {{ percentText(systemStatus.congestion.percent) }}</strong>
        </div>
        <div class="dashboard-congestion-track" :class="`is-${systemStatus.congestion.level}`">
          <div class="dashboard-congestion-fill" :style="{ width: `${congestionView.percent}%` }" />
          <span class="dashboard-congestion-emoji" :style="{ left: `${congestionView.markerPosition}%` }" aria-hidden="true">
            {{ congestionView.emoji }}
          </span>
        </div>
        <div class="dashboard-activity-grid">
          <div class="dashboard-activity-group">
            <span>正在运行</span>
            <div v-if="systemStatus.activity.backgroundTasks.length || systemStatus.activity.activeRequests.length"
              class="dashboard-activity-list">
              <n-tag v-for="task in systemStatus.activity.backgroundTasks" :key="`${task.type}-${task.detail}`"
                size="small" :bordered="false" type="info">
                {{ task.label }} · {{ task.detail }} · {{ Math.round(task.progress) }}%
              </n-tag>
              <n-tag v-for="request in systemStatus.activity.activeRequests"
                :key="`${request.method}-${request.path}-${request.durationMs}`" size="small" :bordered="false"
                type="warning">
                {{ request.method }} {{ request.path }} · {{ formatMilliseconds(request.durationMs) }}
              </n-tag>
            </div>
            <n-text v-else depth="3">当前没有长时间运行的 API 或后台任务</n-text>
          </div>
          <div class="dashboard-activity-group">
            <span>API 热点（按近一分钟总耗时）</span>
            <div v-if="systemStatus.activity.hotApis.length" class="dashboard-activity-list">
              <n-tag v-for="api in systemStatus.activity.hotApis.slice(0, 3)" :key="`${api.method}-${api.path}`"
                size="small" :bordered="false">
                {{ api.method }} {{ api.path }} · {{ api.requestCount }} 次 / {{ formatMilliseconds(api.totalDurationMs) }}
              </n-tag>
            </div>
            <n-text v-else depth="3">近一分钟暂无 API 请求样本</n-text>
          </div>
        </div>
      </div>
    </section>
</template>
