<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * 统一预览面板（多后缀共用渲染模板），桌面/移动同一渲染管线：
 *   - markdown：marked 解析 + DOMPurify 净化（md/markdown 共用）。
 *   - html：DOMPurify 直接净化后内联渲染（htm/html 共用）。
 *     弃用 iframe：移动 webview 对 srcdoc / blob URL 均渲染空白；内联路径与
 *     markdown 同源，实测在移动 webview 正常。
 *     已知取舍：html 内 <style> 被 DOMPurify 保留并生效；但作用于
 *     html/body 的选择器不生效（内容注入 div）；<script> 一律净化剥离；
 *     相对路径资源（图片等）无法解析——与之前 iframe 行为一致。
 *
 * 性能：同页签编辑防抖 250ms；切页签立即同步新内容（无残留闪烁）。
 */
const props = defineProps<{ tabId: number; kind: 'markdown' | 'html'; content: string }>();

// 预览内容（防抖）：同页签编辑 → 停止输入 250ms 后更新；切页签 → 立即同步。
const debounced = ref(props.content);
let timer: number | undefined;
watch(() => props.content, (v) => {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { debounced.value = v; }, 250);
});
// 切页签（tabId 变化）：立刻同步到新页签内容，清掉上一页残留。
watch(() => props.tabId, () => {
  window.clearTimeout(timer);
  debounced.value = props.content;
});
onBeforeUnmount(() => window.clearTimeout(timer));

// 渲染输出：markdown 解析后净化；html 直接净化。
const rendered = computed(() => {
  const src = debounced.value ?? '';
  if (props.kind === 'markdown') {
    const raw = marked.parse(src, { async: false, gfm: true, breaks: true });
    return DOMPurify.sanitize(raw as string);
  }
  return DOMPurify.sanitize(src);
});
</script>

<template>
  <div class="pv-doc" :class="kind === 'markdown' ? 'pv-md' : 'pv-html'" v-html="rendered" />
</template>

<style scoped>
.pv-doc {
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px;
  color: var(--fg);
  background: var(--bg);
  line-height: 1.6;
  font-size: 14px;
}
/* markdown 预览排版（走 CSS 变量，天然适配主题） */
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
/* html 预览：排版交给文档自带样式；仅做溢出防护与基础可读性兜底 */
.pv-html :deep(img),
.pv-html :deep(svg),
.pv-html :deep(video) {
  max-width: 100%;
  height: auto;
}
.pv-html :deep(table) { border-collapse: collapse; }
.pv-html :deep(a) { color: var(--accent); }
</style>
