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
import { languageExtensionFor, languageFromShebang, PREVIEW_MAX_BYTES } from './language';
import { useEditorStore } from './store';
import { pathFromLocation } from './api';
import { initTheme, theme } from './theme';
import { syntaxHighlightFor } from './syntaxTheme';
import { initLang, t, lang } from './i18n';
import { startFileWatch } from './fileWatch';
import { createSearchPanel, openSearch } from './searchPanel';
import { whitespaceExtensions } from './whitespace';
import MenuBar from './components/MenuBar.vue';
import TabBar from './components/TabBar.vue';
import PreviewPanel from './components/PreviewPanel.vue';
import SaveAsDialog from './components/SaveAsDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import ContextMenu from './components/ContextMenu.vue';
import BatchCloseModal from './components/BatchCloseModal.vue';
import AppModal from './components/AppModal.vue';
import AppToast from './components/AppToast.vue';

const store = useEditorStore();
const showPreview = ref(false);
// 关于模态
const showAbout = ref(false);
// 版本号：与 manifest 同步维护（构建时不自动注入，手工同步即可）
const appVersion = '0.6.54';
// 光标行列（状态栏实时显示；程序化同步与用户输入都更新）。
const cursor = ref({ line: 1, col: 1 });

// ---- 大文件性能：内容快照同步 + 文档统计 ----
// docStats：行数 O(1)（CM doc.lines）每键更新；字节数只在同步点算一次
// （防抖 500ms / 切页签 flush / 打开文件初始化），不在每键路径上。
const docStats = ref({ lines: 0, bytes: 0 });
let contentSyncTimer: number | undefined;

/** 把当前编辑器全文写回 store 快照并刷新统计（关键点单次 O(n)）。 */
function flushContent() {
  const id = mountedId;
  if (!view || !id) return;
  const text = view.state.doc.toString();
  store.syncContent(id, text);
  if (store.activeTab?.id === id) {
    docStats.value = { lines: view.state.doc.lines, bytes: new Blob([text]).size };
  }
}

/**
 * 预览真正在渲染内容（可见且 ≤1MB）时，防抖 500ms 同步一次快照给预览
 * （预览内容来自 tab.content 快照）；其余场景零成本——保存/切页签/关闭
 * 由关键点 provider 拉取兜底，预览暂停态不需要新鲜内容。
 */
function scheduleContentSync() {
  const tab = store.activeTab;
  if (!showPreview.value || !tab?.previewKind || tab.content.length > PREVIEW_MAX_BYTES) return;
  window.clearTimeout(contentSyncTimer);
  contentSyncTimer = window.setTimeout(flushContent, 500);
}

// CodeMirror 主题热切换单元格：宿主切深/浅色时重配。
const themeCompartment = new Compartment();
// 语法高亮配色单元格：随主题（深/浅）切换 token 配色，替换原 defaultHighlightStyle。
const syntaxCompartment = new Compartment();
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

/**
 * 行号槽 + 折叠槽的组合。
 *
 * CodeMirror 的 gutter 左右顺序 = 扩展添加顺序，所以这里把两者放在同一个
 * compartment 里统一管理，保证「行号在左、折叠箭头在右」：
 *   - 开行号：[lineNumbers(), foldGutter()] → 行号 | 折叠
 *   - 关行号：[foldGutter()]                → 折叠独占（自然落到最左）
 * 若把 foldGutter 留在主 extensions 里（早于本 compartment 添加），
 * 它就会跑到行号左侧，与主流编辑器习惯相反。
 */
function buildLineNoExts(): Extension[] {
  return store.showLineNumbers ? [lineNumbers(), foldGutter()] : [foldGutter()];
}

// 程序化文档替换标记：外部变更重载/首次挂载走这条通道，不应计为用户编辑。
const docSync = Annotation.define<boolean>();

// CodeMirror 实例与当前挂载的标签 id（草稿无 path，用 id 定位）。
let view: EditorView | null = null;
let mountedId = 0;

