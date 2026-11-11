<script setup lang="ts">
import { computed } from 'vue';
import { useEditorStore } from '../store';
import { t } from '../i18n';
import AppModal from './AppModal.vue';

/**
 * 批量关闭确认模态（关闭多个标签 / 单个脏标签复用）。
 * 由 store.batchClose 驱动：App.vue 渲染一个全局实例。
 *
 * 分两组列出未保存项，应对很多条：
 *   - toSave：有路径的脏文件（可「保存全部并关闭」覆盖）
 *   - toDiscard：非空草稿（「不保存关闭」将丢弃，明示后果）
 * 列表区 max-height + 滚动，几十条也不撑破模态；条目多时靠摘要计数感知规模。
 *
 * 三按钮：保存全部并关闭(主) / 不保存关闭(危险) / 取消。
 * 全部是草稿（无可保存项）时隐藏「保存全部并关闭」。
 */
const store = useEditorStore();
const bc = computed(() => store.batchClose);
const hasSave = computed(() => bc.value.toSave.length > 0);
const hasDiscard = computed(() => bc.value.toDiscard.length > 0);

function settle(choice: 'save' | 'discard' | 'cancel') {
  void store.settleBatchClose(choice);
}
</script>

<template>
  <AppModal :title="t('batchCloseTitle')" :width="440" @close="settle('cancel')">
    <div class="bcm-body">
      <div v-if="hasSave" class="bcm-group">
        <div class="bcm-group-title">
          {{ t('batchCloseModified') }}<span class="bcm-count">{{ bc.toSave.length }}</span>
        </div>
        <ul class="bcm-list">
          <li v-for="f in bc.toSave" :key="f.id" class="bcm-row">
            <span class="bcm-dot">●</span><span class="bcm-name">{{ f.name }}</span>
          </li>
        </ul>
      </div>

      <div v-if="hasDiscard" class="bcm-group">
        <div class="bcm-group-title bcm-group-title--warn">
          {{ t('batchCloseDrafts') }}<span class="bcm-count">{{ bc.toDiscard.length }}</span>
        </div>
        <ul class="bcm-list">
          <li v-for="f in bc.toDiscard" :key="f.id" class="bcm-row">
            <span class="bcm-name">{{ f.name }}</span>
          </li>
        </ul>
      </div>
    </div>
    <template #footer>
      <button class="cd-btn ghost" @click="settle('cancel')">{{ t('cancel') }}</button>
      <button class="cd-btn danger-ghost" @click="settle('discard')">{{ t('batchCloseDiscard') }}</button>
      <button v-if="hasSave" class="cd-btn primary" @click="settle('save')">{{ t('batchCloseSaveAll') }}</button>
    </template>
  </AppModal>
</template>

<style scoped>
.bcm-body {
  /* 列表很多条时：整个内容区限高滚动，模态本身不被撑高破屏 */
  max-height: 46vh;
  overflow-y: auto;
  scrollbar-width: thin;
}
.bcm-group + .bcm-group { margin-top: 14px; }
.bcm-group-title {
  font-size: 12px;
  color: var(--fg-muted);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bcm-group-title--warn { color: var(--warning); }
.bcm-count {
  min-width: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--fg) 10%, transparent);
  font-size: 11px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.bcm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.bcm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--fg);
  border-bottom: 1px solid var(--border);
}
.bcm-row:last-child { border-bottom: none; }
.bcm-dot { color: var(--warning); font-size: 10px; flex-shrink: 0; }
.bcm-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 按钮风格（与 ConfirmDialog 的 .cd-btn 一致；scoped 不共享，故此处自包含） */
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
.cd-btn.danger-ghost {
  border-color: color-mix(in srgb, var(--error) 55%, transparent);
  color: var(--error);
}
.cd-btn.danger-ghost:hover {
  background: color-mix(in srgb, var(--error) 12%, transparent);
  border-color: var(--error);
}
</style>
