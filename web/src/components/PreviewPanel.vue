<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { theme } from '../theme';

/**
 * 统一预览面板（多后缀共用渲染模板）：
 *   - markdown：marked 解析 + DOMPurify 净化（md/markdown 共用）。
 *   - html：iframe 用 blob URL 作为 src 渲染（htm/html 共用）。桌面/移动统一，
 *     比 srcdoc 兼容性好（移动 webview 对 srcdoc+sandbox 支持差会空白）。
 *
 * 性能：
 *   - 预览独立防抖 250ms（debounced ref），编辑器 CodeMirror 同步即时不防抖，
 *     预览停止输入 250ms 后才重渲染，避免逐键 parse+净化卡顿。
 *   - html 内容/主题变化时重建 blob URL 并 revoke 旧的，防抖降低频率、避免内存泄漏。
 *
 * 主题：md 走 CSS 变量天然适配；html blob 文档内注入跟随主题的基础样式（theme ref 驱动）。
 */
const props = defineProps<{ kind: 'markdown' | 'html'; content: string }>();

// 预览独立防抖：停止输入 250ms 后再渲染。
const debounced = ref(props.content);
let timer: number | undefined;
watch(() => props.content, (v) => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { debounced.value = v; }, 250);
});
onBeforeUnmount(() => {
  window.clearTimeout(timer);
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
});

// markdown：解析 + 净化（防脚本注入）。
const mdHtml = computed(() => {
  const raw = marked.parse(debounced.value ?? '', { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(raw as string);
});

// html：包成完整文档 + 注入跟随主题的基础样式。
const htmlDoc = computed(() => {
  const light = theme.value === 'light';
  const bg = light ? '#ffffff' : '#1e1e1e';
  const fg = light ? '#24292e' : '#d4d4d4';
  const link = light ? '#0969da' : '#4a9eff';
  const base = `<style>body{margin:0;padding:16px 20px;background:${bg};color:${fg};`
    + `font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;line-height:1.6;font-size:14px}`
    + `a{color:${link}}</style>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${base}</head><body>${debounced.value ?? ''}</body></html>`;
});

// html 预览用 blob URL 作为 iframe src（比 srcdoc 兼容性好，移动 webview 也能渲染）。
// 内容/主题变化时重建 blob URL 并 revoke 旧的，避免内存泄漏。
const blobUrl = ref<string>('');
let lastBlobUrl: string | null = null;
watch(
  [htmlDoc, () => props.kind],
  ([doc, kind]) => {
    if (kind !== 'html') return;
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    const blob = new Blob([doc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    blobUrl.value = url;
    lastBlobUrl = url;
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
});
</script>

<template>
  <div v-if="kind === 'markdown'" class="pv-md" v-html="mdHtml" />
  <iframe v-else class="pv-html" :src="blobUrl" title="preview" />
</template>

<style scoped>
/* markdown 预览（在应用 DOM 内，走 CSS 变量，天然适配主题） */
.pv-md {
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px;
  color: var(--fg);
  line-height: 1.6;
  font-size: 14px;
}
.pv-md :deep(h1),
.pv-md :deep(h2),
.pv-md :deep(h3) {
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
  margin-top: 20px;
}
.pv-md :deep(code) {
  background: rgba(127, 127, 127, 0.15);
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 13px;
}
.pv-md :deep(pre) {
  background: rgba(0, 0, 0, 0.2);
  padding: 12px;
  border-radius: 6px;
  overflow-x: auto;
}
.pv-md :deep(pre code) {
  background: none;
  padding: 0;
}
.pv-md :deep(a) { color: var(--accent); }
.pv-md :deep(blockquote) {
  border-left: 3px solid var(--border);
  margin-left: 0;
  padding-left: 12px;
  color: var(--fg-muted);
}
/* html 预览：iframe 填满预览面板 */
.pv-html {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  background: var(--bg);
}
</style>