/**
 * CodeMirror 编辑器主题：全 CSS 变量（--bg/--fg/--accent/--toolbar-bg…），
 * 暗浅共用一套——主题切换由 <html data-theme> 的变量驱动，无需重建/重配扩展。
 * 弃用 oneDark：其底色 #282c34 与应用 --bg #1e1e1e 不一致，导致预览（走 --bg）
 * 与编辑区色差跳变；语法高亮调色板也按 --bg 底设计，统一后完全同源。
 */
const appEditorThemeExt = EditorView.theme({
  '&': { color: 'var(--fg)', backgroundColor: 'var(--bg)' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  /**
   * 选中背景：必须压过 CodeMirror 默认主题的
   * `.ͼ2.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
   * （4 类 + 子选择器，特异性 (0,4,0)）——它把深色主题下的选区设成近白色
   * rgb(215,212,240)，导致浅色语法高亮文字几乎不可读。
   * 这里补上同样深的选择器路径保证特异性胜出；颜色走 --sel-bg 主题变量，
   * 深/浅色各取一档（深色偏蓝、浅色偏浅蓝，均与控制台/VS Code 观感一致）。
   */
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--sel-bg)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--fg) 5%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--toolbar-bg)', color: 'var(--fg-muted)', border: 'none' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--fg) 8%, transparent)',
    color: 'var(--fg)',
  },
  '.cm-lineNumbers .cm-gutterElement': { color: 'var(--fg-muted)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--toolbar-bg)',
    border: 'none',
    color: 'var(--fg-muted)',
  },
  // 搜索命中也走主题色（原样式表里硬编码橙色，与主题 accent 蓝不搭）
  '.cm-selectionMatch': { backgroundColor: 'var(--sel-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--sel-find)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--sel-find-active)' },
});

/** 当前主题对应的 CodeMirror 主题扩展（暗浅同主题，变量自动切换）。 */
function cmThemeFor(t: 'dark' | 'light') {
  void t;
  return [appEditorThemeExt];
}

/** 从编辑器 state 计算光标行列（1-based，状态栏展示）。 */
function syncCursor(state: EditorState) {
  const head = state.selection.main.head;
  const lineInfo = state.doc.lineAt(head);
  cursor.value = { line: lineInfo.number, col: head - lineInfo.from + 1 };
}

/** 把内容挂载/切换到 CodeMirror。 */
function mountEditor(tab: { id: number; content: string; path: string; name: string; readonly: boolean; previewKind: 'markdown' | 'html' | null }) {
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
    // 每键轻量化：只置 dirty + O(1) 行数（大文件性能，全文走 provider 关键点拉取）。
    if (u.docChanged && mountedId && !u.transactions.some(tr => tr.annotation(docSync))) {
      store.markDirtyLight(mountedId);
      docStats.value = { lines: u.state.doc.lines, bytes: docStats.value.bytes };
      scheduleContentSync();
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
      syntaxCompartment.of(syntaxHighlightFor(theme.value)),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      highlightSelectionMatches(),
      // foldGutter 不在此处：它要与行号保持固定左右顺序，交给 lineNoCompartment
      // 统一管理（见 buildLineNoExts）。放在这里会排到行号左侧。
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
      // 应用级快捷键（Prec.highest 优先于 defaultKeymap，含 Tab 缩进）
      appKeymap,
      // 搜索浮窗：官方搜索状态机 + 自定义面板 UI（Mod-f/F3/Esc 官方 keymap 保留）
      search({ createPanel: createSearchPanel() }),
      // 语言高亮：优先按扩展名；无扩展名/未知类型时按 shebang 识别
      // （NAS 上很多可执行脚本没有后缀，靠 #! 判定 bash/python/perl 等）。
      ...(() => {
        const byExt = languageExtensionFor(tab.path || tab.name);
        if (byExt.length) return byExt;
        const byShebang = languageFromShebang(tab.content);
        return byShebang ? [byShebang] : [];
      })(),
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
  // debug 钩子：仅开发构建暴露（生产剥离，避免扩展/注入脚本读取文档内容）
  if (import.meta.env.DEV) {
    (window as unknown as { __omnieditView?: EditorView | null }).__omnieditView = view;
  }
  syncCursor(view.state);
  // 初始化状态栏统计（行数 O(1)；字节数按打开内容一次算好）。
  docStats.value = { lines: view.state.doc.lines, bytes: new Blob([tab.content]).size };
}

// 宿主主题变化时热切换 CodeMirror 配色（编辑器外壳 + 语法高亮 token 配色）。
watch(theme, (t) => {
  if (view) {
    view.dispatch({
      effects: [
        themeCompartment.reconfigure(cmThemeFor(t)),
        syntaxCompartment.reconfigure(syntaxHighlightFor(t)),
      ],
    });
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
      flushContent(); // 旧编辑器全文写回快照（非活动标签的数据源，关键点）
      // 内容还没到就先不挂载：挂一个空 doc 再被内容替换会闪一下空白，
      // 且对大文件来说是白建一次 EditorView。等 fillTab 填充后由
      // 下面的 content watch 触发挂载。
      if (!tab.loading) mountEditor(tab);
      else if (view) { view.destroy(); view = null; mountedId = 0; }
    } else if (view) {
      // 已挂载的编辑器切到只读/可写标签时，同步可编辑性。
      view.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(!tab.readonly)),
      });
    }
    // 切页签回到自动预览默认；眼/笔可再手动覆盖当前页。
    showPreview.value = store.autoPreview && tab.previewKind !== null;
    // 该页签在后台被外部改过（当时只打了标记没打扰）：现在用户看着它了，
    // 补问一次「重载 / 保持当前」。
    if (tab.externalChanged) void store.promptExternalChange(tab.id);
  },
);

