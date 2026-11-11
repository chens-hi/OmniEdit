<script setup lang="ts">
import { onMounted, ref, watch, nextTick, computed } from 'vue';
// 用 minimalSetup 而非 basicSetup：后者硬编码 lineNumbers()，导致行号无法被
// lineNoCompartment 关闭（basicSetup 那份 lineNumberConfig 恒在）。改用 minimal
// 后行号唯一来源是我们的 compartment，开关才真正生效。
import { EditorView, minimalSetup } from 'codemirror';
import { EditorState, Annotation, Compartment, Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
// 手动补齐 basicSetup 有、minimalSetup 无的能力（除 lineNumbers——交给 compartment）。
import {
  indentUnit, indentOnInput, foldGutter, foldKeymap, bracketMatching,
  syntaxHighlighting, defaultHighlightStyle,
} from '@codemirror/language';
import {
  keymap, lineNumbers, drawSelection, dropCursor, rectangularSelection,
  crosshairCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars,
} from '@codemirror/view';
import { history, indentMore, indentLess, defaultKeymap, historyKeymap } from '@codemirror/commands';
import type { Command } from '@codemirror/view';
// tabSize 是 EditorState 静态 facet
const tabSizeFacet = EditorState.tabSize;
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { languageExtensionFor } from './language';
import { useEditorStore } from './store';
import { pathFromLocation } from './api';
import { initTheme, theme } from './theme';
import { initLang, t, lang } from './i18n';
import { startFileWatch } from './fileWatch';
import { createSearchPanel, openSearch } from './searchPanel';
import { whitespaceExtensions } from './whitespace';
import MenuBar from './components/MenuBar.vue';
import TabBar from './components/TabBar.vue';
import MarkdownPreview from './components/MarkdownPreview.vue';
import SaveAsDialog from './components/SaveAsDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import BatchCloseModal from './components/BatchCloseModal.vue';
import AppModal from './components/AppModal.vue';
import AppToast from './components/AppToast.vue';

const store = useEditorStore();
const showPreview = ref(false);
// 关于模态
const showAbout = ref(false);
// 版本号：与 manifest 同步维护（构建时不自动注入，手工同步即可）
const appVersion = '0.5.71';
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
// 空白符号装饰（显示 ▸ 菜单驱动；CM 原生 Decoration，视口级自动管理）
const whitespaceCompartment = new Compartment();

function wsCfg() {
  return {
    showSpaces: store.showSpaces,
    showTabs: store.showTabs,
    showLineBreaks: store.showLineBreaks,
  };
}

function buildWhitespaceExts(): Extension[] {
  return whitespaceExtensions(wsCfg);
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
    // 编辑器字体走 --font-mono 变量（fonts.css 定义默认栈，applyEditorFont 动态覆盖）。
    // 关键：CM 的 baseTheme 在 .cm-scroller 上硬编码 fontFamily:"monospace"，
    // 会盖掉容器(&=.cm-editor)上的设置——必须显式在 .cm-scroller 与行号槽上
    // 设 var(--font-mono)，JetBrains Mono 才会真正生效。
    '&': { fontSize: `${store.fontSize}px`, fontFamily: 'var(--font-mono)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
    '.cm-gutters': { fontFamily: 'var(--font-mono)' },
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
      // minimalSetup + 手动补齐（除 lineNumbers）：等价 basicSetup 但行号可控。
      // 见顶部 import 处的说明——basicSetup 硬编码 lineNumbers() 导致行号关不掉。
      minimalSetup,
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      highlightSelectionMatches(),
      foldGutter(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
      // 应用级快捷键（Prec.highest 优先于 defaultKeymap，含 Tab 缩进）
      appKeymap,
      // 搜索浮窗：官方搜索状态机 + 自定义面板 UI（Mod-f/F3/Esc 官方 keymap 保留）
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
  // debug 钩子：排障/自动化测试用（必须在 new EditorView 之后赋值）
  (window as unknown as { __omnieditView?: EditorView | null }).__omnieditView = view;
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
  // 已落盘文件：与菜单「保存」的禁用语义一致（!dirty 不动作）。
  // 否则无改动时 Ctrl+S 也会 markDirty→写盘，表现为黄点闪一下 + 无谓更新 mtime
  // （同文件在别处打开会误报外部修改）。草稿（无路径）不受此限：Ctrl+S 直接打开另存为。
  if (tab.path && !tab.dirty) return;
  // 把编辑器当前内容同步回 store 再保存（updateListener 已实时同步，此处兜底）。
  if (view && tab.id === mountedId) {
    store.markDirty(tab.id, view.state.doc.toString());
    // markDirty 改的是同一响应式对象，无需等待。
  }
  void store.saveActive();
}

// 菜单动作：查找/替换（App 持有 view 实例）
function onMenuFind(mode: 'find' | 'replace') {
  if (view) openSearch(view, mode);
}

/**
 * Tab / Shift+Tab 命令：
 *   - 有选区 → 整行缩进 / 反缩进（indentMore / indentLess）
 *   - 无选区 → 在光标处插入缩进单元（空格 = indentWidth 个空格；Tab 模式 = \t）
 *
 * 这是 Notepad++ / VS Code / 记事本 的标准语义——indentWithTab 把 Tab 一律
 * 当成整行缩进，跟用户预期不符，所以手写一个。
 *
 * 用 Command (EditorView → boolean) 而不是 StateCommand，跟 CM KeyBinding.run
 * 类型对齐，避免 CM 内部适配层的边缘问题。
 */
const tabCommand: Command = (view) => {
  const { state, dispatch } = view;
  const hasSel = state.selection.ranges.some(r => !r.empty);
  const mode = store.indentMode;
  const width = store.indentWidth;
  console.log('[TabCmd] hasSel=', hasSel, 'mode=', mode, 'width=', width, 'head=', state.selection.main.head);
  if (hasSel) return indentMore(view);
  const insert = mode === 'tabs' ? '\t' : ' '.repeat(width);
  console.log('[TabCmd] inserting', JSON.stringify(insert));
  dispatch(state.update(state.replaceSelection(insert), { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

const shiftTabCommand: Command = (view) => indentLess(view);

/**
 * 应用级快捷键：只保留常规编辑键（Prec.highest 优先于 defaultKeymap）。
 *
 * 保留：Mod-s 保存、Mod-h 替换、Tab/Shift-Tab 缩进（自定义，遵循缩进设置）、
 * Mod-f/F3/Esc（官方 searchKeymap）、Ctrl+Z/Y 等（minimalSetup 内置）。
 * 注意 Mod-f 必须接管为自定义 openSearch('find')：官方 openSearchPanel 不知道
 * 我们的查找/替换展开模式，会让面板带着上次遗留的替换展开态打开。
 * 不绑定：Ctrl+N/O/W（浏览器原生语义：新窗口/打开/关页面，功能走菜单与
 * 按钮）、Ctrl+Shift+S（另存为走菜单）。
 */
const appKeymap = Prec.highest(
  keymap.of([
    { key: 'Mod-s', run: () => { onSave(); return true; } },
    { key: 'Mod-f', run: () => { onMenuFind('find'); return true; } },
    { key: 'Mod-h', run: () => { onMenuFind('replace'); return true; } },
    { key: 'Tab', run: tabCommand, shift: shiftTabCommand },
  ]),
);

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
  // 拉取后端偏好（菜单设置/上次保存目录）并恢复上次会话的标签。
  // 失败不阻塞：各项回落 localStorage 缓存/默认值。
  const restored = await store.initPrefs();
  const p = pathFromLocation();
  if (p) {
    // URL ?path= 优先（文件管理器右键打开）：直接打开该文件，会话其余标签仍在。
    await store.openFile(p);
  } else if (restored.hasSession) {
    // 无 path 且有会话 → 已恢复标签，定位到上次活动标签即可（initPrefs 已设）。
    // 若会话标签全部打开失败（文件被删等），兜底新建草稿，避免空白无标签。
    if (!store.tabs.length) store.newUntitled();
  } else {
    // 记事本形态：桌面图标打开 = 空白的「无标题」编辑窗口。
    store.newUntitled();
  }
});
</script>

<template>
  <div class="app">
    <MenuBar
      @find="onMenuFind"
      @about="showAbout = true"
    />

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
        <span class="sbsep sb-opt" />
        <span
          class="sbi sb-opt"
          title="Line ending"
        >{{ lineEndingLabel }}</span>
        <span class="sbsep" />
        <span class="sbi" :title="cursorTitle">
          {{ lineCount }} {{ t('linesUnit') }}<span class="dim"> · {{ cursor.line }}:{{ cursor.col }}</span>
        </span>
        <span class="sbsep sb-opt" />
        <span class="sbi sb-opt">{{ fmtSize(fileSize) }}</span>
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

    <!-- 全局轻提示（toast）：store.toast 驱动，自动消失 -->
    <AppToast />

    <!-- 全局确认对话框（替代 window.confirm，store.confirm 驱动） -->
    <ConfirmDialog
      v-if="store.confirmDialog.visible"
      :message="store.confirmDialog.message"
      :title="store.confirmDialog.title"
      :confirm-text="store.confirmDialog.confirmText"
      :danger="store.confirmDialog.danger"
      @result="store.settleConfirm($event)"
    />

    <!-- 批量关闭确认模态（store.batchClose 驱动；单/多脏标签关闭复用） -->
    <BatchCloseModal v-if="store.batchClose.visible" />

    <AppModal v-if="showAbout" :title="'OmniEdit'" :width="360" @close="showAbout = false">
      <div>{{ t('welcomeSub') }}</div>
      <div class="dim">v{{ appVersion }}</div>
      <template #footer>
        <button class="btn" @click="showAbout = false">{{ t('cancel') }}</button>
      </template>
    </AppModal>
  </div>
</template>
