<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useEditorStore } from '../store';
import { t } from '../i18n';
import ContextMenu from './ContextMenu.vue';

/**
 * 标签栏多标签策略（VS Code 风）：
 *   - 标签按比例收缩塞满容器（不低于 min-width 不出现滚动）；
 *   - 超出下限后横向滚动：原生滚动条隐藏，滚轮横滚 + 边缘渐变提示；
 *   - 渐隐用「不随内容滚动的叠加渐变层」而非 mask-image——滚动容器上的 mask
 *     在 Chromium 每帧强制重绘（NAS 弱 GPU 明显卡顿），叠加层纯合成零重绘；
 *   - 切换标签时活动页自动滚入可视区；「＋」固定右端不随滚动；
 *   - 右键标签：先激活该标签，再弹自定义上下文菜单（关闭/关闭右侧所有）。
 */

const store = useEditorStore();

const tabsEl = ref<HTMLElement | null>(null);
/** 溢出状态：驱动左右边缘渐变层显隐（未溢出时不遮挡首尾标签）。 */
const fadeLeft = ref(false);
const fadeRight = ref(false);

// ---- 页签右键菜单 ----
const ctxMenu = ref<{ x: number; y: number; tabId: number } | null>(null);

/** 右键即激活该标签（VS Code 同行为），再在光标处弹菜单。 */
function onTabContextmenu(e: MouseEvent, id: number) {
  e.preventDefault();
  store.activeId = id;
  ctxMenu.value = { x: e.clientX, y: e.clientY, tabId: id };
}

// 触摸设备的长按菜单与拖动排序统一由下方「触摸手势」块处理（Pointer 手势）。

/** 右键菜单项：关闭 ▸（当前/右侧/左侧/其他/所有）。保存/另存为已回到文件菜单。 */
const ctxItems = computed(() => {
  const id = ctxMenu.value?.tabId;
  const idx = id != null ? store.tabs.findIndex(tb => tb.id === id) : -1;
  const idsOf = (list: { id: number }[]) => list.map(t => t.id);
  return [
    {
      label: t('close'),
      children: [
        { label: t('closeCurrent'), action: () => { if (id != null) void store.requestCloseMany([id]); } },
        {
          label: t('closeRight'),
          disabled: idx < 0 || idx >= store.tabs.length - 1,
          action: () => { if (idx >= 0) void store.requestCloseMany(idsOf(store.tabs.slice(idx + 1))); },
        },
        {
          label: t('closeLeft'),
          disabled: idx <= 0,
          action: () => { if (idx >= 0) void store.requestCloseMany(idsOf(store.tabs.slice(0, idx))); },
        },
        {
          label: t('closeOthers'),
          disabled: store.tabs.length <= 1,
          action: () => { if (id != null) void store.requestCloseMany(idsOf(store.tabs.filter(t => t.id !== id))); },
        },
        {
          label: t('closeAllTabs'),
          disabled: store.tabs.length === 0,
          action: () => { void store.requestCloseMany(idsOf(store.tabs)); },
        },
      ],
    },
  ];
});

// ---- 拖动排序：桌面与触摸共用一套 Pointer 手势（见下方「指针手势」块）----
// 桌面旧实现是 HTML5 DnD，但触摸屏不触发 DnD 事件、得另写一套；现统一为 Pointer：
// 鼠标移动即拖、触摸长按后移动才拖，拖动机制（指示线/落位/边缘横滚）完全一份。
const draggingId = ref<number | null>(null);
/** 放置指示：目标标签 + 插入侧（指针在目标左半=插其前，右半=插其后）。 */
const dragOver = ref<{ id: number; side: 'before' | 'after' } | null>(null);

