<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 通用右键上下文菜单（页签右键等场景复用），支持一级子菜单。
 *
 * 设计：
 *   - Teleport to body + fixed 定位，坐标由调用方传入（通常 e.clientX/Y）；
 *   - 挂载后按实际尺寸做视口边缘钳位（靠近右/下边缘时收进来）；
 *   - 子菜单：带 children 的项 hover 展开（桌面），子面板贴父项右侧，
 *     靠近右边缘时翻转到左侧；子面板同样做纵向钳位；
 *   - 关闭时机：点击菜单外（mousedown）、Esc、点击菜单项（先 close 再执行动作）；
 *     右键别处不关闭——由调用方的 contextmenu 处理器重新定位（行为等同重开）。
 * 主题：容器/文字全走主题变量，danger 项用 --error，hover 用 color-mix 自适应。
 */
export interface CtxItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** 右侧显示的快捷键（如 Ctrl+C），仅展示不绑定。 */
  shortcut?: string;
  action?: () => void;
  /** 子菜单（一级）：hover 展开，子项点击即执行。 */
  children?: CtxItem[];
}

const props = defineProps<{ x: number; y: number; items: CtxItem[] }>();

const emit = defineEmits<{ (e: 'close'): void }>();

const menuEl = ref<HTMLElement | null>(null);
const style = ref<{ left: string; top: string }>({ left: `${props.x}px`, top: `${props.y}px` });
/** 当前展开子菜单的父项索引（桌面 hover 切换；-1 = 无）。 */
const openSub = ref(-1);
/** 子菜单是否向左翻转（父项靠近右边缘时）。 */
const subLeft = ref(false);

function onDocMouseDown(e: MouseEvent) {
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) emit('close');
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

function run(item: { disabled?: boolean; action?: () => void }) {
  if (item.disabled) return;
  emit('close');
  item.action?.();
}

/** hover 父项展开子菜单；展开后测量是否需向左翻转（避免右侧溢出）。 */
async function openSubmenu(i: number) {
  openSub.value = i;
  await nextTick();
  const parent = menuEl.value?.querySelectorAll('.ctx-has-sub')[i] as HTMLElement | undefined;
  const sub = parent?.querySelector('.ctx-submenu') as HTMLElement | undefined;
  if (!parent || !sub) return;
  const pr = parent.getBoundingClientRect();
  const sw = sub.offsetWidth;
  // 子面板右侧超出视口 → 翻到父项左侧
  subLeft.value = pr.right + sw > window.innerWidth - 8;
  // 子面板纵向钳位（顶端不低于 4，底端不超视口）
  const sh = sub.offsetHeight;
  const top = Math.max(4, Math.min(pr.top, window.innerHeight - sh - 8));
  sub.style.top = `${top - pr.top}px`;
}

function closeSubmenu() {
  openSub.value = -1;
}

onMounted(async () => {
  await nextTick();
  const el = menuEl.value;
  if (el) {
    const left = Math.max(4, Math.min(props.x, window.innerWidth - el.offsetWidth - 8));
    const top = Math.max(4, Math.min(props.y, window.innerHeight - el.offsetHeight - 8));
    style.value = { left: `${left}px`, top: `${top}px` };
  }
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <Teleport to="body">
    <div ref="menuEl" class="ctx-menu" :style="style" role="menu" @mouseleave="closeSubmenu">
      <div
        v-for="(item, i) in items"
        :key="i"
        class="ctx-entry"
        :class="{ 'ctx-has-sub': item.children }"
        @mouseenter="item.children ? openSubmenu(i) : closeSubmenu()"
      >
        <button
          v-if="!item.children"
          class="ctx-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          :disabled="item.disabled"
          @click="run(item)"
        >
          <span class="ctx-label">{{ item.label }}</span>
          <span v-if="item.shortcut" class="ctx-shortcut">{{ item.shortcut }}</span>
        </button>

        <template v-else>
          <button class="ctx-item" :class="{ disabled: item.disabled }" :disabled="item.disabled">
            <span class="ctx-label">{{ item.label }}</span>
            <span class="ctx-arrow">▸</span>
          </button>
          <div v-if="openSub === i" class="ctx-submenu" :class="{ left: subLeft }" role="menu">
            <button
              v-for="(c, j) in item.children"
              :key="j"
              class="ctx-item"
              :class="{ danger: c.danger, disabled: c.disabled }"
              :disabled="c.disabled"
              @click="run(c)"
            >{{ c.label }}</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 250;             /* 高于模态(200)，低于 toast(300) */
  min-width: 150px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  padding: 4px;
}
.ctx-entry { position: relative; }
.ctx-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  white-space: nowrap;
}
.ctx-item:hover:not(.disabled) {
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.ctx-label { flex: 1; }
.ctx-shortcut {
  color: var(--fg-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ctx-item.danger { color: var(--error); }
.ctx-item.disabled { opacity: 0.4; cursor: default; }
.ctx-arrow { color: var(--fg-muted); font-size: 11px; }

/* 一级子菜单：贴父项右侧展开，靠右边缘时翻到左侧（.left） */
.ctx-submenu {
  position: absolute;
  top: 0;
  left: calc(100% - 2px);
  min-width: 150px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  padding: 4px;
  z-index: 1;
}
.ctx-submenu.left { left: auto; right: calc(100% - 2px); }

/* 窄屏 / 触摸设备：放大触摸目标（≥44px）、加宽容器并钳到屏内。
   本应用页签右键仅桌面（右键）呼出，此段主要兜底键鼠窄窗口。 */
@media (max-width: 768px), (pointer: coarse) {
  .ctx-menu {
    min-width: 200px;
    max-width: calc(100vw - 16px);
    padding: 6px;
  }
  .ctx-item {
    min-height: 44px;
    padding: 10px 14px;
    font-size: 14px;
  }
}
</style>