// 编辑器内容被 store 更新（如外部变更重载）时同步到 CodeMirror。
// 用户输入不会走到这里（输入只置 dirty 不改快照；快照由 reload/flush 写入）。
// 同时监听 loading：恢复占位标签是「先 loading=true，内容到了才置 false」，
// 只盯 content 会在 content 与 loading 的赋值顺序变化时漏触发。
watch(
  () => [store.activeTab?.content, store.activeTab?.loading] as const,
  ([content]) => {
    const tab = store.activeTab;
    if (!tab || content === undefined) return;
    // 尚未挂载（活动标签刚从恢复占位里加载完内容）：现在才建编辑器，
    // 直接用已就绪的内容初始化，避免空 doc 先闪一下。
    if (!view || tab.id !== mountedId) {
      if (tab.loading) return; // 内容仍未到，继续等
      mountEditor(tab);
      return;
    }
    // 长度预判：不同必是外部修改（免两次 O(n)——toString + 全文比较）。
    // 长度相同仍需比对（内容可能不同），但这只在外部重载时发生，频率极低。
    if (view.state.doc.length !== content.length || view.state.doc.toString() !== content) {
      // 外部变更重载：整体替换文档内容，保留滚动位置。
      // 带 docSync 标记 → updateListener 不计为用户编辑（不点黄点）。
      const curScroll = view.scrollDOM.scrollTop;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        annotations: docSync.of(true),
      });
      view.scrollDOM.scrollTop = curScroll;
      docStats.value = { lines: view.state.doc.lines, bytes: new Blob([content]).size };
    }
  },
);

// ---- 状态栏信息（全部从活动标签派生，纯展示） ----

/**
 * 文档字节数：docStats.bytes——Blob 按字符串 UTF-8 编码，与后端读到的一致。
 * 大文件性能：不在每键路径上算 Blob，只在同步点（防抖 500ms/flush/打开）算一次。
 */
const fileSize = computed(() => store.activeTab ? docStats.value.bytes : 0);

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 行数：docStats.lines——CM doc.lines 每键 O(1) 更新（替代 split O(n)）。 */
const lineCount = computed(() => store.activeTab ? docStats.value.lines : 0);

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
  // 只读标签禁止保存（当前无此来源，保留语义防御）。
  if (tab.readonly) return;
  // 已落盘文件：与菜单「保存」的禁用语义一致（!dirty 不动作）。
  // 否则无改动时 Ctrl+S 也会写盘，表现为黄点闪一下 + 无谓更新 mtime
  // （同文件在别处打开会误报外部修改）。草稿（无路径）不受此限：Ctrl+S 直接打开另存为。
  if (tab.path && !tab.dirty) return;
  // 内容由 saveTab 经 provider 拉当前编辑器全文（关键点单次 O(n)），无需预先同步。
  void store.saveActive();
}

