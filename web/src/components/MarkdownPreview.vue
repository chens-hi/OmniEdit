<script setup lang="ts">
import { computed } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const props = defineProps<{ content: string }>();

// 同步渲染并净化，防止 Markdown 中的脚本注入。
const html = computed(() => {
  const raw = marked.parse(props.content ?? '', { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(raw as string);
});
</script>

<template>
  <div class="md-preview" v-html="html" />
</template>

<style scoped>
.md-preview {
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px;
  color: var(--fg);
  line-height: 1.6;
  font-size: 14px;
}
.md-preview :deep(h1),
.md-preview :deep(h2),
.md-preview :deep(h3) {
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
  margin-top: 20px;
}
.md-preview :deep(code) {
  background: var(--hover);
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 13px;
}
.md-preview :deep(pre) {
  background: rgba(0, 0, 0, 0.3);
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
}
.md-preview :deep(pre code) {
  background: none;
  padding: 0;
}
.md-preview :deep(a) { color: var(--accent); }
.md-preview :deep(blockquote) {
  border-left: 3px solid var(--border);
  margin-left: 0;
  padding-left: 12px;
  color: var(--fg-dim);
}
</style>


