<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { APP_BASE } from '../api';
import { useEditorStore } from '../store';
import { t } from '../i18n';
import { PREVIEW_MAX_BYTES } from '../language';

const store = useEditorStore();

/**
 * 统一预览面板（多后缀共用渲染模板），桌面/移动同一渲染管线：
 *   - markdown：marked 解析 + DOMPurify 净化（md/markdown 共用）。
 *   - html：DOMPurify 直接净化后内联渲染（htm/html 共用）。
 *     弃用 iframe：移动 webview 对 srcdoc / blob URL 均渲染空白；内联路径与
 *     markdown 同源，实测在移动 webview 正常。
 *
 * 相对资源：内容里的相对/绝对路径资源（图片等）重写到后端 /api/file/raw
 *   （按 baseDir 解析成文件系统绝对路径后原样输出字节），内联渲染下也能显示。
 *
 * 性能：同页签编辑防抖 250ms；切页签立即同步新内容（无残留闪烁）。
 */
const props = defineProps<{
  tabId: number;
  kind: 'markdown' | 'html';
  content: string;
  /** 当前文件所在目录（文件系统绝对路径），相对资源解析基准。空 = 草稿不重写。 */
  baseDir: string;
}>();

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
onBeforeUnmount(() => {
  window.clearTimeout(timer);
  window.clearTimeout(renderTimer);
  renderSeq += 1; // 使在途渲染失效
});

// ---- 相对资源重写到 /api/file/raw ----
/** 合并并规范化文件系统路径（解析 ./ 与 ../；后端拒 ".." 段，必须前端先折叠）。 */
function resolveFsPath(baseDir: string, rel: string): string | null {
  // 折叠反斜杠 → 正斜杠统一处理
  const norm = (p: string) => p.replace(/\\/g, '/');
  const segments = norm(baseDir).split('/');
  for (const seg of norm(rel).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (segments.length > 1) segments.pop(); continue; }
    segments.push(seg);
  }
  const joined = segments.join('/');
  // 必须是绝对路径：Unix 以 '/' 开头，Windows 以盘符（D:/）开头。
  // 旧实现只认 '/'，导致 Windows 上（含本地 dev）相对资源全部解析失败、
  // 图片/样式静默不显示；NAS 生产是 /vol1/... 所以线上没有暴露。
  return joined.startsWith('/') || /^[A-Za-z]:\//.test(joined) ? joined : null;
}
/** 是否需要重写的 URL（协议/data/blob/锚点/查询式绝对 URL 等保留原样）。 */
function isRewritableUrl(url: string): boolean {
  if (!url) return false;
  if (/^(https?:)?\/\//i.test(url)) return false;   // http(s) 或协议相对
  if (/^(data|blob|javascript|mailto|tel|about):/i.test(url)) return false;
  if (url.startsWith('#')) return false;            // 页内锚点
  return true;                                      // 相对或文件系统绝对路径
}
/** 是否文件系统绝对路径：Unix 根或 Windows 盘符（D:/ 或 D:\ 前缀）。 */
function isFsAbsolute(url: string): boolean {
  return url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url);
}
/**
 * 把单条 URL 解析成文件系统绝对路径；解析失败返回 null（保留原样）。
 * baseDir 由调用方显式传入（而非读 props）：渲染是异步的，用快照值可避免
 * 渲染期间用户切页签导致新旧路径错配。
 */
function toFsAbs(raw: string, baseDir: string): string | null {
  if (isFsAbsolute(raw)) return raw;                // 已是绝对路径原样用
  return baseDir ? resolveFsPath(baseDir, raw) : null;
}
/** 资源属性映射：选择器 → 属性（video 的 src/poster 分别命中两条规则）。 */
const RES_ATTRS: [string, string][] = [
  ['img[src]', 'src'], ['video[src]', 'src'], ['video[poster]', 'poster'], ['audio[src]', 'src'],
  ['source[src]', 'src'], ['track[src]', 'src'], ['embed[src]', 'src'], ['object[data]', 'data'],
];
function rawUrl(absPath: string): string {
  return `${APP_BASE}/api/file/raw?path=${encodeURIComponent(absPath)}`;
}
/**
 * 净化后遍历 DOM：
 *   - 资源类相对路径重写为 /api/file/raw 绝对 URL。
 *   - <a> 把原始 href 存到 data-href（点击复制用）；本地文件链接重写为 raw
 *     接口。渲染后点击统一拦截（见 onPreviewClick），不再依赖 target=_blank
 *     （嵌入式 webview 会忽略并就地导航冲掉 SPA）。
 */
function rewriteResUrls(sanitized: string, baseDir: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = sanitized;
  for (const [selector, attr] of RES_ATTRS) {
    tpl.content.querySelectorAll(selector).forEach((el) => {
      const raw = el.getAttribute(attr);
      if (!raw || !isRewritableUrl(raw)) return;
      const abs = toFsAbs(raw, baseDir);
      if (!abs) return;
      el.setAttribute(attr, rawUrl(abs));
    });
  }
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href');
    if (!raw) return;
    // 原始链接快照：点击复制给用户的值（md 里的相对路径/原始 URL，非内部 API 地址）。
    a.setAttribute('data-href', raw);
    // 本地文件链接（相对/绝对路径）→ 重写为 raw 接口；外链/data/锚点保留原 href。
    if (isRewritableUrl(raw)) {
      const abs = toFsAbs(raw, baseDir);
      if (abs) a.setAttribute('href', rawUrl(abs));
    }
  });
  return tpl.innerHTML;
}