// 菜单动作：查找/替换（App 持有 view 实例）
function onMenuFind(mode: 'find' | 'replace') {
  if (view) openSearch(view, mode);
}

/** 编辑菜单 剪贴板/全选：分发到对应操作（作用于活动页签的编辑器）。 */
function onMenuClipboard(op: 'copy' | 'cut' | 'paste' | 'selectall') {
  if (op === 'copy') ctxCopy();
  else if (op === 'cut') ctxCut();
  else if (op === 'paste') void ctxPaste();
  else if (op === 'selectall') ctxSelectAll();
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

// ---- 编辑区自定义右键菜单：复制/剪切/粘贴/全选（基础版，后续可扩展）----
// 复用页签右键的 ContextMenu 组件；剪贴板走 navigator.clipboard API（不依赖
// 浏览器原生菜单的焦点，菜单点击后仍可操作已挂载的 view）。
// 关键：view.state.selection 非响应式，computed 不追踪——故在 contextmenu 那刻
// 把「有无选区」快照进 editorCtx，菜单项 disabled 从快照读，避免读到过期状态。
const editorCtx = ref<{ x: number; y: number } | null>(null);

function ctxCopy() {
  if (!view) return;
  const s = view.state.selection.main;
  if (!s.empty) {
    void navigator.clipboard.writeText(view.state.sliceDoc(s.from, s.to)).catch(() => {});
    return;
  }
  // 无选区：复制光标所在整行
  const line = view.state.doc.lineAt(s.head);
  void navigator.clipboard.writeText(line.text).catch(() => {});
}

function ctxCut() {
  if (!view) return;
  const s = view.state.selection.main;
  if (!s.empty) {
    // 有选区：剪切选区
    void navigator.clipboard.writeText(view.state.sliceDoc(s.from, s.to)).catch(() => {});
    view.dispatch({ changes: { from: s.from, to: s.to }, selection: { anchor: s.from } });
    return;
  }
  // 无选区：剪切光标所在整行（复制该行并删除，含换行）
  const line = view.state.doc.lineAt(s.head);
  void navigator.clipboard.writeText(line.text).catch(() => {});
  const to = line.to < view.state.doc.length ? line.to + 1 : line.to;
  view.dispatch({ changes: { from: line.from, to }, selection: { anchor: line.from } });
}

async function ctxPaste() {
  if (!view) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
  } catch {
    // 剪贴板读取被拒（权限/非安全上下文）：静默忽略
  }
}

function ctxSelectAll() {
  if (!view) return;
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
}

function onEditorContextmenu(e: MouseEvent) {
  // 空白页无编辑内容，走浏览器默认菜单
  if (!store.activeTab) return;
  e.preventDefault();
  editorCtx.value = { x: e.clientX, y: e.clientY };
}

const editorCtxItems = computed(() => {
  // 复制/剪切：无选区时作用于光标所在整行，故只要有文件即可用（不只选中时）
  const hasDoc = !!store.activeTab;
  return [
    { label: t('ctxCopy'), shortcut: 'Ctrl+C', disabled: !hasDoc, action: ctxCopy },
    { label: t('ctxCut'), shortcut: 'Ctrl+X', disabled: !hasDoc, action: ctxCut },
    { label: t('ctxPaste'), shortcut: 'Ctrl+V', action: () => void ctxPaste() },
    { label: t('ctxSelectAll'), shortcut: 'Ctrl+A', disabled: !hasDoc, action: ctxSelectAll },
  ];
});

/** 是否正在显示预览（预览态：整个编辑区被预览替换）。 */
const previewShowing = computed(() => showPreview.value && !!store.activeTab?.previewKind);

// ---- 预览区右键菜单：只有「复制」（预览只读，无剪切/粘贴/全选） ----
// DOM 选区（window.getSelection）非响应式——右键那刻快照选中文本，
// 菜单项 disabled 与复制动作都读快照，避免读到过期状态（同 editorCtx 教训）。
const previewCtx = ref<{ x: number; y: number; selText: string } | null>(null);

