<script setup lang="ts">
import { ref, computed } from 'vue';
import { search, type SearchHit } from '../api';
import { useEditorStore } from '../store';
import { t } from '../i18n';

const store = useEditorStore();
const keyword = ref('');
const searching = ref(false);
const error = ref('');
const hits = ref<SearchHit[]>([]);
const stats = ref<{ filesSearched: number; truncated: boolean } | null>(null);
const searched = ref(false);

// 搜索起点：优先活动文件所在目录，否则用第一个授权根目录。
const searchRoot = computed(() => {
  const active = store.activePath;
  if (active) {
    const parts = active.replace(/\\/g, '/').split('/');
    parts.pop();
    return parts.join('/') || active;
  }
  return store.authorizedRoots[0] ?? '';
});

async function doSearch() {
  const q = keyword.value.trim();
  if (!q || !searchRoot.value) return;
  searching.value = true;
  error.value = '';
  try {
    const { result } = await search(searchRoot.value, q);
    hits.value = result.hits;
    stats.value = { filesSearched: result.filesSearched, truncated: result.truncated };
    searched.value = true;
  } catch (e) {
    error.value = (e as Error).message;
    hits.value = [];
  } finally {
    searching.value = false;
  }
}

async function openHit(hit: SearchHit) {
  await store.openFile(hit.path);
  // 打开后跳转到对应行（通过 store 传递行号给编辑器）。
  store.pendingLine = hit.line;
}
</script>

<template>
  <div class="search-panel">
    <div class="search-box">
      <input
        v-model="keyword"
        class="search-input"
        type="text"
        :placeholder="t('searchPlaceholder')"
        @keyup.enter="doSearch"
      />
      <button class="btn" :disabled="searching || !keyword.trim()" @click="doSearch">
        {{ searching ? t('searching') : t('searchButton') }}
      </button>
    </div>

    <div v-if="error" class="search-error">{{ error }}</div>

    <div v-if="stats" class="search-stats">
      {{ hits.length }} {{ t('searchResults') }} {{ stats.filesSearched }} {{ t('filesUnit') }}
      <span v-if="stats.truncated" class="truncated">{{ t('truncated') }}</span>
      <div class="search-root">{{ t('scope') }}: {{ searchRoot }}</div>
    </div>

    <div class="search-results">
      <div
        v-for="(hit, i) in hits"
        :key="i"
        class="hit"
        @click="openHit(hit)"
      >
        <div class="hit-path">{{ hit.path.split(/[\\/]/).pop() }} : {{ hit.line }}</div>
        <div class="hit-text">{{ hit.text.trim() }}</div>
      </div>
      <div v-if="searched && hits.length === 0 && !error" class="search-empty">{{ t('noMatch') }}</div>
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px;
}

.search-box {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
}

.search-input:focus {
  outline: none;
  border-color: var(--accent);
}

.search-error {
  margin-top: 6px;
  color: var(--error);
  font-size: 12px;
}

.search-stats {
  margin-top: 8px;
  font-size: 11px;
  color: #888;
  flex-shrink: 0;
}

.search-root {
  margin-top: 2px;
  color: #666;
  word-break: break-all;
}

.truncated { color: #e2c08d; }

.search-results {
  margin-top: 6px;
  overflow-y: auto;
  flex: 1;
}

.hit {
  padding: 5px 6px;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 2px;
}

.hit:hover { background: rgba(255, 255, 255, 0.06); }

.hit-path {
  font-size: 11px;
  color: var(--accent);
  font-family: Consolas, monospace;
}

.hit-text {
  font-size: 12px;
  color: var(--fg);
  font-family: Consolas, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-empty {
  color: #666;
  font-size: 12px;
  padding: 8px;
}
</style>
