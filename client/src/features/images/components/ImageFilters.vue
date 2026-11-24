<script setup lang="ts">
import { NSpace, NForm, NFormItem, NSelect } from 'naive-ui';
import { reactive, watch } from 'vue';
import type { ImageQuery } from '../../../types/image';

const props = defineProps<{ modelValue: ImageQuery; categories: string[]; disabled?: boolean; loading?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: ImageQuery] }>();
const filters = reactive<ImageQuery>({ ...props.modelValue });

watch(() => props.modelValue, value => Object.assign(filters, value), { deep: true });
watch(filters, value => emit('update:modelValue', { ...value }), { deep: true });
</script>

<template>
  <n-space vertical size="large">

    <n-form label-placement="top" :disabled="disabled">
      <n-form-item label="目录分类">
        <n-select v-model:value="filters.category" clearable :loading="loading" placeholder="全部目录"
          :options="categories.map(value => ({ label: value, value }))" />
      </n-form-item>
      <n-form-item label="评分状态">
        <n-select v-model:value="filters.status" clearable placeholder="全部"
          :options="[{ label: '未评分', value: 'unrated' }, { label: '已评分', value: 'rated' }]" />
      </n-form-item>
    </n-form>
  </n-space>
</template>
