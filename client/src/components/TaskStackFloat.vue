<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { NBadge, NButton, NProgress, NTag } from 'naive-ui';
import { useTaskStackStore, type TaskStackItem, type TaskStackKind, type TaskStackStatus } from '../stores/taskStack';

const taskStack = useTaskStackStore();
const floatElement = ref<HTMLElement | null>(null);
const isDragging = ref(false);
const suppressClick = ref(false);
const positionStorageKey = 'task-stack-float-position-v2';
const positionInset = 12;

function readStoredPosition() {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(positionStorageKey) || '');
    if (
      parsed &&
      Number.isFinite(Number(parsed.left)) &&
      Number.isFinite(Number(parsed.bottom))
    ) {
      return {
        left: Math.max(positionInset, Number(parsed.left)),
        bottom: Math.max(positionInset, Number(parsed.bottom))
      };
    }
  } catch {
    // Ignore malformed or unavailable local storage.
  }
  return null;
}

const position = ref(readStoredPosition() || { left: 22, bottom: 22 });
const dragState = {
  pointerId: -1,
  startX: 0,
  startY: 0,
  startLeft: 0,
  startBottom: 0,
  width: 0,
  height: 0,
  moved: false
};

const visibleTasks = computed(() => [...taskStack.activeTasks, ...taskStack.failedTasks].slice(0, 8));
const badgeValue = computed(() => taskStack.activeCount + taskStack.failedCount || undefined);
const floatStyle = computed(() => ({
  left: `${position.value.left}px`,
  right: 'auto',
  bottom: `${position.value.bottom}px`
}));
const floatLabel = computed(() => {
  const current = taskStack.currentTask;
  if (current) return current.title;
  if (taskStack.failedTasks.length) return `失败 ${taskStack.failedTasks.length}`;
  return '任务';
});

function statusText(status: TaskStackStatus) {
  return {
    queued: '等待中',
    running: '进行中',
    success: '已完成',
    error: '失败'
  }[status];
}

function statusType(status: TaskStackStatus): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (status === 'success') return 'success';
  if (status === 'error') return 'error';
  if (status === 'queued') return 'warning';
  return 'info';
}

function kindText(kind: TaskStackKind) {
  return {
    upload: '上传',
    export: '导出',
    generate: '发起任务',
    assign: '分配',
    rollback: '回退',
    default: '任务'
  }[kind];
}

function progressStatus(task: TaskStackItem): 'success' | 'error' | 'default' {
  if (task.status === 'success') return 'success';
  if (task.status === 'error') return 'error';
  return 'default';
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function clampCurrentPosition() {
  if (!floatElement.value || typeof window === 'undefined') return;
  const rect = floatElement.value.getBoundingClientRect();
  position.value = {
    left: clamp(
      position.value.left,
      positionInset,
      window.innerWidth - rect.width - positionInset
    ),
    bottom: clamp(
      position.value.bottom,
      positionInset,
      window.innerHeight - rect.height - positionInset
    )
  };
}

function persistPosition() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(positionStorageKey, JSON.stringify(position.value));
  } catch {
    // A private browsing context may reject local storage writes.
  }
}

function beginDrag(event: PointerEvent) {
  if (event.button !== 0 || !floatElement.value || typeof window === 'undefined') return;
  const rect = floatElement.value.getBoundingClientRect();
  dragState.pointerId = event.pointerId;
  dragState.startX = event.clientX;
  dragState.startY = event.clientY;
  dragState.startLeft = rect.left;
  dragState.startBottom = window.innerHeight - rect.bottom;
  dragState.width = rect.width;
  dragState.height = rect.height;
  dragState.moved = false;
  suppressClick.value = false;
  window.addEventListener('pointermove', handleDrag);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}

function handleDrag(event: PointerEvent) {
  if (event.pointerId !== dragState.pointerId || typeof window === 'undefined') return;
  const deltaX = event.clientX - dragState.startX;
  const deltaY = event.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(deltaX, deltaY) < 4) return;

  dragState.moved = true;
  isDragging.value = true;
  event.preventDefault();
  position.value = {
    left: clamp(
      dragState.startLeft + deltaX,
      positionInset,
      window.innerWidth - dragState.width - positionInset
    ),
    bottom: clamp(
      dragState.startBottom - deltaY,
      positionInset,
      window.innerHeight - dragState.height - positionInset
    )
  };
}

function endDrag(event: PointerEvent) {
  if (event.pointerId !== dragState.pointerId) return;
  window.removeEventListener('pointermove', handleDrag);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', endDrag);
  if (dragState.moved) {
    persistPosition();
    suppressClick.value = true;
  }
  isDragging.value = false;
  dragState.pointerId = -1;
}

function handleTriggerClick() {
  if (suppressClick.value) {
    suppressClick.value = false;
    return;
  }
  taskStack.togglePanel();
}

watch(
  () => taskStack.panelOpen,
  async () => {
    await nextTick();
    clampCurrentPosition();
    persistPosition();
  }
);

onBeforeUnmount(() => {
  if (typeof window === 'undefined') return;
  window.removeEventListener('pointermove', handleDrag);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', endDrag);
});
</script>

<template>
  <div ref="floatElement" class="task-stack-float" :class="{ 'is-open': taskStack.panelOpen, 'is-dragging': isDragging }"
    :style="floatStyle">
    <transition name="task-stack-panel">
      <section v-if="taskStack.panelOpen" class="task-stack-panel" aria-label="任务栈">
        <div class="task-stack-panel-header">
          <div>
            <strong>任务栈</strong>
            <span>{{ taskStack.activeCount ? `${taskStack.activeCount} 个进行中` : '暂无进行中任务' }}</span>
          </div>
          <div class="task-stack-panel-actions">
            <n-button size="tiny" quaternary @click="taskStack.panelOpen = false">收起</n-button>
          </div>
        </div>
        <div v-if="visibleTasks.length" class="task-stack-list">
          <article v-for="task in visibleTasks" :key="task.id" class="task-stack-item" :class="`is-${task.status}`">
            <div class="task-stack-item-main">
              <div>
                <strong>{{ task.title }}</strong>
                <span>{{ task.stage || task.description || kindText(task.kind) }}</span>
              </div>
              <n-tag size="small" :type="statusType(task.status)" :bordered="false">
                {{ statusText(task.status) }}
              </n-tag>
            </div>
            <n-progress type="line" :percentage="task.progress" :status="progressStatus(task)" :show-indicator="false" />
            <div class="task-stack-item-footer">
              <span>{{ kindText(task.kind) }} / {{ formatTime(task.updatedAt) }}</span>
              <n-button v-if="task.status === 'error'" size="tiny" text
                @click="taskStack.removeTask(task.id)">
                移除
              </n-button>
            </div>
            <p v-if="task.error" class="task-stack-error">{{ task.error }}</p>
          </article>
        </div>
        <div v-else class="task-stack-empty">暂无后台任务</div>
      </section>
    </transition>

    <n-badge :value="badgeValue" :max="99" :show-zero="false">
      <n-button class="task-stack-trigger" round type="primary" secondary :aria-label="floatLabel" :title="floatLabel"
        @pointerdown.stop="beginDrag" @click.stop="handleTriggerClick">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true">
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      </n-button>
    </n-badge>
  </div>
</template>
