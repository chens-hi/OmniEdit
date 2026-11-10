<script setup lang="ts">
import { useEditorStore } from '../store';

/**
 * 全局轻提示（toast）：非阻塞通知，自动消失，点击卡片可提前关闭。
 * 由 store.toast(message, type?) 驱动，App.vue 挂载一个全局实例。
 * 主题：容器走 --bg/--border/--fg/--fg-muted，类型色 --accent/--success/
 * --warning/--error（左缘色条区分类型，两主题各自取值自动适配）。
 * 位置：右下角悬浮于状态栏之上；TransitionGroup 处理进出场与堆栈位移。
 */
const store = useEditorStore();
</script>

<template>
  <Teleport to="body">
    <div class="toast-area">
      <TransitionGroup name="toast">
        <div
          v-for="item in store.toasts"
          :key="item.id"
          class="toast"
          :class="item.type"
          @click="store.dismissToast(item.id)"
        >
          <span class="toast-bar" />
          <span class="toast-msg">{{ item.message }}</span>
          <span class="toast-x">✕</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-area {
  position: fixed;
  right: 16px;
  bottom: 36px;               /* 悬浮在状态栏之上 */
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  z-index: 300;               /* 高于模态遮罩(200)：全局任何时刻可见 */
  pointer-events: none;       /* 容器不挡页面，卡片自身恢复事件 */
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 220px;
  max-width: 380px;
  padding: 10px 12px 10px 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  font-size: 12px;
  color: var(--fg);
  overflow: hidden;
}
.toast-bar { width: 3px; align-self: stretch; flex-shrink: 0; }
.toast.info .toast-bar { background: var(--accent); }
.toast.success .toast-bar { background: var(--success); }
.toast.warning .toast-bar { background: var(--warning); }
.toast.error .toast-bar { background: var(--error); }
.toast-msg { flex: 1; line-height: 1.5; word-break: break-all; }
.toast-x { color: var(--fg-muted); font-size: 11px; flex-shrink: 0; }
.toast:hover { border-color: var(--fg-muted); }

/* 进出场：右侧滑入淡入 / 滑出淡出；move 让堆栈在关闭时平滑上移。 */
.toast-enter-from { opacity: 0; transform: translateX(16px); }
.toast-enter-active, .toast-leave-active, .toast-move { transition: all 0.18s ease; }
.toast-leave-to { opacity: 0; transform: translateX(16px); }
.toast-leave-active { position: absolute; right: 0; } /* 离场不占位，堆栈立即上移 */
</style>
