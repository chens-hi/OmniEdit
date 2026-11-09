<script setup lang="ts">
import { onMounted, ref, watch, nextTick, computed } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Annotation, Compartment } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { lineNumbers } from '@codemirror/view';
// tabSize 是 EditorState 静态 facet
const tabSizeFacet = EditorState.tabSize;
import { search } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { languageExtensionFor } from './language';
import { useEditorStore } from './store';
import { pathFromLocation } from './api';
import { initTheme, theme } from './theme';
import { initLang, t, lang } from './i18n';
import { startFileWatch } from './fileWatch';
import { createSearchPanel, openSearch } from './searchPanel';
import { whitespacePlugin, whitespaceTheme } from './whitespace';
import MenuBar from './components/MenuBar.vue';
import TabBar from './components/TabBar.vue';
import MarkdownPreview from './components/MarkdownPreview.vue';
import SaveAsDialog from './components/SaveAsDialog.vue';

const store = useEditorStore();
const showPreview = ref(false);
// 关于 / 快捷键速查模态
const showAbout = ref(false);
const showShortcuts = ref(false);
// 版本号：与 manifest 同步维护（构建时不自动注入，手工同步即可）
const appVersion = '0.3.0';
// 光标行列（状态栏实时显示；程序化同步与用户输入都更新）。
const cursor = ref({ line: 1, col: 1 });

// CodeMirror 主题热切换单元格：宿主切深/浅色时重配。
const themeCompartment = new Compartment();
// CodeMirror 可编辑性单元格：只读预览（超大文件）时禁用编辑。
const editableCompartment = new Compartment();
// 菜单栏驱动的设置单元格。
const indentCompartment = new Compartment();
const fontCompartment = new Compartment();
const wrapCompartment = new Compartment();
const lineNoCompartment = new Compartment();
// 空白符号可见化（显示 ▸ 菜单驱动）
const whitespaceCompartment = new Compartment();

function buildWhitespaceExts(): Extension[] {
  const cfg = {
    showSpaces: store.showSpaces,
    showTabs: store.showTabs,
    showLineBreaks: store.showLineBreaks,
  };
  return [whitespacePlugin(() => ({ ...cfg })), whitespaceTheme];
}

/** 缩进扩展组合：空格模式 = indentUnit 指定空格 + tabSize 渲染宽度；Tab 模式 = 制表符。 */
function buildIndentExts(): Extension[] {
  if (store.indentMode === 'tabs') {
    return [indentUnit.of('\t'), tabSizeFacet.of(store.indentWidth)];
  }
  return [indentUnit.of(' '.repeat(store.indentWidth)), tabSizeFacet.of(store.indentWidth)];
}

function buildFontExts(): Extension[] {
  return [EditorView.theme({
    '&': { fontSize: `${store.fontSize}px` },
    '.cm-scroller': { lineHeight: '1.6' },
  })];
}

function buildWrapExts(): Extension[] {
  return store.lineWrapping ? [EditorView.lineWrapping] : [];
}

function buildLineNoExts(): Extension[] {
  return store.showLineNumbers ? [lineNumbers()] : [];
}

// 程序化文档替换标记：外部变更重载/首次挂载走这条通道，不应计为用户编辑。
const docSync = Annotation.define<boolean>();

// CodeMirror 实例与当前挂载的标签 id（草稿无 path，用 id 定位）。
let view: EditorView | null = null;
let mountedId = 0;

/** 当前主题对应的 CodeMirror 主题扩展。暗色用 oneDark，浅色走 CSS 变量。 */
function cmThemeFor(t: 'dark' | 'light') {
  return t === 'dark' ? [oneDark] : [];
}

/** 从编辑器 state 计算光标行列（1-based，状态栏展示）。 */
function syncCursor(state: EditorState) {
  const head = state.selection.main.head;
  const lineInfo = state.doc.lineAt(head);
  cursor.value = { line: lineInfo.number, col: head - lineInfo.from + 1 };
}