/** 调整标签顺序（store.tabs 直接 splice，响应式）并持久化会话（顺序进 session.tabs）。 */
function moveTab(fromId: number, toId: number, side: 'before' | 'after') {
  if (fromId === toId) return;
  const arr = store.tabs;
  const from = arr.findIndex(t => t.id === fromId);
  const to = arr.findIndex(t => t.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = arr.splice(from, 1);
  // 移除后目标索引偏移：向右拖 to-1/to，向左拖 to/to+1（分侧）。
  const insertAt = from < to ? (side === 'before' ? to - 1 : to) : (side === 'before' ? to : to + 1);
  arr.splice(insertAt, 0, moved);
  store.persistSession();
}

// ---- 指针手势：一套代码同时驱动桌面（鼠标）与触摸 ----
// 拖动排序：鼠标「移动即拖」；触摸「长按到点后再移动才拖」（避免与横滑滚动冲突）。
// 长按只用于拖动（抓起页签），不再弹菜单——避免拖动与长按菜单争抢同一手势。
// 上下文菜单仅在桌面走原生右键（onTabContextmenu）；触摸端关闭走每页签的 ×。
// 拖动机制（指示线/落位/边缘横滚）与 moveTab 完全共用，仅开始门槛按设备区分。
const LONG_PRESS_MS = 420;   // 触摸到点进入 armed（可拖）
const SCROLL_CANCEL_PX = 10; // 触摸未 armed 时超过即判为横滑滚动
const DRAG_START_PX = 6;     // armed 后超过即开始拖动

let pressTimer: number | null = null;
let pressPointerId: number | null = null;
let pressTabId: number | null = null;
let pressStart = { x: 0, y: 0 };
let pressIsMouse = false;
let armed = false;          // 可拖状态（鼠标按下即为 true；触摸长按到点后为 true）
let pointerDragging = false; // 已进入拖动（鼠标/触摸共用）
let suppressClickUntil = 0;  // 拖动落位后短暂吞 click，避免补发的 click 误切活动页签

/** 页签单击激活（拖动落位后 180ms 内的补发 click 被忽略）。 */
function onTabClick(id: number) {
  if (performance.now() < suppressClickUntil) return;
  store.activeId = id;
}

function addPressListeners() {
  window.addEventListener('pointermove', onPressMove, { passive: false });
  window.addEventListener('pointerup', onPressUp);
  window.addEventListener('pointercancel', onPressCancel);
  // armed 期间阻断原生触摸滚动（拖动与横滑共享横向手势），靠 armed 门控放行平时滚动。
  window.addEventListener('touchmove', onTouchMoveBlock, { passive: false });
}
function removePressListeners() {
  window.removeEventListener('pointermove', onPressMove);
  window.removeEventListener('pointerup', onPressUp);
  window.removeEventListener('pointercancel', onPressCancel);
  window.removeEventListener('touchmove', onTouchMoveBlock);
}

function onTabPointerDown(e: PointerEvent, id: number) {
  cancelPress();
  pressPointerId = e.pointerId;
  pressTabId = id;
  pressStart = { x: e.clientX, y: e.clientY };
  pressIsMouse = e.pointerType === 'mouse';
  pointerDragging = false;
  addPressListeners();
  if (pressIsMouse) {
    // 鼠标：按下即可拖（移动即拖），菜单走原生右键。
    armed = true;
  } else {
    // 触摸/笔：等长按到点才可拖；未到点先给横滑滚动的机会。
    armed = false;
    pressTimer = window.setTimeout(onLongPressArmed, LONG_PRESS_MS);
  }
}

function onLongPressArmed() {
  pressTimer = null;
  if (pressPointerId === null) return;
  armed = true; // 已抓起，移动即拖动（此处不震动，震动留给真正拖动启动与交换完成）
}

/** 触觉反馈（触摸设备震动；桌面无振动器时为 no-op）。 */
function haptic(ms: number) {
  navigator.vibrate?.(ms);
}

function onTouchMoveBlock(e: TouchEvent) {
  if (armed || pointerDragging) e.preventDefault(); // 仅 armed/拖动时阻断原生滚动
}

function onPressMove(e: PointerEvent) {
  if (e.pointerId !== pressPointerId) return;
  const dx = e.clientX - pressStart.x;
  const dy = e.clientY - pressStart.y;
  if (!armed) {
    // 仅触摸未到点会走到这里：超过阈值即视为横滑滚动，取消手势。
    if (Math.hypot(dx, dy) > SCROLL_CANCEL_PX) cancelPress();
    return;
  }
  if (!pointerDragging) {
    if (Math.hypot(dx, dy) < DRAG_START_PX) return;
    pointerDragging = true;
    draggingId.value = pressTabId; // 拖动高亮（桌面/触摸共用样式）
    if (!pressIsMouse) haptic(18); // 触摸：真正触发拖动，震动确认已抓起
  }
  if (!pressIsMouse) e.preventDefault(); // 触摸拖动时阻断原生滚动
  updateDragAt(e.clientX, e.clientY);
}

function onPressUp(e: PointerEvent) {
  if (e.pointerId !== pressPointerId) return;
  finishPress();
}

function onPressCancel(e: PointerEvent) {
  if (e.pointerId !== pressPointerId) return;
  abortDrag();
  cancelPress();
}

/** 手势结束（抬指/取消）：拖动则落位排序，否则无操作（长按只服务拖动）。 */
function finishPress() {
  const wasDragging = pointerDragging;
  const isMouse = pressIsMouse;
  const id = pressTabId;
  if (wasDragging) {
    suppressClickUntil = performance.now() + 180; // 落位后吞掉补发的 click，避免误切活动页签
    const over = dragOver.value;
    if (id != null && over && over.id !== id) {
      moveTab(id, over.id, over.side);
      if (!isMouse) haptic(24); // 触摸：交换完成反馈
    }
  }
  abortDrag();
  cancelPress();
}

function abortDrag() {
  pointerDragging = false;
  armed = false;
  draggingId.value = null;
  dragOver.value = null;
}

function cancelPress() {
  if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
  pressPointerId = null;
  pressTabId = null;
  pressIsMouse = false;
  armed = false;
  pointerDragging = false;
  removePressListeners();
}

/** 拖动中：按指针位置算放置指示（拖动本体 pointer-events:none，见样式，可命中下层页签）。 */
function updateDragAt(x: number, y: number) {
  if (pressTabId == null) return;
  const el = tabsEl.value;
  if (!el) return;
  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  const tabEl = hit?.closest('.tab') as HTMLElement | null;
  const hitId = tabEl?.dataset.tabId ? Number(tabEl.dataset.tabId) : null;
  if (hitId !== null && hitId !== pressTabId) {
    const rect = tabEl!.getBoundingClientRect();
    dragOver.value = { id: hitId, side: x < rect.left + rect.width / 2 ? 'before' : 'after' };
  } else if (hitId === null) {
    // 落在页签条区域但不在任何页签上（末尾间隙/＋附近）→ 放到最右
    const rect = el.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const last = store.tabs[store.tabs.length - 1];
      if (last && last.id !== pressTabId) dragOver.value = { id: last.id, side: 'after' };
    } else {
      dragOver.value = null;
    }
  }
  // 接近左右边缘时自动横滚，便于页签多时拖到屏外
  const rect = el.getBoundingClientRect();
  const edge = 40;
  if (x < rect.left + edge) el.scrollLeft -= 14;
  else if (x > rect.right - edge) el.scrollLeft += 14;
}

