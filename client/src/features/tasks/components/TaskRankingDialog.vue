<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NImagePreview, useDialog, useMessage } from 'naive-ui';
import { currentUser } from '../../../composables/auth';
import { taskCriteria, type TaskCriterionKey } from '../../../constants/scoreCriteria';
import { imageApi } from '../../../services/images';
import { HttpError, isQueryUnavailable } from '../../../services/http';
import AsyncStatePlaceholder from '../../../components/AsyncStatePlaceholder.vue';
import type { RankingRelation, RatingTask, RatingTaskItem, TaskSubmissionMode } from '../../../types/image';

const props = defineProps<{
  show: boolean;
  task: RatingTask | null;
  getNextTask?: (savedTask: RatingTask) => Promise<RatingTask | null>;
}>();
const emit = defineEmits<{
  'update:show': [value: boolean];
  saved: [task: RatingTask, advancing: boolean];
  next: [task: RatingTask];
}>();
const RAPID_SUBMISSION_INTERVAL_MS = 3000;
const message = useMessage();
const dialog = useDialog();
const saving = ref(false);
const submitError = ref(false);
const nextTaskError = ref(false);
const nextTaskRetrying = ref(false);
const lastSavedTask = ref<RatingTask | null>(null);
const lastSubmissionAt = ref<number | null>(null);
const orderedItems = ref<RatingTaskItem[]>([]);
const excludedImageIds = ref<string[]>([]);
const correctImageIds = ref<string[]>([]);
const equalPairKeys = ref<string[]>([]);
const rankingActionCount = ref(0);
const draggingIndex = ref<number | null>(null);
const openedAt = ref(0);
const detailItem = ref<RatingTaskItem | null>(null);
const detailVisible = ref(false);
const imagePreviewVisible = ref(false);
const imagePreviewSrc = ref('');

function handlePreviewEscape(event: KeyboardEvent) {
  if (!visible.value || !imagePreviewVisible.value || event.key !== 'Escape') return;

  // NImagePreview and NModal both listen on document. Consume Esc while the
  // preview is open so the first press closes only the image preview.
  event.preventDefault();
  event.stopImmediatePropagation();
  imagePreviewVisible.value = false;
}

function handlePreviewImageClick(event: MouseEvent) {
  if (!imagePreviewVisible.value) return;
  const target = event.target;
  if (target instanceof HTMLImageElement && target.classList.contains('n-image-preview')) {
    imagePreviewVisible.value = false;
  }
}

onMounted(() => {
  window.addEventListener('keydown', handlePreviewEscape, true);
  document.addEventListener('click', handlePreviewImageClick, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handlePreviewEscape, true);
  document.removeEventListener('click', handlePreviewImageClick, true);
});

const visible = computed({
  get: () => props.show,
  set: (value: boolean) => emit('update:show', value)
});

const criterion = computed(() => props.task?.criterion as TaskCriterionKey | undefined);
const criterionLabel = computed(() => taskCriteria.find(item => item.key === criterion.value)?.label || '综合排序');
const isEditing = computed(() => props.task?.status === 'completed');
const isPromptAlignment = computed(() => criterion.value === 'promptAlignment');
const isCorrectnessCriterion = computed(() => criterion.value === 'textCorrectness' || criterion.value === 'anatomyNormality');
const supportsExclusion = computed(() => criterion.value === 'realism' || criterion.value === 'textCorrectness' || criterion.value === 'anatomyNormality');
const correctButtonLabel = computed(() => criterion.value === 'anatomyNormality' ? '确认肢体正确' : '确认文字正确');
const excludedIdSet = computed(() => new Set(excludedImageIds.value));
const correctIdSet = computed(() => new Set(correctImageIds.value));
const displayedItems = computed(() => orderedItems.value);
const excludedItems = computed(() => {
  const task = props.task;
  if (!task) return [];
  return task.items
    .filter(item => excludedIdSet.value.has(item.imageId))
    .sort((left, right) => left.position - right.position);
});
const rankingComplete = computed(() => {
  const task = props.task;
  if (!task) return false;
  const taskIds = new Set(task.items.map(item => item.imageId));
  const orderedIds = new Set(orderedItems.value.map(item => item.imageId));
  const excludedIds = new Set(excludedImageIds.value);
  if (orderedIds.size + excludedIds.size !== taskIds.size) return false;
  if ([...orderedIds].some(imageId => excludedIds.has(imageId))) return false;
  return [...orderedIds, ...excludedIds].every(imageId => taskIds.has(imageId));
});
const rankingRelations = computed<RankingRelation[]>(() => orderedItems.value.slice(0, -1).map((item, index) => {
  const nextItem = orderedItems.value[index + 1];
  return nextItem && equalPairKeys.value.includes(pairKey(item.imageId, nextItem.imageId)) ? '=' : '>';
}));
const detailPrompt = computed(() => {
  const image = detailItem.value?.image;
  return image?.prompt || image?.catalog?.actual_input_prompt || image?.catalog?.prompt || '';
});

