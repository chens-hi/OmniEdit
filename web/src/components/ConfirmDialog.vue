<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { t } from '../i18n';
import AppModal from './AppModal.vue';

/**
 * 确认对话框（替代 window.confirm，统一外观）。
 * 由 store.confirmDialog 驱动：App.vue 渲染一个全局实例，
 * 任意处 store.confirm(msg) 返回 Promise<boolean>。
 */
defineProps<{
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮用强调红/主题色（还原初始状态等）。 */
  danger?: boolean;
}>();

const emit = defineEmits<{
  (e: 'result', ok: boolean): void;
}>();

const confirmBtn = ref<HTMLButtonElement | null>(null);

function settle(ok: boolean) {
  emit('result', ok);
}

onMounted(async () => {
  await nextTick();
  confirmBtn.value?.focus();
});
</script>

<template>
  <AppModal :title="title || t('confirmTitle')" :width="420" @close="settle(false)">
    <div class="cd-msg">{{ message }}</div>
    <template #footer>
      <button class="cd-btn ghost" @click="settle(false)">{{ cancelText || t('cancel') }}</button>
      <button
        ref="confirmBtn"
        class="cd-btn primary"
        :class="{ danger }"
        @click="settle(true)"
      >{{ confirmText || t('confirmOk') }}</button>
    </template>
  </AppModal>
</template>

<style scoped>
.cd-msg {
  font-size: 13px;
  line-height: 1.7;
  color: var(--fg);
  white-space: pre-line;
}
.cd-btn {
  padding: 7px 18px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg);
}
.cd-btn.ghost:hover { border-color: var(--accent); color: var(--accent); }
.cd-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.cd-btn.primary:hover { filter: brightness(1.1); }
.cd-btn.primary.danger {
  background: var(--error);
  border-color: var(--error);
}
</style>
