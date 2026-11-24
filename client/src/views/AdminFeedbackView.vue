<script setup lang="ts">
import { NH2, NText, NSelect, NDataTable, NPagination, NModal, NImageGroup, NForm, NFormItem, NInput } from 'naive-ui';
import { h, onMounted, reactive, ref } from 'vue';
import { NButton, NImage, NTag, useMessage, type DataTableColumns } from 'naive-ui';
import { imageApi } from '../services/images';
import type { FeedbackItem, FeedbackStatus, FeedbackType } from '../types/image';
import { formatDateTime } from '../utils/time';

const message = useMessage();
const loading = ref(false);
const replying = ref(false);
const changingStatus = ref(false);
const feedbacks = ref<FeedbackItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const status = ref<FeedbackStatus | null>(null);
const replyVisible = ref(false);
const activeFeedback = ref<FeedbackItem | null>(null);
const replyForm = reactive({ reply: '' });

const statusOptions = [
  { label: '未处理', value: 'pending' },
  { label: '处理中', value: 'processing' },
  { label: '已解决', value: 'resolved' }
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function statusLabel(value: FeedbackStatus) {
  return { pending: '未处理', processing: '处理中', resolved: '已解决' }[value];
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

function feedbackCanReply(feedback: FeedbackItem | null) {
  return Boolean(feedback && feedback.status !== 'resolved');
}

function canResolveFeedback(feedback: FeedbackItem) {
  return feedback.status !== 'resolved' && feedback.messages.length > 0;
}

function canReopenFeedback(feedback: FeedbackItem) {
  return feedback.status === 'resolved';
}

function paginationPrefix({ itemCount }: { itemCount?: number }) {
  return `共 ${itemCount ?? total.value} 条反馈`;
}

async function loadFeedbacks(nextPage = page.value, nextPageSize = pageSize.value) {
  loading.value = true;
  try {
    const result = await imageApi.feedbacks({ page: nextPage, pageSize: nextPageSize, status: status.value });
    feedbacks.value = result.items;
    total.value = result.total;
    page.value = result.page;
    pageSize.value = result.pageSize;
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

function openReply(feedback: FeedbackItem) {
  activeFeedback.value = feedback;
  replyForm.reply = '';
  replyVisible.value = true;
}

async function submitReply() {
  const feedback = activeFeedback.value;
  if (!feedback || feedback.status === 'resolved') return;
  if (!replyForm.reply.trim()) {
    message.warning('请填写回复内容');
    return;
  }
  replying.value = true;
  try {
    const result = await imageApi.replyFeedback(feedback.id, { status: 'processing', reply: replyForm.reply.trim() });
    activeFeedback.value = result.feedback;
    replyForm.reply = '';
    await loadFeedbacks(page.value, pageSize.value);
    message.success('回复已发送');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    replying.value = false;
  }
}

async function changeFeedbackStatus(feedback: FeedbackItem, nextStatus: FeedbackStatus) {
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

const columns: DataTableColumns<FeedbackItem> = [
  { title: '问题标题', key: 'title', minWidth: 160, ellipsis: { tooltip: true } },
  { title: '类型', key: 'type', width: 116, render: row => typeLabel(row.type) },
  { title: '提交人', key: 'submitter', width: 120 },
  {
    title: '状态', key: 'status', width: 108,
    render: row => h(NTag, { size: 'small', type: statusType(row.status) }, { default: () => statusLabel(row.status) })
  },
  { title: '提交时间', key: 'submittedAt', width: 180, render: row => formatDate(row.submittedAt) },
  { title: '最后回复人', key: 'repliedBy', width: 120, render: row => row.repliedBy || '-' },
  {
    title: '附件', key: 'images', width: 84,
    render: row => row.images.length
      ? h(NImage, { width: 38, height: 38, src: row.images[0].url, objectFit: 'cover', previewSrcList: row.images.map(image => image.url) })
      : '-'
  },
  {
    title: '操作', key: 'actions', width: 100, fixed: 'right',
    render: row => h('div', { class: 'feedback-action-buttons' }, [
      h(NButton, { size: 'small', type: row.status === 'resolved' ? 'default' : 'primary', onClick: () => openReply(row) }, { default: () => row.status === 'resolved' ? '查看详情' : '处理反馈' }),

    ])
  },
  {
    title: '状态转换', key: 'statusActions', width: 100, fixed: 'right',
    render: row => h('div', { class: 'feedback-action-buttons' }, [
      row.status === 'resolved'
        ? h(NButton, { size: 'small', type: 'warning', secondary: true, loading: changingStatus.value, disabled: !canReopenFeedback(row), onClick: () => void changeFeedbackStatus(row, 'processing') }, { default: () => '继续处理' })
        : h(NButton, { size: 'small', type: 'success', loading: changingStatus.value, disabled: !canResolveFeedback(row), onClick: () => void changeFeedbackStatus(row, 'resolved') }, { default: () => '处理完成' })

    ])
  },
];

onMounted(() => void loadFeedbacks());
</script>

<template>
  <div class="admin-page admin-feedback-page">
    <div class="feedback-page-header">
      <div>
        <n-h2 class="page-title">问题反馈</n-h2>
        <n-text depth="3">查看打分人提交的问题并进行处理答复</n-text>
      </div>

    </div>

    <div class="table-shell feedback-table-shell">
      <div class="feedback-filter-bar">
        <n-select v-model:value="status" clearable :options="statusOptions" placeholder="筛选处理状态"
          @update:value="() => void loadFeedbacks(1, pageSize)" />
      </div>
      <div class="feedback-table-body">
        <n-data-table v-if="feedbacks.length" :columns="columns" :data="feedbacks" :loading="loading" :bordered="false"
          remote :scroll-x="1240" />
        <div v-else class="empty">{{ loading ? '正在加载反馈...' : '暂无问题反馈' }}</div>
      </div>
      <div class="feedback-table-footer">
        <n-pagination v-if="total" :page="page" :page-size="pageSize" :item-count="total" show-size-picker
          :page-sizes="[10, 20, 50]" :prefix="paginationPrefix"
          @update:page="(next: number) => void loadFeedbacks(next, pageSize)"
          @update:page-size="(next: number) => void loadFeedbacks(1, next)" />
      </div>
    </div>
  </div>

  <n-modal v-model:show="replyVisible" preset="card" class="feedback-reply-modal" content-scrollable title="处理反馈"
    :bordered="false">
    <template v-if="activeFeedback">
      <div class="feedback-dialog-body">
        <div class="feedback-dialog-context">
          <div class="feedback-detail-summary">
            <div><span>提交人</span><strong>{{ activeFeedback.submitter }}</strong></div>
            <div><span>问题类型</span><strong>{{ typeLabel(activeFeedback.type) }}</strong></div>
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
            <n-tag size="small" :type="statusType(activeFeedback.status)">{{ statusLabel(activeFeedback.status) }}</n-tag>
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
        <n-form v-if="feedbackCanReply(activeFeedback)" label-placement="top">
          <n-form-item label="继续回复" required>
            <n-input v-model:value="replyForm.reply" type="textarea" :autosize="{ minRows: 5, maxRows: 10 }"
              maxlength="5000" show-count placeholder="填写处理说明或答复内容" />
          </n-form-item>
        </n-form>
      </div>
    </template>
    <template #footer>
      <div class="feedback-modal-actions">
        <n-button v-if="feedbackCanReply(activeFeedback)" type="primary" :loading="replying"
          :disabled="!replyForm.reply.trim()" @click="submitReply">继续回复</n-button>
        <n-button @click="replyVisible = false">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>