const rulePoints: Record<string, string[]> = {
  overall: ['一眼评，不参考其他分数。'],
  creativity: ['视觉记忆性、趣味性、视觉冲击力、天马行空的想象力。'],
  mood: ['情绪传达度、氛围、意境、故事感。'],
  composition: ['主体明确性、视觉层级清晰性、画面平衡性、视线引导性。'],
  color: ['色彩协调，或有明确控制且协调，或用色大胆且协调。'],
  lighting: ['光影和谐美观性、光影为画面的加分度、明暗层级是否协调。'],
  realism: ['皮肤质感真实、材质可信度、摄影美观度、摄影真实性。'],
  detail: ['画面细节性。'],
  discomfort: ['是否产生观感不舒适、恶心、厌恶、涉黄或暴力。'],
  promptAlignment: ['生成结果与提示词中的主体、场景、风格和关键约束的一致程度。'],
  textCorrectness: ['文字是否正确、清晰，无错别字或乱码。'],
  anatomyNormality: ['肢体、关节、五官和身体比例是否自然。'],
  informationClarity: ['信息传达是否突出、明确。'],
  designQuality: ['整体布局、视觉系统与设计完成度。'],
  typography: ['文字排版、字形选择和信息层级是否协调。']
};

const currentRulePoints = computed(() => criterion.value ? rulePoints[criterion.value] : rulePoints.overall);

function resetOrder() {
  submitError.value = false;
  nextTaskError.value = false;
  lastSavedTask.value = null;
  const task = props.task;
  if (!task) {
    orderedItems.value = [];
    excludedImageIds.value = [];
    correctImageIds.value = [];
    equalPairKeys.value = [];
    rankingActionCount.value = 0;
    return;
  }
  const storedExclusions = supportsExclusion.value
    ? new Set(task.excludedImageIds || [])
    : new Set<string>();
  const storedCorrectIds = isCorrectnessCriterion.value
    ? new Set(task.correctImageIds || [])
    : new Set<string>();
  excludedImageIds.value = task.items
    .filter(item => storedExclusions.has(item.imageId))
    .map(item => item.imageId);
  correctImageIds.value = task.items
    .filter(item => storedCorrectIds.has(item.imageId) && !storedExclusions.has(item.imageId))
    .map(item => item.imageId);
  const itemById = new Map(task.items.map(item => [item.imageId, item]));
  const used = new Set<string>();
  const ordered = (task.ranking || []).reduce<RatingTaskItem[]>((items, imageId) => {
    const item = itemById.get(imageId);
    if (item && !storedExclusions.has(imageId) && !used.has(imageId)) {
      items.push(item);
      used.add(imageId);
    }
    return items;
  }, []);

  task.items
    .slice()
    .sort((left, right) => left.position - right.position)
    .forEach(item => {
      if (!storedExclusions.has(item.imageId) && !used.has(item.imageId)) {
        ordered.push(item);
        used.add(item.imageId);
      }
    });

  orderedItems.value = ordered;
  const storedRanking = task.ranking || [];
  const storedRelations = task.rankingRelations || [];
  equalPairKeys.value = storedRelations.reduce<string[]>((pairs, relation, index) => {
    const leftId = storedRanking[index];
    const rightId = storedRanking[index + 1];
    if (relation === '=' && leftId && rightId) pairs.push(pairKey(leftId, rightId));
    return pairs;
  }, []);
  rankingActionCount.value = 0;
  draggingIndex.value = null;
  openedAt.value = Date.now();
}

