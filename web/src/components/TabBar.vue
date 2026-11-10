<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useEditorStore } from '../store';
import { t } from '../i18n';

/**
 * 标签栏多标签策略（VS Code 风）：
 *   - 标签按比例收缩塞满容器（不低于 min-width 不出现滚动）；
 *   - 超出下限后横向滚动：原生滚动条隐藏，滚轮横滚 + 边缘渐变提示；
 *   - 渐隐用「不随内容滚动的叠加渐变层」而非 mask-image——滚动容器上的 mask
 *     在 Chromium 每帧强制重绘（NAS 弱 GPU 明显卡顿），叠加层纯合成零重绘；
 *   - 切换标签时活动页自动滚入可视区；「＋」固定右端不随滚动。
 */

const store = useEditorStore();

const tabsEl = ref<HTMLElement | null>(null);
/** 溢出状态：驱动左右边缘渐变层显隐（未溢出时不遮挡首尾标签）。 */
const fadeLeft = ref(false);
const fadeRight = ref(false);

function updateFade() {
  const el = tabsEl.value;
  if (!el) return;
  fadeLeft.value = el.scrollLeft > 2;
  fadeRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}

/**
 * 竖滚轮转横滚。事件挂在 .tabbar（悬浮在「＋」上也能滚）。
 * 只在真正处理时 preventDefault（未溢出放行，不吞事件）；
 * deltaMode 归一化：Firefox 行/页模式换算成像素。
 */
function onWheel(e: WheelEvent) {
  const el = tabsEl.value;
  if (!el) return;
  if (el.scrollWidth <= el.clientWidth + 2) return; // 未溢出
  let delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!delta) return;
  e.preventDefault();
  if (e.deltaMode === 1) delta *= 33;        // 行
  else if (e.deltaMode === 2) delta *= el.clientHeight; // 页
  el.scrollLeft += delta;
}

let ro: ResizeObserver | undefined;
onMounted(() => {
  ro = new ResizeObserver(updateFade);
  if (tabsEl.value) ro.observe(tabsEl.value);
  updateFade();
});
onBeforeUnmount(() => ro?.disconnect());

// 活动标签变化 / 开关标签后：把活动页滚入可视区 + 刷新边缘渐变。
// 手动改 scrollLeft 而非 scrollIntoView，避免波及任何祖先容器的滚动。
watch(() => [store.activeId, store.tabs.length], async () => {
  await nextTick();
  updateFade();
  const c = tabsEl.value;
  const el = c?.querySelector('.tab.active') as HTMLElement | null;
  if (!c || !el) return;
  const l = el.offsetLeft;
  const r = l + el.offsetWidth;
  if (l < c.scrollLeft) c.scrollLeft = l;
  else if (r > c.scrollLeft + c.clientWidth) c.scrollLeft = r - c.clientWidth;
});
</script>

<template>
  <div class="tabbar" @wheel="onWheel">
    <div class="tabs-wrap">
      <div ref="tabsEl" class="tabs" @scroll="updateFade">
        <div
          v-for="tab in store.tabs"
          :key="tab.id"
          class="tab"
          :class="{ active: tab.id === store.activeId }"
          :title="tab.path || tab.name"
          @click="store.activeId = tab.id"
        >
          <span class="tab-name">{{ tab.name }}</span>
          <span v-if="tab.dirty" class="tab-dirty" :title="t('unsaved')">●</span>
          <span class="tab-close" :title="t('close')" @click.stop="store.closeTab(tab.id)">×</span>
        </div>
      </div>
      <!-- 边缘渐变：覆盖在滚动内容之上（不随内容滚动，纯合成层），pointer-events 穿透 -->
      <div v-show="fadeLeft" class="fade fade-l" />
      <div v-show="fadeRight" class="fade fade-r" />
    </div>
    <button class="tab-new" :title="t('newFile')" @click="store.newUntitled()">＋</button>
  </div>
</template>

<style scoped>
.tabbar {
  display: flex;
  align-items: stretch;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.tabs-wrap {
  position: relative;   /* 渐变层的定位基准 */
  display: flex;
  flex: 1;
  min-width: 0;
}

/* 可滚动区：标签按比例收缩（flex-shrink），min-width 下限内塞满不滚动；
   超限后横向滚动，原生滚动条隐藏（滚轮横滚 + 边缘渐变代替）。 */
.tabs {
  position: relative;   /* .tab offsetLeft 的定位基准（自动滚入可视区用） */
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }

.fade {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 24px;
  pointer-events: none; /* 不挡点击：渐变层下方的标签/关闭按钮仍可点 */
  z-index: 5;
}
.fade-l { left: 0; background: linear-gradient(to right, var(--toolbar-bg), transparent); }
.fade-r { right: 0; background: linear-gradient(to left, var(--toolbar-bg), transparent); }

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;      /* 允许收缩：多标签按比例压缩塞满容器 */
  min-width: 56px;     /* 收缩下限；全部压到此宽度仍放不下才滚动 */
  max-width: 200px;
  padding: 6px 8px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg-muted);
  overflow: hidden;
}
.tab:hover { background: rgba(0, 0, 0, 0.15); }
html[data-theme="light"] .tab:hover { background: rgba(0, 0, 0, 0.05); }
.tab.active {
  background: var(--bg);
  color: var(--fg);
  border-top: 2px solid var(--accent);
  padding-top: 4px;    /* 抵消 border-top 高度，避免文字跳动 */
}
.tab-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-dirty { flex-shrink: 0; color: #e2c08d; }
.tab-close {
  flex-shrink: 0;
  border-radius: 3px;
  padding: 0 4px;
  color: var(--fg-muted);
}
.tab-close:hover { background: color-mix(in srgb, var(--fg) 10%, transparent); color: var(--fg); }
.tab-new {
  flex-shrink: 0;
  border: none;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--fg-muted);
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
}
.tab-new:hover { color: var(--fg); }
</style>
