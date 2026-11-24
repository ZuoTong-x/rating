import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

export type TaskStackStatus = 'queued' | 'running' | 'success' | 'error';
export type TaskStackKind = 'upload' | 'export' | 'generate' | 'assign' | 'rollback' | 'default';

export type TaskStackItem = {
  id: string;
  kind: TaskStackKind;
  title: string;
  description?: string;
  stage?: string;
  status: TaskStackStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
};

type TaskStackCreatePayload = {
  kind?: TaskStackKind;
  title: string;
  description?: string;
  stage?: string;
  progress?: number;
  status?: TaskStackStatus;
};

type TaskStackPatch = Partial<Pick<TaskStackItem, 'description' | 'stage' | 'status' | 'progress' | 'error'>>;

function taskId() {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  return randomUUID || `task-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function now() {
  return new Date().toISOString();
}

function clampProgress(value: number | null | undefined) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

export const useTaskStackStore = defineStore('taskStack', () => {
  const tasks = ref<TaskStackItem[]>([]);
  const panelOpen = ref(false);

  const sortedTasks = computed(() => [...tasks.value].sort((left, right) => (
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  )));
  const activeTasks = computed(() => sortedTasks.value.filter(task => task.status === 'queued' || task.status === 'running'));
  const failedTasks = computed(() => sortedTasks.value.filter(task => task.status === 'error'));
  const currentTask = computed(() => activeTasks.value[0] || null);
  const activeCount = computed(() => activeTasks.value.length);
  const failedCount = computed(() => failedTasks.value.length);

  function addTask(payload: TaskStackCreatePayload) {
    const timestamp = now();
    const task: TaskStackItem = {
      id: taskId(),
      kind: payload.kind || 'default',
      title: payload.title,
      description: payload.description,
      stage: payload.stage || '等待开始',
      status: payload.status || 'running',
      progress: clampProgress(payload.progress ?? 0),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    tasks.value = [task, ...tasks.value];
    panelOpen.value = true;
    return task.id;
  }

  function updateTask(id: string, patch: TaskStackPatch) {
    const timestamp = now();
    tasks.value = tasks.value.map(task => {
      if (task.id !== id) return task;
      return {
        ...task,
        ...patch,
        progress: patch.progress == null ? task.progress : clampProgress(patch.progress),
        updatedAt: timestamp
      };
    });
  }

  function finishTask(id: string, _patch: Omit<TaskStackPatch, 'status' | 'error'> = {}) {
    const nextTasks = tasks.value.filter(task => task.id !== id);
    tasks.value = nextTasks;
    if (!nextTasks.length) panelOpen.value = false;
  }

  function failTask(id: string, error: unknown, patch: Omit<TaskStackPatch, 'status' | 'error'> = {}) {
    const message = error instanceof Error ? error.message : String(error || '任务失败');
    const timestamp = now();
    tasks.value = tasks.value.map(task => (
      task.id === id
        ? {
          ...task,
          ...patch,
          status: 'error',
          stage: patch.stage || '执行失败',
          error: message,
          updatedAt: timestamp
        }
        : task
    ));
  }

  function removeTask(id: string) {
    const nextTasks = tasks.value.filter(task => task.id !== id);
    tasks.value = nextTasks;
    if (!nextTasks.length) panelOpen.value = false;
  }

  function togglePanel() {
    panelOpen.value = !panelOpen.value;
  }

  return {
    tasks,
    panelOpen,
    sortedTasks,
    activeTasks,
    failedTasks,
    currentTask,
    activeCount,
    failedCount,
    addTask,
    updateTask,
    finishTask,
    failTask,
    removeTask,
    togglePanel
  };
});