/**
 * 预览内链接点击拦截（MD/HTML 统一，事件委托——内容是 v-html 动态渲染的）：
 *   - 页内锚点（#xxx）放行（浏览器仅滚动定位，不会导航）。
 *   - 其余链接一律 preventDefault（防 webview 就地导航冲掉 SPA），
 *     复制原始链接（data-href）并 toast 提示。
 */
function onPreviewClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href') ?? '';
  if (href.startsWith('#')) return;
  e.preventDefault();
  const raw = a.getAttribute('data-href') || href;
  void navigator.clipboard.writeText(raw).catch(() => {});
  store.toast(t('linkCopied'), 'success');
}

// 超大保护：>1MB 不渲染（全量 DOM 渲染会阻塞主线程数百毫秒且内存放大数十倍），
// 显示统一提示。悬浮按钮不受影响（按类型显示，规则不变）。
const oversize = computed(() => (debounced.value?.length ?? 0) > PREVIEW_MAX_BYTES);

/**
 * 渲染输出（异步）：从「点击进入预览」到出画面不再同步阻塞。
 *
 * 原实现用 computed 同步渲染，点击那一刻就在主线程跑完
 * marked.parse + DOMPurify + 相对资源重写 + v-html 全量挂载，
 * 0.5MB Markdown 实测 115~138ms 长任务——点击到画面出现是「卡住再跳」。
 *
 * 现改为：先渲染空（显示「渲染中」占位），下一帧再真正解析。
 * 于是点击瞬间就切到预览（0ms 反馈），重活在背后一帧完成，
 * 用户看到的是「立即切换 + 短暂加载」而不是「点了没反应」。
 * renderSeq 防止快速来回切换时旧渲染覆盖新结果。
 */
const rendered = ref('');
const rendering = ref(false);
let renderSeq = 0;
let renderTimer: number | undefined;

function renderNow() {
  renderTimer = undefined;
  const seq = ++renderSeq;
  if (oversize.value) { rendered.value = ''; rendering.value = false; return; }
  const src = debounced.value ?? '';
  const kind = props.kind;
  const baseDir = props.baseDir;
  rendering.value = true;
  // 推到下一帧：让浏览器先把「预览外壳 + 渲染中」画出来，再做重活。
  renderTimer = window.setTimeout(() => {
    if (seq !== renderSeq) return;   // 已被更新的渲染取代
    const html = kind === 'markdown'
      ? DOMPurify.sanitize(marked.parse(src, { async: false, gfm: true, breaks: true }) as string)
      : DOMPurify.sanitize(src);
    rendered.value = rewriteResUrls(html, baseDir);
    rendering.value = false;
  }, 0);
}

// 内容/类型/基准目录变化都重新渲染（baseDir 影响相对资源重写结果）。
watch(
  () => [debounced.value, props.kind, props.baseDir, oversize.value] as const,
  () => { window.clearTimeout(renderTimer); renderNow(); },
  { immediate: true },
);
</script>

<template>
  <!-- 超大内容：统一提示，不渲染（预览与编辑阈值分开：编辑 10MB / 预览 1MB）。 -->
  <div v-if="oversize" class="pv-doc pv-paused">{{ t('previewTooLarge') }}</div>
  <!-- 渲染中：点击进入预览后到解析完成之间的过渡态（异步渲染，不阻塞点击） -->
  <div v-else-if="rendering" class="pv-doc pv-busy">
    <span class="pv-spinner" aria-hidden="true" />
    <span>{{ t('loading') }}</span>
  </div>
  <div v-else class="pv-doc" :class="kind === 'markdown' ? 'pv-md' : 'pv-html'" v-html="rendered" @click="onPreviewClick" />
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
  /**
   * 滚动条是叠加式（不占布局宽度），会压在右侧 padding 上——
   * 实测 scrollHeight > clientHeight 时 offsetWidth === clientWidth，
   * 于是左留白 20px、右留白实际只剩约 10px，看起来不对称。
   * both-edges：左右都预留滚动条槽位，无论有无滚动条两侧始终等宽。
   * （stable 只预留右侧，仍需手补左边，故用 both-edges。）
   */
  scrollbar-gutter: stable both-edges;
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
/* 超大内容暂停提示 */
.pv-paused {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-muted);
  font-size: 13px;
}
/* 渲染中过渡态：与暂停提示同布局，附加一个转圈，表明正在解析而非卡死 */
.pv-busy {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--fg-muted);
  font-size: 13px;
}
.pv-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--fg-muted);
  border-top-color: transparent;
  animation: pv-spin 0.7s linear infinite;
}
@keyframes pv-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .pv-spinner { animation-duration: 2.2s; }
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