function markRankingAction() {
  rankingActionCount.value += 1;
}

watch(() => [props.show, props.task], ([show]) => {
  if (show) resetOrder();
}, { immediate: true });

function startDrag(index: number, event: DragEvent) {
  draggingIndex.value = index;
  event.dataTransfer?.setData('text/plain', String(index));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function moveItem(targetIndex: number) {
  const sourceIndex = draggingIndex.value;
  if (sourceIndex === null || sourceIndex === targetIndex) return;
  const next = [...orderedItems.value];
  const [item] = next.splice(sourceIndex, 1);
  if (!item) return;
  next.splice(targetIndex, 0, item);
  orderedItems.value = next;
  draggingIndex.value = targetIndex;
  markRankingAction();
}

function endDrag() {
  draggingIndex.value = null;
}

function pairKey(leftId: string, rightId: string) {
  return [leftId, rightId].sort().join(':');
}

function relationAt(index: number): RankingRelation {
  const left = orderedItems.value[index];
  const right = orderedItems.value[index + 1];
  return left && right && equalPairKeys.value.includes(pairKey(left.imageId, right.imageId)) ? '=' : '>';
}

function rankAt(index: number) {
  let rank = 1;
  for (let current = 1; current <= index; current++) {
    if (relationAt(current - 1) === '>') rank += 1;
  }
  return rank;
}

function toggleRelation(index: number) {
  const left = orderedItems.value[index];
  const right = orderedItems.value[index + 1];
  if (!left || !right) return;
  const key = pairKey(left.imageId, right.imageId);
  equalPairKeys.value = equalPairKeys.value.includes(key)
    ? equalPairKeys.value.filter(pair => pair !== key)
    : [...equalPairKeys.value, key];
  markRankingAction();
}

function openDetail(item: RatingTaskItem) {
  detailItem.value = item;
  detailVisible.value = true;
}

function openImagePreview(item: RatingTaskItem) {
  imagePreviewSrc.value = item.image.imageUrl;
  imagePreviewVisible.value = true;
}

function toggleExclusion(item: RatingTaskItem) {
  if (!supportsExclusion.value) return;

  if (excludedIdSet.value.has(item.imageId)) {
    excludedImageIds.value = excludedImageIds.value.filter(imageId => imageId !== item.imageId);
    if (!orderedItems.value.some(orderedItem => orderedItem.imageId === item.imageId)) {
      orderedItems.value = [...orderedItems.value, item];
    }
    return;
  }

  correctImageIds.value = correctImageIds.value.filter(imageId => imageId !== item.imageId);
  excludedImageIds.value = Array.from(new Set([...excludedImageIds.value, item.imageId]));
  orderedItems.value = orderedItems.value.filter(orderedItem => orderedItem.imageId !== item.imageId);
  draggingIndex.value = null;
  if (!isCorrectnessCriterion.value) markRankingAction();
}

function toggleCorrect(item: RatingTaskItem) {
  if (!isCorrectnessCriterion.value) return;
  if (correctIdSet.value.has(item.imageId)) {
    correctImageIds.value = correctImageIds.value.filter(imageId => imageId !== item.imageId);
    return;
  }
  excludedImageIds.value = excludedImageIds.value.filter(imageId => imageId !== item.imageId);
  if (!orderedItems.value.some(orderedItem => orderedItem.imageId === item.imageId)) {
    orderedItems.value = [...orderedItems.value, item];
  }
  correctImageIds.value = Array.from(new Set([...correctImageIds.value, item.imageId]));
}

type RapidSubmissionDecision = 'rescore' | 'continue' | 'cancel';

function askRapidSubmissionConfirmation(intervalMs: number) {
  const intervalSeconds = (intervalMs / 1000).toFixed(2);
  return new Promise<RapidSubmissionDecision>(resolve => {
    let settled = false;
    const finish = (decision: RapidSubmissionDecision) => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };

    dialog.warning({
      title: '打分提交过快',
      content: `本次提交与上一次提交仅间隔 ${intervalSeconds} 秒，可能存在误操作。是否需要重新检查当前任务？`,
      positiveText: '存在误操作，重新打',
      negativeText: '继续提交',
      onPositiveClick: () => finish('rescore'),
      onNegativeClick: () => finish('continue'),
      onClose: () => finish('cancel')
    });
  });
}