/**
 * 竖滚轮转横滚（事件挂在 .tabbar，悬浮在「＋」上也能滚）。
 * 平滑化：滚轮事件只累加目标位置，rAF 指数逼近——离散的 100px/格 跳变
 * 变成连续滑动（瞬时赋值在快速连滚时表现为抖动/跳跃感）。
 * 只在真正处理时 preventDefault（未溢出放行，不吞事件）；
 * deltaMode 归一化：Firefox 行/页模式换算成像素。
 */

/** 平滑滚动状态：目标位置 + rAF 句柄。 */
let scrollTarget = 0;
let rafId = 0;

function updateFade() {
  const el = tabsEl.value;
  if (!el) return;
  fadeLeft.value = el.scrollLeft > 2;
  fadeRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
}

function stopSmooth() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function startSmooth() {
  if (rafId) return; // 动画已在跑：新事件只改 target，循环下一帧自然接管
  const step = () => {
    const el = tabsEl.value;
    if (!el) { rafId = 0; return; }
    const diff = scrollTarget - el.scrollLeft;
    if (Math.abs(diff) < 1) {
      el.scrollLeft = scrollTarget;
      rafId = 0;
      return;
    }
    el.scrollLeft += diff * 0.28; // 指数逼近：每帧吃掉剩余距离的 28%
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function onWheel(e: WheelEvent) {
  const el = tabsEl.value;
  if (!el) return;
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0) return; // 未溢出：放行，不吞事件
  let delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!delta) return;
  e.preventDefault();
  if (e.deltaMode === 1) delta *= 33;                   // 行
  else if (e.deltaMode === 2) delta *= el.clientHeight; // 页
  if (!rafId) scrollTarget = el.scrollLeft;             // 新一轮滚动从当前位置起
  scrollTarget = Math.min(max, Math.max(0, scrollTarget + delta));
  startSmooth();
}