function onPreviewContextmenu(e: MouseEvent) {
  e.preventDefault();
  const sel = window.getSelection()?.toString() ?? '';
  previewCtx.value = { x: e.clientX, y: e.clientY, selText: sel };
}

const previewCtxItems = computed(() => {
  const hasSel = !!previewCtx.value?.selText;
  return [
    {
      label: t('ctxCopy'),
      shortcut: 'Ctrl+C',
      disabled: !hasSel,
      action: () => {
        const s = previewCtx.value?.selText;
        if (s) void navigator.clipboard.writeText(s).catch(() => {});
      },
    },
  ];
});

// ---- 预览/编辑悬浮按钮：可拖拽，点按切换，拖拽后吸附左右边缘，位置持久化 ----
const TOGGLE_POS_KEY = 'omniedit.previewTogglePos';
const TOGGLE_SIZE = 52;        // 按钮边长（px，与 CSS 一致）
const TOGGLE_MARGIN = 10;      // 吸附到边缘时的留白
const TOGGLE_DRAG_THRESHOLD = 6; // 区分点按/拖拽的移动阈值

const toggleBtn = ref<HTMLElement | null>(null);
// 按钮相对 editor-area 左上的位置；null = 默认右上角（CSS top/right）。
const togglePos = ref<{ x: number; y: number } | null>(null);
// 拖拽状态：grabDX/Y=指针相对按钮左上的偏移（拖拽时按钮位置=指针-偏移，点按不跳）；
// parentLeft/Y=editor-area 在视口的位置；moved=是否已判定为拖拽。
let toggleDrag: {
  pointerId: number; grabDX: number; grabDY: number;
  parentLeft: number; parentTop: number;
  startClientX: number; startClientY: number;
  moved: boolean;
} | null = null;

