<script setup lang="ts">
import { onMounted, ref, watch, nextTick } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { languageExtensionFor, isMarkdown } from './language';
import { useEditorStore } from './store';
import { pathFromLocation } from './api';
import { initTheme, theme } from './theme';
import { initLang, t } from './i18n';
import { startFileWatch } from './fileWatch';
import DirTree from './components/DirTree.vue';
import TabBar from './components/TabBar.vue';
import MarkdownPreview from './components/MarkdownPreview.vue';
import SearchPanel from './components/SearchPanel.vue';

const store = useEditorStore();
const showSidebar = ref(true);
const showPreview = ref(false);
// 侧边栏当前页签：files（目录树）/ search（搜索）。
const sidebarTab = ref<'files' | 'search'>('files');

// CodeMirror 主题热切换单元格：宿主切深/浅色时重配。
const themeCompartment = new Compartment();
// CodeMirror 可编辑性单元格：只读预览（超大文件）时禁用编辑。
const editableCompartment = new Compartment();

// CodeMirror 实例与当前挂载的文件路径。
let view: EditorView | null = null;
let mountedPath = '';

/** 当前主题对应的 CodeMirror 主题扩展。暗色用 oneDark，浅色走 CSS 变量。 */
function cmThemeFor(t: 'dark' | 'light') {
  return t === 'dark' ? [oneDark] : [];
}

/** 把内容挂载/切换到 CodeMirror。 */
function mountEditor(path: string, content: string) {
  const host = document.getElementById('editor-host');
  if (!host) return;
  if (view) {
    view.destroy();
    view = null;
  }
  mountedPath = path;
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && mountedPath) {
      store.markDirty(mountedPath, u.state.doc.toString());
    }
  });
  view = new EditorView({
    parent: host,
    extensions: [
      basicSetup,
      ...languageExtensionFor(path),
      themeCompartment.of(cmThemeFor(theme.value)),
      editableCompartment.of(EditorView.editable.of(!store.tabByPath(path)?.readonly)),
      updateListener,
    ],
    doc: content,
  });
}

// 宿主主题变化时热切换 CodeMirror 配色。
watch(theme, (t) => {
  if (view) {
    view.dispatch({ effects: themeCompartment.reconfigure(cmThemeFor(t)) });
  }
});

/** 活动标签变化时，切换编辑器内容。 */
watch(
  () => store.activePath,
  async (path) => {
    if (!path) {
      if (view) { view.destroy(); view = null; mountedPath = ''; }
      return;
    }
    // 等待 DOM 更新（标签栏/编辑器容器可能刚出现）。
    await nextTick();
    const tab = store.activeTab;
    if (tab && path !== mountedPath) {
      mountEditor(path, tab.content);
    } else if (view) {
      // 已挂载的编辑器切到只读/可写标签时，同步可编辑性。
      view.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(!tab?.readonly)),
      });
    }
    showPreview.value = isMarkdown(path);
  },
);

// 编辑器内容被 store 更新（如外部变更重载）时同步到 CodeMirror。
// 用户输入不会走到这里（输入只改 doc，不改 store，除非 markDirty）。
watch(
  () => store.activeTab?.content,
  (content) => {
    const path = store.activePath;
    if (!view || path !== mountedPath || content === undefined) return;
    if (view.state.doc.toString() !== content) {
      // 外部变更重载：整体替换文档内容，保留滚动位置。
      const curScroll = view.scrollDOM.scrollTop;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
      view.scrollDOM.scrollTop = curScroll;
    }
  },
);

function onOpenFile(path: string) {
  void store.openFile(path);
}

// 搜索结果点击后跳转到指定行：滚动 + 临时高亮该行。
watch(
  () => store.pendingLine,
  async (line) => {
    if (!line || !view) return;
    await nextTick();
    const total = view.state.doc.lines;
    const target = Math.min(Math.max(1, line), total);
    const lineInfo = view.state.doc.line(target);
    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
    });
    view.focus();
    // 消费后清零，避免重复跳转。
    store.pendingLine = 0;
  },
);

