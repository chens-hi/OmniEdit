<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 通用右键上下文菜单（页签右键等场景复用）。
 *
 * 设计：
 *   - Teleport to body + fixed 定位，坐标由调用方传入（通常 e.clientX/Y）；
 *   - 挂载后按实际尺寸做视口边缘钳位（靠近右/下边缘时收进来）；
 *   - 关闭时机：点击菜单外（mousedown）、Esc、点击菜单项（先 close 再执行动作）；
 *     右键别处不关闭——由调用方的 contextmenu 处理器重新定位（行为等同重开）。
 * 主题：容器/文字全走主题变量，danger 项用 --error，hover 用 color-mix 自适应。
 */
const props = defineProps<{
  x: number;
  y: number;
  items: { label: string; danger?: boolean; disabled?: boolean; action?: () => void }[];
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const menuEl = ref<HTMLElement | null>(null);
const style = ref<{ left: string; top: string }>({ left: `${props.x}px`, top: `${props.y}px` });

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
    <div ref="menuEl" class="ctx-menu" :style="style" role="menu">
      <button
        v-for="(item, i) in items"
        :key="i"
        class="ctx-item"
        :class="{ danger: item.danger, disabled: item.disabled }"
        :disabled="item.disabled"
        @click="run(item)"
      >
        {{ item.label }}
      </button>
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
.ctx-item {
  display: block;
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
.ctx-item.danger { color: var(--error); }
.ctx-item.disabled { opacity: 0.4; cursor: default; }

/* 窄屏 / 触摸设备：放大触摸目标（≥44px）、加宽容器并钳到屏内。
   触摸无 hover，保留 hover 规则对键鼠无害；触摸端点击即执行。 */
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