function loadTogglePos() {
  try {
    const raw = localStorage.getItem(TOGGLE_POS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p && typeof p.x === 'number' && typeof p.y === 'number') togglePos.value = { x: p.x, y: p.y };
  } catch { /* 忽略损坏数据 */ }
}
function saveTogglePos() {
  try {
    if (togglePos.value) localStorage.setItem(TOGGLE_POS_KEY, JSON.stringify(togglePos.value));
  } catch { /* ignore */ }
}
/** 把按钮位置钳制在 editor-area 内（不出屏）。 */
function clampToggle(x: number, y: number): { x: number; y: number } {
  const parent = toggleBtn.value?.offsetParent as HTMLElement | null;
  const w = parent?.clientWidth ?? 0;
  const h = parent?.clientHeight ?? 0;
  const maxX = Math.max(0, w - TOGGLE_SIZE - TOGGLE_MARGIN);
  const maxY = Math.max(0, h - TOGGLE_SIZE - TOGGLE_MARGIN);
  return {
    x: Math.min(Math.max(x, TOGGLE_MARGIN), maxX),
    y: Math.min(Math.max(y, TOGGLE_MARGIN), maxY),
  };
}
/** 拖拽释放：吸附到最近的左/右边缘（保留纵向位置）。 */
function snapToggleToEdge() {
  const cur = togglePos.value;
  if (!cur) return;
  const parent = toggleBtn.value?.offsetParent as HTMLElement | null;
  const w = parent?.clientWidth ?? 0;
  const x = cur.x + TOGGLE_SIZE / 2 < w / 2 ? TOGGLE_MARGIN : w - TOGGLE_SIZE - TOGGLE_MARGIN;
  togglePos.value = clampToggle(x, cur.y);
  saveTogglePos();
}
/** 停止拖拽并解绑临时监听。 */
function endToggleDrag() {
  window.removeEventListener('pointermove', onTogglePointerMove);
  window.removeEventListener('pointerup', onTogglePointerUp);
  window.removeEventListener('pointercancel', onTogglePointerCancel);
  toggleDrag = null;
}
function onTogglePointerDown(e: PointerEvent) {
  const btn = e.currentTarget as HTMLElement;
  const parent = btn.offsetParent as HTMLElement;
  const parentRect = parent.getBoundingClientRect();
  const rect = btn.getBoundingClientRect();
  // 捕获指针到按钮：快速拖动/移出按钮范围时 move 事件不丢。
  btn.setPointerCapture(e.pointerId);
  const start = clampToggle(rect.left - parentRect.left, rect.top - parentRect.top);
  togglePos.value = start;
  toggleDrag = {
    pointerId: e.pointerId,
    // 指针相对按钮左上角的偏移：拖拽时按钮位置 = 指针 - 偏移，保证点按不跳。
    grabDX: e.clientX - rect.left,
    grabDY: e.clientY - rect.top,
    parentLeft: parentRect.left,
    parentTop: parentRect.top,
    startClientX: e.clientX,
    startClientY: e.clientY,
    moved: false,
  };
  window.addEventListener('pointermove', onTogglePointerMove);
  window.addEventListener('pointerup', onTogglePointerUp);
  window.addEventListener('pointercancel', onTogglePointerCancel);
}
function onTogglePointerMove(e: PointerEvent) {
  if (!toggleDrag || e.pointerId !== toggleDrag.pointerId) return;
  // 超过阈值判定为拖拽（按客户端坐标，此前视为点按不更新位置以免微动就跳）。
  if (!toggleDrag.moved) {
    if (Math.hypot(e.clientX - toggleDrag.startClientX, e.clientY - toggleDrag.startClientY) < TOGGLE_DRAG_THRESHOLD) return;
    toggleDrag.moved = true;
  }
  // 按钮位置 = 指针 - 抓取偏移（保持抓取点相对按钮不动，不跳）。
  const targetX = e.clientX - toggleDrag.parentLeft - toggleDrag.grabDX;
  const targetY = e.clientY - toggleDrag.parentTop - toggleDrag.grabDY;
  const cur = togglePos.value;
  // 缓动跟随：向目标靠近（快速拖也平滑追上）。
  if (cur) {
    const nx = cur.x + (targetX - cur.x) * 0.6;
    const ny = cur.y + (targetY - cur.y) * 0.6;
    togglePos.value = clampToggle(nx, ny);
  }
}
function onTogglePointerUp(e: PointerEvent) {
  if (!toggleDrag || e.pointerId !== toggleDrag.pointerId) return;
  const moved = toggleDrag.moved;
  endToggleDrag();
  if (!moved) {
    // 点按：切换预览/编辑
    showPreview.value = !showPreview.value;
    return;
  }
  snapToggleToEdge();
}
function onTogglePointerCancel(e: PointerEvent) {
  if (!toggleDrag || e.pointerId !== toggleDrag.pointerId) return;
  endToggleDrag();
}

onMounted(async () => {
  // 初始化主题（跟随宿主深/浅色）；失败保持默认暗色，不阻塞编辑器。
  void initTheme();
  // 初始化语言（跟随宿主中/英文）；失败保持默认中文。
  void initLang();
  // 启动文件变更推送监听（外部修改后自动刷新/提示）。
  startFileWatch();
  // 恢复预览/编辑悬浮按钮的上次位置。
  loadTogglePos();
  // 注册内容 provider：store 在保存/草稿判定等关键点按 id 拉当前编辑器全文
  // （大文件性能核心——编辑期不逐键同步，全文只在关键点单次拉取）。
  store.setContentProvider((id) => id === mountedId && view ? view.state.doc.toString() : null);
  // 拉取后端偏好（菜单设置/上次保存目录）并恢复上次会话的标签。
  // 失败不阻塞：各项回落 localStorage 缓存/默认值。
  await store.initPrefs();
  const p = pathFromLocation();
  if (p) {
    // URL ?path= 优先（文件管理器右键打开）：直接打开该文件，会话其余标签仍在。
    await store.openFile(p);
  }
  // 无 path：显示恢复的最近会话；无最近打开文件则直接显示空白页
  // （不自动新建草稿），由用户双击空白处或点「＋」新建。
});
</script>