let ro: ResizeObserver | undefined;
onMounted(() => {
  ro = new ResizeObserver(updateFade);
  if (tabsEl.value) ro.observe(tabsEl.value);
  updateFade();
});
onBeforeUnmount(() => {
  ro?.disconnect();
  stopSmooth();
  cancelPress();
});

// 活动标签变化 / 开关标签后：把活动页滚入可视区 + 刷新边缘渐变。
// 先取消进行中的平滑动画再定位，避免动画与自动定位互相拉扯（抖动的另一来源）。
// 手动改 scrollLeft 而非 scrollIntoView，避免波及任何祖先容器的滚动。
watch(() => [store.activeId, store.tabs.length], async () => {
  await nextTick();
  updateFade();
  const c = tabsEl.value;
  const el = c?.querySelector('.tab.active') as HTMLElement | null;
  if (!c || !el) return;
  const l = el.offsetLeft;
  const r = l + el.offsetWidth;
  let target = c.scrollLeft;
  if (l < target) target = l;
  else if (r > target + c.clientWidth) target = r - c.clientWidth;
  if (target !== c.scrollLeft) {
    stopSmooth();
    scrollTarget = target;
    c.scrollLeft = target; // 切换标签要即时响应，不做动画
  }
  updateFade();
});
</script>

<template>
  <div class="tabbar" @wheel="onWheel">
    <div class="tabs-wrap">
      <div
        ref="tabsEl"
        class="tabs"
        :class="{ 'is-dragging': draggingId !== null }"
        @scroll="updateFade"
      >
        <div
          v-for="tab in store.tabs"
          :key="tab.id"
          class="tab"
          :data-tab-id="tab.id"
          :class="{
            active: tab.id === store.activeId,
            dragging: draggingId === tab.id,
            'drag-before': dragOver?.id === tab.id && dragOver.side === 'before',
            'drag-after': dragOver?.id === tab.id && dragOver.side === 'after',
          }"
          :title="tab.path || tab.name"
          @click="onTabClick(tab.id)"
          @pointerdown="onTabPointerDown($event, tab.id)"
          @contextmenu.prevent="onTabContextmenu($event, tab.id)"
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
    <ContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxItems"
      @close="ctxMenu = null"
    />
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
  position: relative;    /* 插入指示线（::before/::after）的定位基准 */
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;      /* 允许收缩：多标签按比例压缩塞满容器 */
  min-width: 56px;     /* 收缩下限；全部压到此宽度仍放不下才滚动 */
  max-width: 200px;
  padding: 6px 8px;
  border-right: 1px solid var(--border);
  cursor: pointer; /* 平时正常指针；握手光标只在拖动中显示（.tabs.is-dragging） */
  white-space: nowrap;
  font-size: 12px;
  color: var(--fg-muted);
  overflow: hidden;
  /* 触摸长按呼出菜单：禁文本选择与 iOS 原生长按呼出，避免与自定义菜单打架 */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
/* 拖拽：本体半透明，落点侧亮 accent 指示线（左半区=线在左缘=插其前，反之在后）。
   pointer-events:none 让触摸拖动时 elementFromPoint 能穿透本体命中下层页签
   （HTML5 DnD 同样受益：拖动源不拦截 dragover）。 */
.tab.dragging { opacity: 0.45; pointer-events: none; }
/* 拖动中：整条页签栏与各页签显示握紧手光标（源页签 pointer-events:none，
   光标由其下目标页签或容器提供）。触摸端无光标，此规则仅影响键鼠。 */
.tabs.is-dragging,
.tabs.is-dragging .tab { cursor: grabbing; }
.tab.drag-before::before,
.tab.drag-after::after {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 2px;
  background: var(--accent);
  z-index: 2;
}
.tab.drag-before::before { left: 0; }
.tab.drag-after::after { right: 0; }
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