function onSave() {
  const tab = store.activeTab;
  if (!tab) return;
  // 只读预览（超大文件截断）禁止保存，避免覆盖原始大文件。
  if (tab.readonly) return;
  // 把编辑器当前内容同步回 store 再保存。
  if (view && store.activePath === mountedPath) {
    store.markDirty(store.activePath, view.state.doc.toString());
  }
  void store.saveActive().then(() => {
    // 保存成功后刷新标签 mtime（store 内已处理）。
  });
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    onSave();
  }
}

onMounted(async () => {
  // 初始化主题（跟随宿主深/浅色）；失败保持默认暗色，不阻塞编辑器。
  void initTheme();
  // 初始化语言（跟随宿主中/英文）；失败保持默认中文。
  void initLang();
  // 启动文件变更推送监听（外部修改后自动刷新/提示）。
  startFileWatch();
  // 加载授权目录（目录树浏览起点）；失败不阻塞右键打开文件。
  void store.loadRoots();
  const p = pathFromLocation();
  if (p) {
    await store.openFile(p);
  }
});
</script>

<template>
  <div class="app" @keydown="onKeydown">
    <header class="toolbar">
      <button class="btn ghost" @click="showSidebar = !showSidebar" :title="t('toggleSidebar')">☰</button>
      <span class="title">{{ t('appName') }}</span>
      <span class="status-text">{{ store.status }}</span>
      <div class="spacer" />
      <button
        v-if="showPreview"
        class="btn ghost"
        @click="showPreview = !showPreview"
        :title="t('preview')"
      >{{ t('preview') }}</button>
      <button
        class="btn"
        :disabled="!store.activeTab || store.activeTab.loading || store.activeTab.readonly"
        @click="onSave"
      >
        {{ t('saveShortcut') }}
      </button>
    </header>

    <div class="body">
      <aside v-if="showSidebar" class="sidebar">
        <div class="sidebar-tabs">
          <button
            class="sidebar-tab"
            :class="{ active: sidebarTab === 'files' }"
            @click="sidebarTab = 'files'"
          >{{ t('files') }}</button>
          <button
            class="sidebar-tab"
            :class="{ active: sidebarTab === 'search' }"
            @click="sidebarTab = 'search'"
          >{{ t('search') }}</button>
        </div>
        <div v-if="sidebarTab === 'files'" class="sidebar-page">
          <!-- 遍历已授权根目录渲染目录树；无授权目录时给出提示。 -->
          <template v-if="store.authorizedRoots.length">
            <div v-for="root in store.authorizedRoots" :key="root" class="sidebar-tree">
              <DirTree :root="root" @open-file="onOpenFile" />
            </div>
          </template>
          <div v-else class="sidebar-hint">
            {{ t('noAuthDir') }}<br />{{ t('openFromFileManager') }}
          </div>
        </div>
        <div v-else class="sidebar-page">
          <SearchPanel />
        </div>
      </aside>

      <div class="main">
        <TabBar v-if="store.tabs.length" />
        <div class="editor-area">
          <div class="editor-pane">
            <div id="editor-host" class="editor-host" />
            <div v-if="!store.activeTab" class="placeholder">
              <div class="placeholder-title">{{ t('welcomeTitle') }}</div>
              <div class="placeholder-sub">{{ t('welcomeSub') }}</div>
              <div class="placeholder-hint">{{ t('welcomeHint') }}</div>
            </div>
          </div>
          <aside v-if="showPreview && store.activeTab?.isMarkdown" class="preview-pane">
            <MarkdownPreview :content="store.activeTab.content" />
          </aside>
        </div>
      </div>
    </div>

    <footer class="statusbar">
      <span>{{ store.activePath || t('noFile') }}</span>
      <span v-if="store.error" class="error">{{ store.error }}</span>
    </footer>
  </div>
</template>