<template>
  <div class="app">
    <MenuBar
      @find="onMenuFind"
      @about="showAbout = true"
      @clipboard="onMenuClipboard"
    />

    <div class="body">
      <div class="main">
        <TabBar v-if="store.tabs.length" />
        <div class="editor-area">
          <!-- 编辑区右键：自定义 复制/剪切/粘贴/全选（空白页走浏览器默认菜单） -->
          <!-- 预览态：整个编辑区被预览替换（editor-pane 隐藏），点铅笔回到源码 -->
          <div class="editor-pane" v-show="!previewShowing" @contextmenu="onEditorContextmenu">
            <div id="editor-host" class="editor-host" />
            <!-- 空白页：双击新建页签（pointer-events 仅开在占位层，双击热区=整块空白） -->
            <!-- booting 期间不渲染欢迎语：会话恢复慢时避免「欢迎页闪一下→标签冒出」 -->
            <div v-if="!store.booting && !store.activeTab" class="placeholder" @dblclick="store.newUntitled()">
              <div class="placeholder-title">{{ t('welcomeTitle') }}</div>
              <div class="placeholder-sub">{{ t('welcomeSub') }}</div>
              <div class="placeholder-hint">{{ t('placeholderDblClick') }}</div>
            </div>
            <!-- 恢复中：骨架态，不显示任何「空」文案（避免误以为没有文件） -->
            <div v-else-if="store.booting" class="placeholder booting">
              <div class="placeholder-hint">{{ t('loading') }}</div>
            </div>
          </div>
          <!-- 预览态：填满整个编辑区（editor-pane 已 v-show 隐藏）；无标题栏，眼/笔按钮切回编辑 -->
          <!-- 预览页右键：只有「复制」（复制选中文本），无剪切/粘贴（预览不可编辑） -->
          <div v-if="showPreview && store.activeTab?.previewKind" class="preview-full" @contextmenu="onPreviewContextmenu">
            <PreviewPanel
              :tab-id="store.activeTab.id"
              :kind="store.activeTab.previewKind"
              :content="store.activeTab.content"
              :base-dir="store.activeTab.path.replace(/[\\/][^\\/]*$/, '')"
            />
          </div>
          <!-- 眼睛/铅笔：预览/编辑切换（仅可预览类型 md/htm/html 显示），悬浮可拖拽、吸附左右边缘、位置持久化 -->
          <button
            v-if="store.activeTab?.previewKind"
            ref="toggleBtn"
            class="preview-toggle"
            :class="{ dragging: toggleDrag?.moved }"
            :style="togglePos ? { left: togglePos.x + 'px', top: togglePos.y + 'px', right: 'auto' } : undefined"
            :title="showPreview ? t('toggleEdit') : t('togglePreview')"
            @pointerdown="onTogglePointerDown"
          >
            <!-- 铅笔：返回编辑（实心斜铅笔） -->
            <svg v-if="showPreview" class="pv-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.995.995 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
            </svg>
            <!-- 眼睛：进入预览 -->
            <svg v-else class="pv-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 无活动页签（空白页）时整个状态栏隐藏，不显示「未打开文件」 -->
    <!-- 状态栏只做文件信息展示（路径/编码/行尾/行列/大小）；任何提示一律走 toast -->
    <footer v-if="store.activeTab" class="statusbar">
      <span class="sb-path" :title="store.activePath">{{ store.activePath }}</span>
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

    <!-- 编辑区右键菜单（复制/剪切/粘贴/全选） -->
    <ContextMenu
      v-if="editorCtx"
      :x="editorCtx.x"
      :y="editorCtx.y"
      :items="editorCtxItems"
      @close="editorCtx = null"
    />

    <!-- 预览区右键菜单（只有复制） -->
    <ContextMenu
      v-if="previewCtx"
      :x="previewCtx.x"
      :y="previewCtx.y"
      :items="previewCtxItems"
      @close="previewCtx = null"
    />

    <AppModal v-if="showAbout" :title="'OmniEdit'" :width="360" @close="showAbout = false">
      <div>{{ t('welcomeSub') }}</div>
      <div class="dim">v{{ appVersion }}</div>
      <template #footer>
        <button class="btn" @click="showAbout = false">{{ t('cancel') }}</button>
      </template>
    </AppModal>
  </div>
</template>