function reopenForRescoring() {
  resetOrder();
  visible.value = false;
  window.setTimeout(() => {
    visible.value = true;
  }, 180);
}

async function submit(advance = false) {
  const task = props.task;
  const scorer = currentUser.value?.username;
  if (!task || !scorer || saving.value) return;

  const submissionIntervalMs = lastSubmissionAt.value == null
    ? null
    : Date.now() - lastSubmissionAt.value;
  if (submissionIntervalMs != null && submissionIntervalMs < RAPID_SUBMISSION_INTERVAL_MS) {
    const decision = await askRapidSubmissionConfirmation(submissionIntervalMs);
    if (decision === 'rescore') reopenForRescoring();
    if (decision !== 'continue') return;
  }

  saving.value = true;
  submitError.value = false;
  nextTaskError.value = false;
  try {
    const submissionMode: TaskSubmissionMode = rankingActionCount.value > 0 ? 'ranked' : 'direct';
    const trackingPayload = { submissionMode, rankingActionCount: rankingActionCount.value };
    const payload = {
      scorer,
      projectId: task.projectId || task.subjectId,
      ranking: orderedItems.value.map(item => item.imageId),
      rankingRelations: rankingRelations.value,
      excludedImageIds: excludedImageIds.value,
      correctImageIds: isCorrectnessCriterion.value ? correctImageIds.value : [],
      ...trackingPayload,
      durationMs: Math.max(Date.now() - openedAt.value, 0)
    };
    const result = isEditing.value
      ? await imageApi.updateCompletedTask(task.id, payload)
      : await imageApi.completeTask(task.id, payload);
    await handleSavedTask(result.task, advance);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && !isEditing.value) {
      try {
        const recovered = (await imageApi.assignedTaskDetail(task.id)).task;
        if (recovered.status === 'completed' && recovered.scorer === scorer) {
          await handleSavedTask(recovered, advance);
          return;
        }
      } catch {}
    }
    if (isQueryUnavailable(error)) submitError.value = true;
    else message.error(error instanceof Error ? error.message : '提交失败');
  } finally {
    saving.value = false;
  }
}

async function handleSavedTask(savedTask: RatingTask, advance: boolean) {
  lastSubmissionAt.value = Date.now();
  lastSavedTask.value = savedTask;
  emit('saved', savedTask, advance);

  if (!advance) {
    message.success(isEditing.value ? '修改已保存' : '任务已提交');
    visible.value = false;
    return;
  }

  try {
    const nextTask = await props.getNextTask?.(savedTask);
    if (nextTask) {
      message.success('任务已提交，已打开下一条');
      emit('next', nextTask);
      return;
    }

    message.success('任务已提交');
    message.info('当前筛选条件下没有下一条待处理任务');
    visible.value = false;
  } catch (error) {
    if (isQueryUnavailable(error)) nextTaskError.value = true;
    else message.error(error instanceof Error ? `当前任务已提交，${error.message}` : '当前任务已提交，但加载下一条失败');
  }
}

