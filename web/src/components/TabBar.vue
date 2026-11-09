<script setup lang="ts">
import { useEditorStore } from '../store';
import { t } from '../i18n';

const store = useEditorStore();
</script>

<template>
  <div class="tabbar">
    <div
      v-for="tab in store.tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === store.activeId }"
      @click="store.activeId = tab.id"
    >
      <span class="tab-name">{{ tab.name }}</span>
      <span v-if="tab.dirty" class="tab-dirty" :title="t('unsaved')">●</span>
      <span class="tab-close" :title="t('close')" @click.stop="store.closeTab(tab.id)">×</span>
    </div>
    <button class="tab-new" :title="t('newFile')" @click="store.newUntitled()">＋</button>
  </div>
</template>

<style scoped>
.tabbar {
  display: flex;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  flex-shrink: 0;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-right: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  font-size: 12px;
  color: #aaa;
}
.tab.active {
  background: var(--bg);
  color: var(--fg);
  border-top: 2px solid var(--accent);
}
.tab-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
.tab-dirty { color: #e2c08d; }
.tab-close {
  border-radius: 3px;
  padding: 0 4px;
  color: #888;
}
.tab-close:hover { background: rgba(255, 255, 255, 0.1); color: var(--fg); }
.tab-new {
  border: none;
  background: transparent;
  color: #aaa;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 13px;
}
.tab-new:hover { color: var(--fg); }
</style>
