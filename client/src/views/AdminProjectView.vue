<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import { NButton, NProgress, useDialog, useMessage, type DataTableColumns, type UploadCustomRequestOptions } from 'naive-ui';
import { useRouter } from 'vue-router';
import { createUploadId, imageApi, type ImportJob } from '../services/images';
import { useTaskStackStore } from '../stores/taskStack';
import type { SubjectItem } from '../types/image';
import { formatDateTime } from '../utils/time';

type PackageRow = Omit<SubjectItem, 'status'> & {
  status: SubjectItem['status'] | 'uploading' | 'awaiting_json';
  uploadId?: string;
  importJobId?: string;
  importMessage?: string | null;
  uploadProgress?: number;
  uploadStage?: string | null;
};

const message = useMessage();
const dialog = useDialog();
const router = useRouter();
const taskStack = useTaskStackStore();
const loading = ref(false);
const importing = ref(false);
const packages = ref<SubjectItem[]>([]);
const uploadRows = ref<PackageRow[]>([]);

const rows = computed<PackageRow[]>(() => [
  ...uploadRows.value,
  ...packages.value,
]);

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function isAwaitingJsonError(error: unknown): error is Error & { awaitingJson: true; uploadId?: string } {
  return Boolean(error && typeof error === 'object' && (error as { awaitingJson?: boolean }).awaitingJson);
}

function packageName(filename: string) {
  return filename.replace(/\.zip$/i, '') || filename;
}

function statusLabel(row: PackageRow) {
  if (row.status === 'uploading') return row.uploadStage || '上传中';
  if (row.status === 'importing') return '正在处理图片';
  if (row.status === 'awaiting_json') return '等待补充 JSON';
  if (row.status === 'failed') return '导入失败';
  return '处理完成';
}

function addUploadRow(uploadId: string, file: File) {
  const now = new Date().toISOString();
  uploadRows.value = [{
    _id: `upload-${uploadId}`,
    name: packageName(file.name),
    originalFilename: file.name,
    importBatch: uploadId,
    imageCount: 0,
    categoryCount: 0,
    taskTemplateCount: 0,
    status: 'uploading',
    taskStatus: 'task_pending',
    createdAt: now,
    updatedAt: now,
    uploadId,
    uploadProgress: 0,
    uploadStage: null
  }, ...uploadRows.value.filter(item => item.uploadId !== uploadId)];
}

function pendingImportRow(job: ImportJob): PackageRow {
  const filename = job.originalFilename || `${job.uploadId}.zip`;
  const createdAt = new Date().toISOString();
  return {
    _id: `upload-${job.uploadId}`,
    name: packageName(filename),
    originalFilename: filename,
    importBatch: job.uploadId,
    imageCount: 0,
    categoryCount: 0,
    taskTemplateCount: 0,
    status: 'awaiting_json',
    taskStatus: 'task_pending',
    createdAt,
    updatedAt: createdAt,
    uploadId: job.uploadId,
    importJobId: job.uploadId,
    importMessage: job.message,
    uploadProgress: 100,
    uploadStage: job.stage || '等待补充 JSON'
  };
}

function updateUploadRow(uploadId: string, patch: Partial<PackageRow>) {
  uploadRows.value = uploadRows.value.map(row => (
    row.uploadId === uploadId ? { ...row, ...patch } : row
  ));
}

function removeUploadRow(uploadId: string) {
  uploadRows.value = uploadRows.value.filter(row => row.uploadId !== uploadId);
}

function upsertPackage(item: SubjectItem) {
  packages.value = [item, ...packages.value.filter(row => row._id !== item._id)];
}