async function retryNextTask() {
  const task = lastSavedTask.value;
  if (!task || !props.getNextTask || nextTaskRetrying.value) return;
  nextTaskRetrying.value = true;
  try {
    const nextTask = await props.getNextTask(task);
    if (nextTask) {
      nextTaskError.value = false;
      emit('next', nextTask);
      return;
    }
    nextTaskError.value = false;
    visible.value = false;
  } catch (error) {
    if (!isQueryUnavailable(error)) message.error(error instanceof Error ? error.message : '加载下一条失败');
  } finally {
    nextTaskRetrying.value = false;
  }
}
</script>

<template>
  <n-modal v-model:show="visible" preset="card" class="task-ranking-modal" :bordered="false"
    :close-on-esc="!imagePreviewVisible">
    <template #header>
      <div class="task-ranking-heading">
        <div class="task-ranking-title">{{ criterionLabel }}：</div>
        <n-alert v-if="!isCorrectnessCriterion" class="task-ranking-instruction" type="info">
          <span style="font-size: 1.2em;">拖动排序，&gt; 表示前者优于后者，= 表示两张图片同档</span>
        </n-alert>
        <n-alert v-else class="task-ranking-instruction" type="success">
          <span style="font-size: 1.2em;">拖动可评价图片进行排序；点击“{{ correctButtonLabel }}”表示正确；不点击默认不正确；“×”表示该图片不符合当前维度，无需打分</span>
        </n-alert>
      </div>
    </template>

    <div class="task-ranking-layout" style="padding-top:20px">
      <section class="task-ranking-board" aria-label="图片排序">
        <div class="task-ranking-list" :class="{ 'is-correctness-list': isCorrectnessCriterion }">
          <template v-for="(item, index) in displayedItems" :key="item.imageId">
            <article class="task-ranking-item"
              :class="{ 'is-dragging': draggingIndex === index, 'is-correctness': isCorrectnessCriterion, 'is-correct': correctIdSet.has(item.imageId) }"
              :draggable="true" @dragstart="startDrag(index, $event)"
              @dragenter.prevent="moveItem(index)" @dragover.prevent @drop.prevent="endDrag" @dragend="endDrag"
              @click.stop="openImagePreview(item)">
              <div class="task-ranking-position">{{ isCorrectnessCriterion ? index + 1 : rankAt(index) }}</div>
              <div v-if="isCorrectnessCriterion" class="task-ranking-correctness-actions">
                <n-button class="task-ranking-confirm-button" type="primary" size="small" block
                  :secondary="!correctIdSet.has(item.imageId)"
                  :class="{ 'is-active': correctIdSet.has(item.imageId) }"
                  :title="correctIdSet.has(item.imageId) ? `取消${correctButtonLabel}，恢复为默认不正确` : correctButtonLabel"
                  :aria-label="correctIdSet.has(item.imageId) ? `取消${correctButtonLabel}，恢复为默认不正确` : correctButtonLabel"
                  :aria-pressed="correctIdSet.has(item.imageId)" @pointerdown.stop @dragstart.stop.prevent
                  @click.stop="toggleCorrect(item)">
                  {{ correctIdSet.has(item.imageId) ? `已${correctButtonLabel}` : correctButtonLabel }}
                </n-button>
              </div>
              <div v-if="isCorrectnessCriterion" class="task-ranking-image-frame">
                <img :src="item.image.thumbnailUrl || item.image.imageUrl" :alt="item.image.filename" draggable="false" />
                <n-button class="task-ranking-exclude-button" type="error" circle size="small" title="标记为不符合当前维度"
                  aria-label="标记为不符合当前维度" @pointerdown.stop @dragstart.stop.prevent
                  @click.stop="toggleExclusion(item)">×</n-button>
              </div>
              <img v-else :src="item.image.thumbnailUrl || item.image.imageUrl" :alt="item.image.filename"
                draggable="false" />
              <n-button v-if="supportsExclusion && !isCorrectnessCriterion" class="task-ranking-exclude-button"
                type="error" circle size="small" title="标记为不符合当前维度" aria-label="标记为不符合当前维度" @pointerdown.stop
                @dragstart.stop.prevent @click.stop="toggleExclusion(item)">×</n-button>
              <n-button class="task-ranking-detail-button" type="primary" size="tiny" @pointerdown.stop
                @dragstart.stop.prevent @click.stop="openDetail(item)"
                v-if="criterionLabel === 'Prompt alignment'">prompt</n-button>

            </article>
            <button v-if="index < orderedItems.length - 1" type="button"
              class="task-ranking-relation-button" :class="{ 'is-equal': relationAt(index) === '=' }"
              :title="relationAt(index) === '=' ? '同档，点击切换为优先级' : '前者优于后者，点击切换为同档'"
              :aria-label="relationAt(index) === '=' ? '同档，点击切换为优先级' : '前者优于后者，点击切换为同档'" @pointerdown.stop
              @dragstart.stop.prevent @click.stop="toggleRelation(index)">{{ relationAt(index) }}</button>
          </template>
          <article v-for="item in excludedItems" :key="item.imageId" class="task-ranking-item is-excluded"
            :class="{ 'is-correctness': isCorrectnessCriterion }" @dblclick.stop="openImagePreview(item)">
            <div v-if="!isCorrectnessCriterion" class="task-ranking-position task-ranking-position-excluded">不评价</div>
            <div v-if="isCorrectnessCriterion" class="task-ranking-correctness-actions">
              <n-button class="task-ranking-confirm-button" type="primary" size="small" block secondary :title="correctButtonLabel"
                :aria-label="correctButtonLabel" @pointerdown.stop @dragstart.stop.prevent
                @click.stop="toggleCorrect(item)">
                {{ correctButtonLabel }}
              </n-button>
            </div>
            <div v-if="isCorrectnessCriterion" class="task-ranking-image-frame">
              <div class="task-ranking-position task-ranking-position-excluded">不评价</div>
              <img :src="item.image.thumbnailUrl || item.image.imageUrl" :alt="item.image.filename" draggable="false" />
              <n-button class="task-ranking-exclude-button" type="error" circle size="small" title="恢复待判定"
                aria-label="恢复待判定" @pointerdown.stop @dragstart.stop.prevent
                @click.stop="toggleExclusion(item)">-</n-button>
            </div>
            <img v-else :src="item.image.thumbnailUrl || item.image.imageUrl" :alt="item.image.filename"
              draggable="false" />
            <n-button v-if="!isCorrectnessCriterion" class="task-ranking-exclude-button" type="default" circle
              size="small" title="恢复到待确认" aria-label="恢复到待确认" @click.stop="toggleExclusion(item)">-</n-button>
            <n-button class="task-ranking-detail-button" type="primary" size="tiny" @pointerdown.stop
              @dragstart.stop.prevent @click.stop="openDetail(item)"
              v-if="criterionLabel === 'Prompt alignment'">prompt</n-button>
          </article>
        </div>
        <div class="task-rule-heading-wrap">
          <div class="task-rule-panel-header">
            <strong>评分规则</strong>
            <n-text depth="3">{{ criterionLabel }}：{{ currentRulePoints[0] }}</n-text>
          </div>
        </div>
        <n-alert type="error" v-if="supportsExclusion && !isCorrectnessCriterion">
          <template #icon>
            <n-icon>
              <svg t="1786179085614" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg"
                p-id="5218" width="48" height="48">
                <path
                  d="M512 512a128 128 0 1 1 0-256 128 128 0 0 1 0 256z m0-85.333333a42.666667 42.666667 0 1 0 0-85.333334 42.666667 42.666667 0 0 0 0 85.333334z m341.333333 85.333333a341.333333 341.333333 0 1 0-682.666666 0c0 131.925333 72.874667 246.186667 189.354666 302.976a42.666667 42.666667 0 0 1-37.376 76.714667C177.066667 820.736 85.333333 676.864 85.333333 512 85.333333 276.352 276.352 85.333333 512 85.333333s426.666667 191.018667 426.666667 426.666667-191.018667 426.666667-426.666667 426.666667a42.666667 42.666667 0 0 1-42.666667-42.666667v-298.709333a42.666667 42.666667 0 1 1 85.333334 0v253.44A341.376 341.376 0 0 0 853.333333 512z"
                  p-id="5219"></path>
              </svg>
            </n-icon>
          </template>
          <div class="task-ranking-hint">
            <n-text>如果不符合该测试打分项，需点击右上角"×"，不对该图进行拖动打分。并标记该图不符合该维度</n-text>
            <n-text>例如无肢体出现的图片，在打肢体正确性分数时，需要点"×"</n-text>
            <n-text>例如无文字出现的图片，在打文字正确性分数时，需要点"×"</n-text>
            <n-text>例如无肖像/摄影的真实图片，在打肖像/摄影真实感分数时，需要点"×"</n-text>
          </div>
        </n-alert>
        <n-alert type="success" v-if="isCorrectnessCriterion">
          <div class="task-ranking-hint">
            <n-text>拖动可评价图片进行排序；点击“{{ correctButtonLabel }}”确认正确；不点击确认的图片默认判定为不正确；点击“×”表示图片不符合该维度，无需打分。</n-text>
          </div>
        </n-alert>

      </section>

      <AsyncStatePlaceholder v-if="nextTaskError" state="unavailable" title="下一条任务暂时无法加载"
        description="当前任务已提交，稍后重试即可继续。" :retrying="nextTaskRetrying" @retry="retryNextTask" />

    </div>

    <template #footer>
      <div class="task-ranking-actions" style="padding-right:20px">
        <AsyncStatePlaceholder v-if="submitError" state="unavailable" title="提交暂时未完成"
          description="评分内容仍在当前页面，稍后重试即可。" retry-label="重新提交" @retry="() => void submit()" />
        <n-button @click="visible = false" size="large" style="font-size:20px;margin-right:10px">取消</n-button>
        <n-button type="primary" :loading="saving" :disabled="!rankingComplete" @click="submit" size="large"
          style="font-size:20px">{{ isEditing
            ? (isCorrectnessCriterion ? '保存确认' : '保存修改') :
            (isCorrectnessCriterion ? '提交确认' : '提交排序') }}</n-button>
      </div>
    </template>
  </n-modal>

  <n-modal v-model:show="detailVisible" preset="card" class="task-image-detail-modal" title="图片详情" :bordered="false">
    <div v-if="detailItem" class="task-image-detail-body">
      <n-image class="task-image-detail-preview" :src="detailItem.image.thumbnailUrl || detailItem.image.imageUrl"
        :preview-src="detailItem.image.imageUrl" :alt="detailItem.image.filename" object-fit="contain"
        show-toolbar-tooltip />
      <div class="task-image-detail-panel">
        <template v-if="isPromptAlignment">

          <div class="task-image-detail-prompt">
            <span>Prompt</span>
            <n-scrollbar class="task-image-detail-prompt-scroll">
              <p>{{ detailPrompt || '该图片未匹配到 Prompt 信息' }}</p>
            </n-scrollbar>
          </div>
        </template>
      </div>
    </div>
  </n-modal>

  <NImagePreview v-model:show="imagePreviewVisible" :src="imagePreviewSrc" show-toolbar-tooltip />
</template>

<style scoped>
.task-ranking-instruction :deep(.n-alert__icon) {
  top: 50% !important;
  bottom: auto !important;
  height: var(--n-icon-size) !important;

  transform: translateY(-50%) !important;
}
</style>