/** 把内容挂载/切换到 CodeMirror。 */
function mountEditor(tab: { id: number; content: string; path: string; name: string; readonly: boolean }) {
  const host = document.getElementById('editor-host');
  if (!host) return;
  if (view) {
    view.destroy();
    view = null;
  }
  mountedId = tab.id;
  const updateListener = EditorView.updateListener.of((u) => {
    // 光标/文档任何变化都同步行列（含程序化替换后的重置）。
    if (u.selectionSet || u.docChanged) syncCursor(u.state);
    // wrap 切换的重排完成信号：解除滚动条抑制（事件驱动，见 watch 注释）。
    if (u.geometryChanged && suppressScrollbar) {
      suppressScrollbar = false;
      applyScrollbarSuppress();
    }
    // 只把「用户输入」计为编辑：程序化同步（docSync 标记）与未挂载完成的
    // 更新一律忽略——否则新打开的文件刚加载就会点亮未保存黄点。
    if (u.docChanged && mountedId && !u.transactions.some(tr => tr.annotation(docSync))) {
      store.markDirty(mountedId, u.state.doc.toString());
    }
  });
  view = new EditorView({
    parent: host,
    extensions: [
      basicSetup,
      // 搜索浮窗：官方搜索状态机 + 自定义面板 UI（Ctrl-F/Ctrl-H/F3 官方 keymap 保留）
      search({ createPanel: createSearchPanel() }),
      ...languageExtensionFor(tab.path || tab.name),
      themeCompartment.of(cmThemeFor(theme.value)),
      editableCompartment.of(EditorView.editable.of(!tab.readonly)),
      indentCompartment.of(buildIndentExts()),
      fontCompartment.of(buildFontExts()),
      wrapCompartment.of(buildWrapExts()),
      lineNoCompartment.of(buildLineNoExts()),
      whitespaceCompartment.of(buildWhitespaceExts()),
      updateListener,
    ],
    doc: tab.content,
  });
  syncCursor(view.state);
}

// 宿主主题变化时热切换 CodeMirror 配色。
watch(theme, (t) => {
  if (view) {
    view.dispatch({ effects: themeCompartment.reconfigure(cmThemeFor(t)) });
  }
});

// 活动标签变化时，切换编辑器内容。
watch(
  () => store.activeId,
  async () => {
    await nextTick();
    const tab = store.activeTab;
    if (!tab) {
      if (view) { view.destroy(); view = null; mountedId = 0; }
      showPreview.value = false;
      return;
    }
    if (tab.id !== mountedId) {
      mountEditor(tab);
    } else if (view) {
      // 已挂载的编辑器切到只读/可写标签时，同步可编辑性。
      view.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(!tab.readonly)),
      });
    }
    showPreview.value = tab.isMarkdown;
  },
);

// 编辑器内容被 store 更新（如外部变更重载）时同步到 CodeMirror。
// 用户输入不会走到这里（输入只改 doc，不改 store，除非 markDirty）。
watch(
  () => store.activeTab?.content,
  (content) => {
    const tab = store.activeTab;
    if (!view || !tab || tab.id !== mountedId || content === undefined) return;
    if (view.state.doc.toString() !== content) {
      // 外部变更重载：整体替换文档内容，保留滚动位置。
      // 带 docSync 标记 → updateListener 不计为用户编辑（不点黄点）。
      const curScroll = view.scrollDOM.scrollTop;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        annotations: docSync.of(true),
      });
      view.scrollDOM.scrollTop = curScroll;
    }
  },
);

// 保存按钮的 dirty 判定：无标题草稿即使未输入也允许另存为（保存空文件是合法预期）。
const canSave = () => {
  const tab = store.activeTab;
  return !!tab && !tab.loading && !tab.readonly;
};

// ---- 状态栏信息（全部从活动标签派生，纯展示） ----

/** 文档字节数：Blob 按字符串 UTF-8 编码，与后端读到的字节数一致（GBK 等由
 * 后端转成 UTF-8 后的内存内容计算——展示的是"编辑器里的内容大小"语义）。 */
const fileSize = computed(() => {
  const tab = store.activeTab;
  if (!tab) return 0;
  return new Blob([tab.content]).size;
});

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const lineCount = computed(() => {
  const tab = store.activeTab;
  if (!tab) return 0;
  return tab.content === '' ? 0 : tab.content.split('\n').length;
});

/** 编码显示名（UTF-8 简写；BOM/ANSI 有独立记号）。 */
const encodingLabel = computed(() => {
  const enc = store.activeTab?.encoding ?? 'utf-8';
  switch (enc) {
    case 'utf-8-bom': return 'UTF-8 BOM';
    case 'gb18030': return 'ANSI (GB18030)';
    default: return 'UTF-8';
  }
});

