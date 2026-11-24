<script setup lang="ts">
import { NH2, NText, NSelect, NDataTable, NPagination, NModal, NForm, NFormItem, NInput, NUpload, NImageGroup } from 'naive-ui';
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { NButton, NImage, NTag, useMessage, type DataTableColumns, type UploadFileInfo } from 'naive-ui';
import { currentUser } from '../composables/auth';
import { imageApi } from '../services/images';
import { isQueryUnavailable } from '../services/http';
import AsyncStatePlaceholder from '../components/AsyncStatePlaceholder.vue';
import type { FeedbackItem, FeedbackStatus, FeedbackType } from '../types/image';
import { formatDateTime } from '../utils/time';

const message = useMessage();
const loading = ref(false);
const feedbackListState = ref<'loading' | 'ready' | 'stale' | 'unavailable'>('loading');
const submitting = ref(false);
const feedbacks = ref<FeedbackItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const status = ref<FeedbackStatus | null>(null);
const formVisible = ref(false);
const detailVisible = ref(false);
const activeFeedback = ref<FeedbackItem | null>(null);
const replying = ref(false);
const changingStatus = ref(false);
const replyText = ref('');
const canReply = computed(() => Boolean(activeFeedback.value && activeFeedback.value.status !== 'resolved'));
const fileList = ref<UploadFileInfo[]>([]);
const form = reactive({
  title: '',
  type: 'platform_bug' as FeedbackType,
  description: ''
});

const statusOptions = [
  { label: '未处理', value: 'pending' },
  { label: '处理中', value: 'processing' },
  { label: '已处理', value: 'resolved' }
];
const typeOptions = [
  { label: '平台 Bug', value: 'platform_bug' },
  { label: '打分规则', value: 'scoring_rule' },
  { label: '其他', value: 'other' }
];
const formFiles = computed(() => fileList.value
  .map(file => file.file)
  .filter((file): file is File => file instanceof File));

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function statusLabel(value: FeedbackStatus) {
  return { pending: '未处理', processing: '处理中', resolved: '已处理' }[value];
}

function statusType(value: FeedbackStatus) {
  return value === 'resolved' ? 'success' : value === 'processing' ? 'warning' : 'default';
}

function typeLabel(value: FeedbackType) {
  return { platform_bug: '平台 Bug', scoring_rule: '打分规则', other: '其他' }[value];
}

function formatDate(value: string | null) {
  return formatDateTime(value);
}

function canManageFeedback(feedback: FeedbackItem | null) {
  return Boolean(feedback && feedback.submitter === currentUser.value?.username);
}

function canResolveFeedback(feedback: FeedbackItem) {
  return canManageFeedback(feedback) && feedback.status !== 'resolved' && feedback.messages.length > 0;
}

function canReopenFeedback(feedback: FeedbackItem) {
  return canManageFeedback(feedback) && feedback.status === 'resolved';
}

function paginationPrefix({ itemCount }: { itemCount?: number }) {
  return `共 ${itemCount ?? total.value} 条反馈`;
}

async function loadFeedbacks(nextPage = page.value, nextPageSize = pageSize.value) {
  loading.value = true;
  feedbackListState.value = feedbacks.value.length ? 'stale' : 'loading';
  try {
    const result = await imageApi.feedbacks({ page: nextPage, pageSize: nextPageSize, status: status.value });
    feedbacks.value = result.items;
    total.value = result.total;
    page.value = result.page;
    pageSize.value = result.pageSize;
    feedbackListState.value = 'ready';
  } catch (error) {
    if (isQueryUnavailable(error)) feedbackListState.value = feedbacks.value.length ? 'stale' : 'unavailable';
    else {
      feedbackListState.value = feedbacks.value.length ? 'stale' : 'ready';
      message.error(errorMessage(error));
    }
  } finally {
    loading.value = false;
  }
}

function openForm() {
  form.title = '';
  form.type = 'platform_bug';
  form.description = '';
  fileList.value = [];
  formVisible.value = true;
}

function openDetail(feedback: FeedbackItem) {
  activeFeedback.value = feedback;
  replyText.value = '';
  detailVisible.value = true;
}

async function replyFeedback() {
  if (!activeFeedback.value || !replyText.value.trim()) {
    message.warning('请填写回复内容');
    return;
  }
  replying.value = true;
  try {
    const result = await imageApi.replyFeedbackMessage(activeFeedback.value.id, replyText.value.trim());
    activeFeedback.value = result.feedback;
    replyText.value = '';
    await loadFeedbacks(page.value, pageSize.value);
    message.success('回复已发送');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    replying.value = false;
  }
}

