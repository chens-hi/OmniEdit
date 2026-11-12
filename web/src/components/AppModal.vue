<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from '../i18n';

/**
 * 统一模态基座（遮罩 + 卡片 + 标题栏 + 关闭按钮 + 插槽）。
 *
 * 全应用所有模态（另存为/确认/关于/快捷键…）都基于它，保证外观一致。
 * 通过 <Teleport to="body"> 挂到 body，避免父容器 overflow/z-index 裁切。
 *
 * 交互：点遮罩空白**不关闭**，改为卡片抖动闪烁提示（引导用关闭按钮/Esc）。
 *
 * 插槽：
 *   - default：主体内容
 *   - footer：底部按钮区（不传则不渲染 footer 条）
 * Props：
 *   - title：标题
 *   - width：卡片宽度（px），默认 480
 *   - dismissable：Esc 是否关闭，默认 true（点遮罩一律不关闭，只闪烁）
 * Emits：close
 */

const props = withDefaults(defineProps<{
  title?: string;
  width?: number;
  dismissable?: boolean;
}>(), { width: 480, dismissable: true });

const emit = defineEmits<{ (e: 'close'): void }>();

/** 点遮罩闪烁反馈状态（true 时卡片抖动，动画结束复位以便重复触发）。 */
const shaking = ref(false);
let shakeTimer: number | undefined;

function onMaskClick() {
  // 点空白不关闭，抖动闪烁提示「这里关不掉，请用关闭按钮/Esc」。
  shaking.value = false;
  // 下一帧再置 true，确保连续点击也能重新触发动画（class 先摘再挂）。
  requestAnimationFrame(() => { shaking.value = true; });
  window.clearTimeout(shakeTimer);
  shakeTimer = window.setTimeout(() => { shaking.value = false; }, 340);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.dismissable) {
    e.preventDefault();
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  window.clearTimeout(shakeTimer);
});
</script>

<template>
  <Teleport to="body">
    <div class="am-mask" @click.self="onMaskClick">
      <!-- 入场动画交给 <Transition>（只在挂载时播一次）；抖动用纯 CSS transform 独立。
           两者彻底解耦：JS 摘掉 .shaking 时不会让入场动画重播（避免渐出闪烁）。 -->
      <Transition name="am" appear>
        <div class="am-card" :class="{ shaking }" role="dialog" aria-modal="true" :style="{ width: `${width}px` }">
          <header class="am-head">
            <span class="am-title">{{ title }}</span>
            <button class="am-x" :title="t('close')" @click="emit('close')">✕</button>
          </header>
          <div class="am-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="am-foot">
            <slot name="footer" />
          </footer>
        </div>
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped>
.am-mask {
  position: fixed;
  inset: 0;
  /* 半透明底 + 高斯模糊遮罩：背后内容按高斯分布虚化（Chromium/Safari/FF 均支持） */
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(8px) saturate(120%);
  -webkit-backdrop-filter: blur(8px) saturate(120%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.am-card {
  max-width: calc(100vw - 40px);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}
/* 入场动画由 <Transition name="am"> 接管（见模板），不再放 .am-card 上——
   否则抖动 .shaking 摘掉后 animation 变回 am-in 会被浏览器当新动画重播（渐出闪烁）。 */
.am-enter-from { opacity: 0; transform: translateY(-6px) scale(0.98); }
.am-enter-active { transition: opacity 0.14s ease-out, transform 0.14s ease-out; }
.am-enter-to { opacity: 1; transform: none; }
/* 点遮罩空白：卡片抖动闪烁，提示此处不可关闭（配合遮罩高斯模糊更明显）。
   纯 transform + animation，与入场 Transition 解耦，摘掉 .shaking 不会重播入场。 */
.am-card.shaking {
  animation: am-shake 0.32s cubic-bezier(0.36, 0.07, 0.19, 0.97);
}
@keyframes am-shake {
  0%, 100% { transform: translateX(0); }
  12% { transform: translateX(-9px); }
  28% { transform: translateX(7px); }
  44% { transform: translateX(-5px); }
  60% { transform: translateX(4px); }
  78% { transform: translateX(-2px); }
}
.am-head {
  display: flex;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.am-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  flex: 1;
}
.am-x {
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
}
.am-x:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 10%, transparent); }
.am-body { padding: 16px 18px; }
.am-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--fg) 3%, transparent);
}
</style>