/** 行尾显示（后端识别结果；空串 = 无换行的空/单行文件，显示 LF 作默认）。 */
const lineEndingLabel = computed(() => {
  const le = store.activeTab?.lineEnding ?? '';
  switch (le) {
    case 'crlf': return 'CRLF';
    case 'mixed': return 'MIXED';
    default: return 'LF';
  }
});

const indentLabel = computed(() => {
  // 显示**用户设置**（菜单切换的值），与编辑器实际缩进行为一致；
  // 打开文件时检测的 tab.indent 仅用于建议，不再承担展示。
  // 制表符宽度恒为 4（固定），无需显示数字。
  return store.indentMode === 'tabs'
    ? t('menuIndentTabFixed')
    : `${t('indentSpacesWord')}: ${store.indentWidth}`;
});

/** 光标悬浮释义（中英文按当前语言拼接，零 i18n key）。 */
const cursorTitle = computed(() => {
  if (lang.value === 'en') return `Line ${cursor.value.line}, Column ${cursor.value.col}`;
  return `第 ${cursor.value.line} 行，第 ${cursor.value.col} 列`;
});



function onSave() {
  const tab = store.activeTab;
  if (!tab) return;
  // 只读预览（超大文件截断）禁止保存，避免覆盖原始大文件。
  if (tab.readonly) return;
  // 把编辑器当前内容同步回 store 再保存。
  if (view && tab.id === mountedId) {
    store.markDirty(tab.id, view.state.doc.toString());
    // markDirty 改的是同一响应式对象，无需等待。
  }
  void store.saveActive();
}

function onKeydown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (e.shiftKey) {
      // Ctrl+Shift+S：另存为（草稿和已打开文件都可用）
      store.saveAsVisible = true;
    } else {
      onSave();
    }
  }
  if (mod && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    store.newUntitled();
  }
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    void store.openViaPicker();
  }
  if (mod && e.key.toLowerCase() === 'h') {
    e.preventDefault();
    if (view) openSearch(view, 'replace');
  }
  // Ctrl+F 由 CodeMirror 官方 keymap 处理（打开搜索面板）
}

// 菜单动作：查找/替换（App 持有 view 实例）
function onMenuFind(mode: 'find' | 'replace') {
  if (view) openSearch(view, mode);
}

// 设置变化 → 重新配置 CodeMirror（菜单栏切换即时生效）
watch(() => [store.indentMode, store.indentWidth], () => {
  view?.dispatch({ effects: indentCompartment.reconfigure(buildIndentExts()) });
});
watch(() => store.fontSize, () => {
  view?.dispatch({ effects: fontCompartment.reconfigure(buildFontExts()) });
});
// 滚动条抑制状态：wrap 切换置位，CM geometryChanged（重排完成标志）驱动恢复
let suppressScrollbar = false;

function applyScrollbarSuppress() {
  const scroller = document.querySelector('.cm-scroller') as HTMLElement | null;
  if (scroller) scroller.style.overflowX = suppressScrollbar ? 'hidden' : '';
}

watch(() => store.lineWrapping, (on) => {
  view?.dispatch({ effects: wrapCompartment.reconfigure(buildWrapExts()) });
  // 事件驱动恢复：reconfigure 后 CM 完成重排必派发 geometryChanged，
  // updateListener 在那一刻解除抑制（双 rAF 是猜时序，真机不可靠）。
  suppressScrollbar = true;
  applyScrollbarSuppress();
  // 兜底：极端情况下 geometryChanged 迟迟不来，300ms 强制恢复
  window.setTimeout(() => {
    if (suppressScrollbar) {
      suppressScrollbar = false;
      applyScrollbarSuppress();
    }
  }, 300);
  void on;
});
watch(() => store.showLineNumbers, () => {
  view?.dispatch({ effects: lineNoCompartment.reconfigure(buildLineNoExts()) });
});
watch(() => [store.showSpaces, store.showTabs, store.showLineBreaks], () => {
  view?.dispatch({ effects: whitespaceCompartment.reconfigure(buildWhitespaceExts()) });
});

onMounted(async () => {
  // 初始化主题（跟随宿主深/浅色）；失败保持默认暗色，不阻塞编辑器。
  void initTheme();
  // 初始化语言（跟随宿主中/英文）；失败保持默认中文。
  void initLang();
  // 启动文件变更推送监听（外部修改后自动刷新/提示）。
  startFileWatch();
  const p = pathFromLocation();
  if (p) {
    await store.openFile(p);
  } else {
    // 记事本形态：桌面图标打开 = 空白的「无标题」编辑窗口。
    store.newUntitled();
  }
});
</script>