async function changeFeedbackStatus(feedback: FeedbackItem, nextStatus: FeedbackStatus) {
  if (!canManageFeedback(feedback)) return;
  changingStatus.value = true;
  try {
    const result = await imageApi.setFeedbackStatus(feedback.id, nextStatus);
    if (activeFeedback.value?.id === feedback.id) activeFeedback.value = result.feedback;
    await loadFeedbacks(page.value, pageSize.value);
    message.success(nextStatus === 'resolved' ? '反馈已标记为已解决' : '反馈已重新打开');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    changingStatus.value = false;
  }
}

async function submitFeedback() {
  if (!form.title.trim() || !form.description.trim()) {
    message.warning('请填写问题标题和问题描述');
    return;
  }
  submitting.value = true;
  try {
    await imageApi.submitFeedback({ ...form, images: formFiles.value });
    message.success('反馈已提交');
    formVisible.value = false;
    await loadFeedbacks(1, pageSize.value);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    submitting.value = false;
  }
}

const columns: DataTableColumns<FeedbackItem> = [
  { title: '问题标题', key: 'title', minWidth: 200, ellipsis: { tooltip: true } },
  { title: '问题类型', key: 'type', width: 120, render: row => typeLabel(row.type) },
  { title: '提交人', key: 'submitter', width: 120 },
  {
    title: '状态', key: 'status', width: 70,
    render: row => h(NTag, { size: 'small', type: statusType(row.status) }, { default: () => statusLabel(row.status) })
  },
  { title: '提交时间', key: 'submittedAt', width: 180, render: row => formatDate(row.submittedAt) },
  {
    title: '答复', key: 'reply', minWidth: 220,
    render: row => row.reply || '等待管理员处理'
  },
  {
    title: '附件', key: 'images', width: 90,
    render: row => row.images.length
      ? h(NImage, { width: 38, height: 38, src: row.images[0].url, objectFit: 'cover', previewSrcList: row.images.map(image => image.url) })
      : '-'
  },
  {
    title: '操作', key: 'actions', width: 100, fixed: 'right',
    render: row => h('div', { class: 'feedback-action-buttons' }, [
      h(NButton, { size: 'small', secondary: true, onClick: () => openDetail(row) }, { default: () => '回复' }),

    ])
  },
  {
    title: '状态转换', key: 'statusActions', width: 100, fixed: 'right',
    render: row => h('div', { class: 'feedback-action-buttons' }, [

      row.status === 'resolved'
        ? h(NButton, { size: 'small', type: 'warning', secondary: true, loading: changingStatus.value, disabled: !canReopenFeedback(row), onClick: () => void changeFeedbackStatus(row, 'processing') }, { default: () => '继续处理' })
        : h(NButton, { size: 'small', type: 'success', loading: changingStatus.value, disabled: !canResolveFeedback(row), onClick: () => void changeFeedbackStatus(row, 'resolved') }, { default: () => '处理完成' })
    ])
  }
];

onMounted(() => void loadFeedbacks());
onBeforeUnmount(() => {
  fileList.value.forEach(file => {
    if (file.url?.startsWith('blob:')) URL.revokeObjectURL(file.url);
  });
});
</script>

