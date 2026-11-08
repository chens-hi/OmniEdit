<script setup lang="ts">
import { ref } from 'vue';
import { listDir, type DirEntry } from '../api';

const props = defineProps<{ root: string; label?: string }>();

const expanded = ref(false);
const loading = ref(false);
const children = ref<DirEntry[]>([]);
const loaded = ref(false);

const emit = defineEmits<{ (e: 'open-file', path: string): void }>();

async function toggle() {
  expanded.value = !expanded.value;
  if (expanded.value && !loaded.value) {
    await loadChildren();
  }
}

async function loadChildren() {
  loading.value = true;
  try {
    const res = await listDir(props.root);
    // 目录在前、文件在后，各自按名称排序。
    children.value = sortEntries(res.entries);
    loaded.value = true;
  } catch {
    children.value = [];
    loaded.value = true;
  } finally {
    loading.value = false;
  }
}

function onEntryClick(entry: DirEntry) {
  if (entry.isDir) return; // 子目录展开由递归组件自身处理
  emit('open-file', entry.path);
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
</script>

<template>
  <div class="tree-node">
    <div class="tree-row" @click="toggle">
      <span class="caret" :class="{ open: expanded }">{{ expanded ? '▾' : '▸' }}</span>
      <span class="icon">📁</span>
      <span class="name">{{ label ?? root.split(/[\\/]/).filter(Boolean).pop() }}</span>
    </div>
    <div v-if="expanded" class="children">
      <div v-if="loading" class="tree-loading">加载中…</div>
      <template v-else>
        <div v-for="entry in children.filter(e => e.isDir)" :key="entry.path" class="child">
          <DirTree :root="entry.path" :label="entry.name" @open-file="emit('open-file', $event)" />
        </div>
        <div
          v-for="entry in children.filter(e => !e.isDir)"
          :key="entry.path"
          class="tree-row file"
          @click="onEntryClick(entry)"
        >
          <span class="caret spacer" />
          <span class="icon">📄</span>
          <span class="name">{{ entry.name }}</span>
        </div>
        <div v-if="children.length === 0" class="tree-empty">（空目录）</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tree-node { user-select: none; }
.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  cursor: pointer;
  border-radius: 4px;
  white-space: nowrap;
}
.tree-row:hover { background: rgba(255, 255, 255, 0.06); }
.tree-row.file .name { color: var(--fg); }
.caret { width: 12px; display: inline-block; color: #888; font-size: 10px; }
.caret.spacer { visibility: hidden; }
.caret.open { transform: none; }
.icon { font-size: 13px; }
.name { overflow: hidden; text-overflow: ellipsis; }
.children { margin-left: 14px; }
.tree-loading, .tree-empty { color: #666; padding: 3px 6px; font-size: 12px; }
</style>