<template>
  <div class="app" @keydown="onKeydown">
    <MenuBar
      @find="onMenuFind"
      @about="showAbout = true"
      @shortcuts="showShortcuts = true"
    />
    <header class="toolbar">
      <span class="status-text">{{ store.status }}</span>
      <div class="spacer" />
      <button
        v-if="store.activeTab?.isMarkdown"
        class="btn ghost"
        @click="showPreview = !showPreview"
        :title="t('preview')"
      >{{ t('preview') }}</button>
      <button class="btn" :disabled="!canSave()" @click="onSave">
        {{ store.activeTab?.path ? t('saveShortcut') : t('menuSaveAs') }}
      </button>
    </header>

    <div class="body">
      <div class="main">
        <TabBar v-if="store.tabs.length" />
        <div class="editor-area">
          <div class="editor-pane">
            <div id="editor-host" class="editor-host" />
            <div v-if="!store.activeTab" class="placeholder">
              <div class="placeholder-title">{{ t('welcomeTitle') }}</div>
              <div class="placeholder-sub">{{ t('welcomeSub') }}</div>
            </div>
          </div>
          <aside v-if="showPreview && store.activeTab?.isMarkdown" class="preview-pane">
            <MarkdownPreview :content="store.activeTab.content" />
          </aside>
        </div>
      </div>
    </div>

    <footer class="statusbar">
      <span class="sb-path" :title="store.activePath || t('noFile')">{{ store.activePath || t('noFile') }}</span>
      <span v-if="store.error" class="error">{{ store.error }}</span>
      <div v-if="store.activeTab" class="sb-right">
        <span class="sbi" :title="t('indentHint')">{{ indentLabel }}</span>
        <span class="sbsep" />
        <span
          class="sbi"
          :class="{ badge: store.activeTab.encoding === 'gb18030' }"
          :title="store.activeTab.encoding === 'gb18030' ? t('encodingBadge') : 'Encoding'"
        >{{ encodingLabel }}</span>
        <span class="sbsep" />
        <span class="sbi" title="Line ending">{{ lineEndingLabel }}</span>
        <span class="sbsep" />
        <span class="sbi" :title="cursorTitle">
          {{ lineCount }} {{ t('linesUnit') }}<span class="dim"> · {{ cursor.line }}:{{ cursor.col }}</span>
        </span>
        <span class="sbsep" />
        <span class="sbi">{{ fmtSize(fileSize) }}</span>
      </div>
    </footer>

    <SaveAsDialog
      v-if="store.saveAsVisible"
      :suggested-name="store.activeTab?.name ?? ''"
      :initial-dir="store.lastSaveDir"
      :mode="store.activeTab?.path ? 'copy' : 'draft'"
      @confirm="store.doSaveAs($event)"
      @close="store.closeSaveAs()"
    />

    <div v-if="showAbout" class="mmodal-mask" @click.self="showAbout = false">
      <div class="mmodal">
        <div class="mmodal-title">OmniEdit</div>
        <div class="mmodal-body">
          <div>{{ t('welcomeSub') }}</div>
          <div class="dim">v{{ appVersion }}</div>
        </div>
        <button class="btn" @click="showAbout = false">{{ t('cancel') }}</button>
      </div>
    </div>

    <div v-if="showShortcuts" class="mmodal-mask" @click.self="showShortcuts = false">
      <div class="mmodal">
        <div class="mmodal-title">{{ t('menuShortcuts') }}</div>
        <div class="mmodal-body shortcuts">
          <div><span>Ctrl+N</span>{{ t('menuNew') }}</div>
          <div><span>Ctrl+O</span>{{ t('menuOpen') }}</div>
          <div><span>Ctrl+S</span>{{ t('menuSave') }}</div>
          <div><span>Ctrl+Shift+S</span>{{ t('menuSaveAs') }}</div>
          <div><span>Ctrl+F</span>{{ t('menuFind') }}</div>
          <div><span>Ctrl+H</span>{{ t('menuReplace') }}</div>
          <div><span>F3 / Shift+F3</span>{{ t('nextMatch') }} / {{ t('prevMatch') }}</div>
        </div>
        <button class="btn" @click="showShortcuts = false">{{ t('cancel') }}</button>
      </div>
    </div>
  </div>
</template>
