<script setup lang="ts">
import { NButton, NText, NSpin, NPagination, NModal, NImage, NScrollbar } from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { useRoute, useRouter } from 'vue-router';
import { imageApi } from '../services/images';
import type { ImageItem, ImagePage, SubjectItem } from '../types/image';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const subjectId = decodeURIComponent(String(route.params.subjectId));
const pageSize = 24;

const subject = ref<SubjectItem | null>(null);
const page = ref(1);
const loading = ref(false);
const selectedImage = ref<ImageItem | null>(null);
const showDetail = ref(false);
const imagePage = ref<ImagePage>({ total: 0, page: 1, pageSize, items: [] });

const imagePrompt = computed(() => {
  const image = selectedImage.value;
  return image?.prompt?.trim() || image?.catalog?.actual_input_prompt?.trim() || image?.catalog?.prompt?.trim() || '';
});


function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败';
}

function emptyPage(): ImagePage {
  return { total: 0, page: 1, pageSize, items: [] };
}

async function loadImages() {
  loading.value = true;
  try {
    imagePage.value = await imageApi.list({
      subjectId,
      page: page.value,
      pageSize,
      includeTotal: true,
      includeDetails: true
    });
  } catch (error) {
    imagePage.value = emptyPage();
    message.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

async function loadPage() {
  try {
    const subjects = await imageApi.subjects();
    subject.value = subjects.find(item => item._id === subjectId) ?? null;
    if (!subject.value) {
      message.error('图包不存在');
      await router.push('/admin/packages');
      return;
    }
    await loadImages();
  } catch (error) {
    message.error(errorMessage(error));
  }
}

function openDetail(image: ImageItem) {
  selectedImage.value = image;
  showDetail.value = true;
}

watch(page, () => void loadImages());
onMounted(() => void loadPage());
</script>

<template>
  <div class="admin-page admin-subject-content">
    <section class="subject-panel subject-panel--full">


      <div class="subject-table-shell">
        <div class="subject-table-header">
          <div>
            <n-button text @click="router.push('/admin/packages')">
              返回
            </n-button>
            <n-text depth="3">共 {{ imagePage.total }} 张</n-text>
          </div>
        </div>

        <div class="subject-table-body subject-list-body">
          <n-spin :show="loading">
            <div v-if="imagePage.items.length" class="subject-image-list">
              <button v-for="image in imagePage.items" :key="image._id" class="subject-image-item" type="button"
                @click="openDetail(image)">
                <span class="subject-image-thumb">
                  <img :src="image.thumbnailUrl || image.imageUrl" :alt="image.filename" loading="lazy"
                    decoding="async" />
                </span>
                <span class="subject-image-meta">
                  <strong class="subject-image-name">{{ image.filename }}</strong>
                  <span class="subject-image-category">{{ image.directory || image.category }}</span>
                </span>
              </button>
            </div>
            <div v-else class="empty">{{ loading ? '正在加载图片...' : '暂无图片' }}</div>
          </n-spin>
        </div>

        <div class="subject-table-footer">
          <n-pagination v-if="imagePage.total" v-model:page="page" :page-size="pageSize" :item-count="imagePage.total"
            class="subject-pagination" />
        </div>
      </div>
    </section>

    <n-modal v-model:show="showDetail" preset="card" class="image-detail-modal" title="图片详情" :bordered="false">
      <div v-if="selectedImage" class="image-detail-body">
        <n-image class="image-detail-preview" :src="selectedImage.thumbnailUrl || selectedImage.imageUrl"
          :preview-src="selectedImage.imageUrl" :alt="selectedImage.filename" object-fit="contain" show-toolbar-tooltip />
        <div class="image-detail-panel">

          <div class="image-detail-field">
            <span>图片名称</span>
            <strong>{{ selectedImage.filename }}</strong>
          </div>

          <div class="image-detail-field">
            <span>目录</span>
            <strong>{{ selectedImage.directory || selectedImage.category }}</strong>
          </div>
          <div v-if="imagePrompt" class="image-detail-prompt">
            <span>Prompt</span>
            <n-scrollbar class="image-detail-prompt-scroll">
              <p>{{ imagePrompt }}</p>
            </n-scrollbar>
          </div>

          <n-text v-if="!selectedImage.catalog && !imagePrompt" depth="3">没有匹配到 JSON 图片信息</n-text>
        </div>
      </div>
    </n-modal>
  </div>
</template>