<template>
  <div class="feedback-page">
    <div class="feedback-page-header">
      <div>
        <n-h2 class="page-title">问题列表</n-h2>
        <n-text depth="3">提交平台问题或评分规则反馈，并跟进处理进度</n-text>
      </div>
      <n-button type="primary" @click="openForm">提交反馈</n-button>
    </div>

    <div class="table-shell feedback-table-shell">
      <div class="feedback-filter-bar">
        <n-select v-model:value="status" clearable :options="statusOptions" placeholder="筛选处理状态"
          @update:value="() => void loadFeedbacks(1, pageSize)" />

      </div>
      <div class="feedback-table-body">
        <AsyncStatePlaceholder v-if="feedbackListState === 'unavailable'" state="unavailable" title="反馈列表暂时不可用"
          description="暂时无法加载反馈记录，稍后重试即可。" :retrying="loading" @retry="() => void loadFeedbacks()" />
        <template v-else-if="feedbacks.length">
          <AsyncStatePlaceholder v-if="feedbackListState === 'stale'" state="stale" title="反馈列表正在刷新"
            description="先显示上次结果，刷新完成后会自动更新。" :retrying="loading" @retry="() => void loadFeedbacks()" />
          <n-data-table :columns="columns" :data="feedbacks" :loading="loading" :bordered="false" remote :scroll-x="1120" />
        </template>
        <AsyncStatePlaceholder v-else-if="feedbackListState === 'loading'" state="loading" title="正在加载反馈"
          description="正在准备反馈记录。" />
        <div v-else class="empty">暂无问题反馈</div>
      </div>
      <div class="feedback-table-footer">
        <n-pagination v-if="total" :page="page" :page-size="pageSize" :item-count="total" show-size-picker
          :page-sizes="[10, 20, 50]" :prefix="paginationPrefix"
          @update:page="(next: number) => void loadFeedbacks(next, pageSize)"
          @update:page-size="(next: number) => void loadFeedbacks(1, next)" />
      </div>
    </div>
  </div>

  <n-modal v-model:show="formVisible" preset="card" class="feedback-form-modal" title="提交反馈" :bordered="false">
    <n-form label-placement="top">
      <n-form-item label="问题标题" required>
        <n-input v-model:value="form.title" maxlength="200" show-count placeholder="请简要描述问题" />
      </n-form-item>
      <n-form-item label="问题类型" required>
        <n-select v-model:value="form.type" :options="typeOptions" />
      </n-form-item>
      <n-form-item label="问题描述" required>
        <n-input v-model:value="form.description" type="textarea" :autosize="{ minRows: 5, maxRows: 10 }" maxlength="5000"
          show-count placeholder="请提供复现步骤、涉及任务或规则说明" />
      </n-form-item>
      <n-form-item label="问题图片">
        <n-upload v-model:file-list="fileList" multiple :max="5" :default-upload="false"
          accept="image/jpeg,image/png,image/webp" list-type="image-card" />
      </n-form-item>
    </n-form>
    <template #footer>
      <div class="feedback-modal-actions">
        <n-button @click="formVisible = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="submitFeedback">提交反馈</n-button>
      </div>
    </template>
  </n-modal>

  <n-modal v-model:show="detailVisible" preset="card" class="feedback-reply-modal" title="反馈详情" content-scrollable
    :bordered="false">
    <template v-if="activeFeedback">
      <div class="feedback-dialog-body">
        <div class="feedback-dialog-context">
          <div class="feedback-detail-summary">
            <div><span>问题类型</span><strong>{{ typeLabel(activeFeedback.type) }}</strong></div>
            <div><span>处理状态</span><strong>{{ statusLabel(activeFeedback.status) }}</strong></div>
            <div><span>提交时间</span><strong>{{ formatDate(activeFeedback.submittedAt) }}</strong></div>
          </div>
          <section class="feedback-detail-section">
            <strong>{{ activeFeedback.title }}</strong>
            <p>{{ activeFeedback.description }}</p>
            <n-image-group v-if="activeFeedback.images.length">
              <div class="feedback-detail-images">
                <n-image v-for="image in activeFeedback.images" :key="image.path" width="104" height="78" :src="image.url"
                  object-fit="cover" />
              </div>
            </n-image-group>
          </section>
        </div>
        <section class="feedback-detail-section feedback-reply-section">
          <div class="feedback-thread-header">
            <strong>回复记录</strong>
            <n-tag size="small" :type="statusType(activeFeedback.status)">{{ statusLabel(activeFeedback.status) }}
            </n-tag>
          </div>
          <div v-if="activeFeedback.messages.length" class="feedback-thread">
            <div v-for="item in activeFeedback.messages" :key="item.id" class="feedback-thread-message"
              :class="{ 'is-admin': item.authorRole === 'admin' }">
              <div class="feedback-thread-meta">
                <strong>{{ item.author }}</strong>
                <span>{{ item.authorRole === 'admin' ? '管理员' : '打分人' }} · {{ formatDate(item.createdAt) }}</span>
              </div>
              <p>{{ item.content }}</p>
            </div>
          </div>
          <n-text v-else depth="3">暂时没有回复</n-text>
        </section>
        <n-form v-if="canReply" label-placement="top">
          <n-form-item label="继续回复">
            <n-input v-model:value="replyText" type="textarea" :autosize="{ minRows: 3, maxRows: 7 }" maxlength="5000"
              show-count placeholder="补充问题进展或回复管理员" />
          </n-form-item>
        </n-form>
      </div>
    </template>
    <template #footer>
      <div class="feedback-modal-actions">
        <n-button v-if="canReply" type="primary" :loading="replying" :disabled="!replyText.trim()"
          @click="replyFeedback">回复</n-button>
        <n-button @click="detailVisible = false">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>