async function loadPackages() {
  loading.value = true;
  try {
    const [subjectItems, pendingJobs] = await Promise.all([
      imageApi.subjects(),
      imageApi.pendingImportJobs()
    ]);
    packages.value = subjectItems;
    const activeRows = uploadRows.value.filter(row => row.status === 'uploading' || row.status === 'importing');
    uploadRows.value = [
      ...activeRows,
      ...pendingJobs.map(pendingImportRow)
    ];
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function importZip({ file, onFinish, onError }: UploadCustomRequestOptions) {
  if (!(file.file instanceof File)) {
    message.error('无法读取上传文件');
    onError();
    return;
  }

  const uploadId = createUploadId();
  const taskId = taskStack.addTask({
    kind: 'upload',
    title: `上传图包：${file.file.name}`,
    stage: '正在上传 ZIP',
    progress: 0
  });
  addUploadRow(uploadId, file.file);
  importing.value = true;
  try {
    const result = await imageApi.importZip(file.file, {
      uploadId,
      onProgress: progress => {
        updateUploadRow(uploadId, { uploadProgress: progress, uploadStage: null });
        taskStack.updateTask(taskId, { progress, stage: '正在上传 ZIP' });
      },
      onProcessing: job => {
        updateUploadRow(uploadId, {
          uploadProgress: job.progress,
          uploadStage: job.stage
        });
        taskStack.updateTask(taskId, { progress: job.progress, stage: job.stage || '正在处理图片' });
      }
    });
    removeUploadRow(uploadId);
    upsertPackage(result.subject);
    taskStack.finishTask(taskId, {
      stage: '图包导入完成',
      description: `${result.subject.name} / ${result.imported} 张图片`
    });
    message.success(`图包“${result.subject.name}”已导入 ${result.imported} 张图片`);
    onFinish();
  } catch (error) {
    if (isAwaitingJsonError(error)) {
      const importJobId = error.uploadId || uploadId;
      updateUploadRow(uploadId, {
        status: 'awaiting_json',
        importJobId,
        importMessage: error.message,
        uploadProgress: 100,
        uploadStage: '等待补充 JSON'
      });
      taskStack.updateTask(taskId, {
        progress: 100,
        stage: '等待补充 JSON',
        description: '请上传只包含 manifest.json 或 tasks.json 的修正 ZIP'
      });
      message.warning(`图包“${file.file.name}”的 JSON 校验失败，请补充修正后的 JSON`);
      onFinish();
      return;
    }
    removeUploadRow(uploadId);
    taskStack.failTask(taskId, error);
    message.error(`图包“${file.file.name}”导入失败：${errorMessage(error)}`);
    onError();
  } finally {
    importing.value = false;
  }
}

function chooseSupplementJson(row: PackageRow) {
  if (!row.importJobId || row.status !== 'awaiting_json') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,application/zip';
  input.onchange = () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void supplementJson(row, file);
  };
  input.click();
}

async function supplementJson(row: PackageRow, file: File) {
  if (!row.importJobId || !row.uploadId) return;
  const rowUploadId = row.uploadId;
  const taskId = taskStack.addTask({
    kind: 'upload',
    title: `补充 JSON：${row.name}`,
    stage: '正在提交补充 JSON',
    progress: 0
  });
  importing.value = true;
  updateUploadRow(rowUploadId, {
    status: 'importing',
    importMessage: null,
    uploadProgress: 0,
    uploadStage: '正在使用补充 JSON 重新处理'
  });
  try {
    const result = await imageApi.supplementImportJson(row.importJobId, file, {
      onProcessing: job => {
        updateUploadRow(rowUploadId, {
          status: job.status === 'awaiting_json' ? 'awaiting_json' : 'importing',
          uploadProgress: job.progress,
          uploadStage: job.stage,
          importMessage: job.message
        });
        taskStack.updateTask(taskId, {
          progress: job.progress,
          stage: job.stage || '正在处理图片'
        });
      }
    });
    removeUploadRow(rowUploadId);
    upsertPackage(result.subject);
    taskStack.finishTask(taskId, { stage: '图包导入完成' });
    message.success(`图包“${result.subject.name}”已使用补充 JSON 完成导入`);
  } catch (error) {
    if (isAwaitingJsonError(error)) {
      updateUploadRow(rowUploadId, {
        status: 'awaiting_json',
        uploadProgress: 100,
        uploadStage: '等待补充 JSON',
        importMessage: error.message
      });
    }
    taskStack.failTask(taskId, error);
    message.error(`补充 JSON 处理失败：${errorMessage(error)}`);
  } finally {
    importing.value = false;
  }
}

function deletePackage(row: PackageRow) {
  if (row.status !== 'imported') return;
  dialog.warning({
    title: '删除图包',
    content: `确认删除图包“${row.name}”？已关联项目的图包不能删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await imageApi.deleteSubject(row._id);
        packages.value = packages.value.filter(item => item._id !== row._id);
        message.success(`已删除图包“${row.name}”`);
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      }
    }
  });
}

function renderStatus(row: PackageRow) {
  if (row.status === 'uploading' || row.status === 'importing') {
    const percentage = Math.max(0, Math.min(100, row.uploadProgress ?? 0));
    return h('div', { class: 'subject-status-cell' }, [
      h(NProgress, { percentage, showIndicator: false }),
      h('div', { class: 'subject-status-text' }, `${statusLabel(row)} ${Math.round(percentage)}%`)
    ]);
  }
  return h('span', {
    class: row.status === 'imported' ? 'subject-status-done' : 'subject-status-muted',
    title: row.importMessage || undefined
  }, statusLabel(row));
}

const columns: DataTableColumns<PackageRow> = [
  { title: '图包名称', key: 'name', minWidth: 180 },
  { title: '图片数', key: 'imageCount', width: 88 },
  { title: '目录数', key: 'categoryCount', width: 88 },
  { title: '状态', key: 'status', width: 180, render: renderStatus },
  { title: '导入时间', key: 'createdAt', width: 180, render: row => formatDateTime(row.createdAt) },
  {
    title: '功能',
    key: 'actions',
    width: 260,
    fixed: 'right',
    render: row => h('div', { class: 'table-actions' }, [
      h(NButton, {
        size: 'small',
        secondary: true,
        disabled: row.status !== 'imported',
        onClick: () => void router.push(`/admin/packages/${encodeURIComponent(row._id)}`)
      }, { default: () => '查看图片' }),
      row.status === 'awaiting_json'
        ? h(NButton, {
          size: 'small',
          type: 'warning',
          secondary: true,
          disabled: importing.value,
          onClick: () => chooseSupplementJson(row)
        }, { default: () => '补充 JSON' })
        : null,
      h(NButton, {
        size: 'small',
        tertiary: true,
        type: 'error',
        disabled: row.status !== 'imported',
        onClick: () => deletePackage(row)
      }, { default: () => '删除' })
    ])
  }
];

onMounted(() => void loadPackages());
</script>

<template>
  <div class="admin-page">
    <div class="table-shell">
      <div class="table-shell-header">
        <div class="table-shell-header-flex">
          <strong>图包列表</strong>
          <n-text depth="3">共 {{ rows.length }} 个图包</n-text>
        </div>
        <n-upload class="table-shell-header-upload" accept=".zip,application/zip" :show-file-list="false"
          :disabled="importing" :custom-request="importZip">
          <n-button type="primary" :loading="importing">上传图包</n-button>
        </n-upload>
      </div>
      <n-data-table v-if="rows.length" :columns="columns" :data="rows" :loading="loading" :bordered="false" :scroll-x="880" />
      <div v-else class="empty">{{ loading ? '正在加载图包...' : '暂无图包，请上传 ZIP 文件' }}</div>
    </div>
  </div>
</template>
