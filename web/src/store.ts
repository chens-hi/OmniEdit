import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { readFile, writeFile, unwatchFile, type FileMeta } from './api';
import { sdk } from './api';
import { t } from './i18n';

// ---- 编辑器设置（菜单栏驱动，localStorage 持久化） ----

type IndentMode = 'spaces' | 'tabs';

function loadPref<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(`omniedit.pref.${key}`);
    return v === null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
}

function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem(`omniedit.pref.${key}`, JSON.stringify(v));
  } catch { /* 存储失败不影响功能 */ }
}

let untitledSeq = 0;

/**
 * detectIndent 检测文件缩进风格与宽度（状态栏展示用，打开时检测一次，编辑中
 * 不重算——与 VS Code 行为一致）。
 *
 * 风格判定：行首扫描跳过空行——"\t" 开头计 tab，2+ 空格开头计 space（单空格
 * 通常是续行排版，不算缩进）；两者并存且各 ≥10% → mixed，否则多者胜，全 0 →
 * spaces（编辑器默认行为）。
 *
 * 宽度判定（标准做法：Spaces: N / Tab: N）：
 *   - spaces/mixed → 空格计数的**最小值**即缩进单元（2/4 空格文件的 min 就是
 *     单元；对齐用空格不会小于真单元），clamp 1..8，无样本时 4；
 *   - tabs → 渲染宽度按 CodeMirror 默认 tabSize=4 展示（内容检测不出渲染宽度）。
 */
function detectIndent(content: string): { style: 'spaces' | 'tabs' | 'mixed'; width: number } {
  let tabs = 0;
  let spaces = 0;
  let minSpaceUnit = Number.MAX_SAFE_INTEGER;
  for (const line of content.split('\n')) {
    if (!line.length) continue;
    if (line[0] === '\t') { tabs++; continue; }
    let sp = 0;
    while (sp < line.length && line[sp] === ' ') sp++;
    if (sp >= 2) {
      spaces++;
      if (sp < minSpaceUnit) minSpaceUnit = sp;
    }
  }
  if (tabs === 0 && spaces === 0) return { style: 'spaces', width: 4 };
  const total = tabs + spaces;
  const mixed = tabs > 0 && spaces > 0 && tabs / total >= 0.1 && spaces / total >= 0.1;
  const style = mixed ? 'mixed' : tabs > spaces ? 'tabs' : 'spaces';
  const width = style === 'tabs'
    ? 4
    : Math.min(8, Math.max(1, minSpaceUnit === Number.MAX_SAFE_INTEGER ? 4 : minSpaceUnit));
  return { style, width };
}

/** 标签自增 id：path 可能为空（无标题草稿），不能再用 path 作 key。 */
let tabSeq = 0;

/** 一个已打开/新建的编辑标签。path 为空 = 无标题草稿（尚未落盘）。 */
export interface Tab {
  id: number;
  path: string;
  name: string;
  content: string;
  mtime: string;       // 服务端 mtime，用于冲突检测；草稿为空
  dirty: boolean;
  isMarkdown: boolean;
  loading: boolean;
  /** 只读（超大文件截断预览时为 true，禁止保存）。 */
  readonly: boolean;
  /** 原文件带 UTF-8 BOM，保存时回传保持。 */
  hasBom: boolean;
  /** 原文件编码（utf-8 / utf-8-bom / gb18030），保存时回传。 */
  encoding: string;
  /** 行尾风格（后端识别："lf" | "crlf" | "mixed" | ""）。状态栏展示。 */
  lineEnding: string;
  /** 缩进风格（打开时前端检测）。状态栏展示。 */
  indent: 'spaces' | 'tabs' | 'mixed';
  /** 缩进宽度：spaces/mixed = 检测到的空格单元；tabs = 渲染宽度（固定 4）。 */
  indentWidth: number;
}

export const useEditorStore = defineStore('editor', () => {
  const tabs = ref<Tab[]>([]);
  const activeId = ref<number>(0);
  const error = ref<string>('');
  const status = ref<string>(t('ready'));

  // ---- 编辑器设置（菜单栏驱动） ----
  const indentMode = ref<IndentMode>(loadPref<IndentMode>('indentMode', 'spaces'));
  const indentWidth = ref<number>(loadPref<number>('indentWidth', 4));
  const fontSize = ref<number>(loadPref<number>('fontSize', 14));
  const lineWrapping = ref<boolean>(loadPref<boolean>('lineWrapping', false));
  const showLineNumbers = ref<boolean>(loadPref<boolean>('showLineNumbers', true));

  function setIndentMode(mode: IndentMode, width: number) {
    indentMode.value = mode;
    indentWidth.value = width;
    savePref('indentMode', mode);
    savePref('indentWidth', width);
  }
  /** 空格宽度循环 2→4→8→2（菜单「缩进」项点击）。 */
  function cycleIndentWidth() {
    const seq = [2, 4, 8];
    const idx = seq.indexOf(indentWidth.value);
    const next = idx === -1 ? 2 : seq[(idx + 1) % seq.length];
    setIndentMode('spaces', next);
  }
  /** 字体大小循环 12→14→16→18→20→12（菜单「字号」项点击）。 */
  function cycleFontSize() {
    const seq = [12, 14, 16, 18, 20];
    const idx = seq.indexOf(fontSize.value);
    setFontSize(seq[(idx + 1) % seq.length]);
  }
  function setFontSize(px: number) {
    fontSize.value = px;
    savePref('fontSize', px);
  }
  function setLineWrapping(on: boolean) {
    lineWrapping.value = on;
    savePref('lineWrapping', on);
  }
  function setShowLineNumbers(on: boolean) {
    showLineNumbers.value = on;
    savePref('showLineNumbers', on);
  }

  /** 通过宿主文件选择器打开文件（菜单「打开…」；dev 降级 prompt 输路径）。 */
  async function openViaPicker() {
    let picked: string | null = null;
    if (sdk.isStandaloneWeb) {
      picked = window.prompt(t('promptOpenPath'), '');
    } else {
      try {
        const res = await sdk.pickUserFile({
          directory: false,
          title: t('menuOpen'),
        });
        if (res && typeof res === 'object') {
          const r = res as Record<string, unknown>;
          const data = r.data ?? res;
          if (Array.isArray(data)) {
            picked = data.find((x): x is string => typeof x === 'string' && x.length > 0) ?? null;
          } else if (typeof data === 'string') {
            picked = data;
          }
        }      } catch {
        return; // 取消/宿主异常
      }
    }
    if (picked) void openFile(picked);
  }

  const activeTab = computed(() => tabs.value.find(tb => tb.id === activeId.value));
  /** 兼容旧模板引用：当前活动标签的 path（草稿为空串）。 */
  const activePath = computed(() => activeTab.value?.path ?? '');

  function tabById(id: number) {
    return tabs.value.find(tb => tb.id === id);
  }

  function setError(msg: string) {
    error.value = msg;
    if (msg) status.value = t('error');
  }

  function newUntitled(): Tab {
    untitledSeq += 1;
    const draft: Tab = {
      id: ++tabSeq,
      path: '',
      name: `${t('untitled')}${untitledSeq > 1 ? ` (${untitledSeq})` : ''}`,
      content: '', mtime: '',
      dirty: false, isMarkdown: false, loading: false, readonly: false,
      hasBom: false,
      encoding: 'utf-8',
      lineEnding: '',
      indent: 'spaces',
      indentWidth: 4,
    };
    tabs.value.push(draft);
    const tab = tabById(draft.id)!;
    activeId.value = tab.id;
    return tab;
  }

  /** 打开文件（已打开则激活）。 */
  async function openFile(path: string) {
    setError('');
    const existing = tabs.value.find(tb => tb.path === path);
    if (existing) {
      activeId.value = existing.id;
      return;
    }
    const draft: Tab = {
      id: ++tabSeq, path, name: fileNameOf(path), content: '', mtime: '',
      dirty: false, isMarkdown: isMd(path), loading: true, readonly: false,
      hasBom: false,
      encoding: 'utf-8',
      lineEnding: '',
      indent: 'spaces',
      indentWidth: 4,
    };
    // 先 push 占位、再用 tabs 数组里的响应式代理更新字段。
    // 关键：直接改 draft（原始对象）不会经过 Vue 的响应式代理，模板与
    // App.vue 的 watch 全都感知不到（真机上表现为「标签在、内容永远空」）。
    tabs.value.push(draft);
    const tab = tabById(draft.id)!;
    activeId.value = tab.id;
    try {
      const { file } = await readFile(path);
      if (file.tooLarge) {
        tabs.value = tabs.value.filter(x => x.id !== tab.id);
        if (activeId.value === tab.id) activeId.value = tabs.value[tabs.value.length - 1]?.id ?? 0;
        const ok = window.confirm(
          `「${fileNameOf(path)}」${(file.size / 1024 / 1024).toFixed(1)} MB — ${t('largeFileConfirm')}`,
        );
        if (!ok) {
          status.value = t('ready');
          return;
        }
        const previewDraft: Tab = {
          id: ++tabSeq, path, name: fileNameOf(path), content: '', mtime: '',
          dirty: false, isMarkdown: isMd(path), loading: true, readonly: true,
          hasBom: false,
          encoding: 'utf-8',
          lineEnding: '',
          indent: 'spaces',
          indentWidth: 4,
        };
        tabs.value.push(previewDraft);
        const previewTab = tabById(previewDraft.id)!;
        activeId.value = previewTab.id;
        const res = await readFile(path, true);
        previewTab.content = res.file.content;
        previewTab.mtime = res.file.mtime;
        previewTab.loading = false;
        previewTab.readonly = true;
        status.value = `${t('opened')} ${res.file.displayPath ?? res.file.path}（${t('readOnlyPreview')}）`;
        return;
      }
      tab.content = file.content;
      tab.mtime = file.mtime;
      tab.loading = false;
      tab.readonly = file.truncated === true;
      tab.hasBom = file.encoding === 'utf-8-bom';
      tab.encoding = file.encoding ?? 'utf-8';
      tab.lineEnding = file.lineEnding ?? '';
      const det = detectIndent(file.content);
      tab.indent = det.style;
      tab.indentWidth = det.width;
      status.value = `${t('opened')} ${file.displayPath ?? file.path}`;
    } catch (e) {
      tabs.value = tabs.value.filter(tb => tb.id !== tab.id);
      if (activeId.value === tab.id) activeId.value = tabs.value[tabs.value.length - 1]?.id ?? 0;
      setError(`${t('openFailed')}: ${(e as Error).message.includes('UTF-8') ? t('notUtf8') : (e as Error).message}`);
    }
  }

  /** 另存为对话框状态：可见性与目标标签（草稿）。 */
  const saveAsVisible = ref(false);
  /** 上次保存目录（localStorage 持久化，第二次另存免重选）。 */
  const lastSaveDir = ref(localStorage.getItem('omniedit.lastSaveDir') ?? '');

  /** 保存当前活动标签：草稿/无路径 → 打开另存为对话框；否则直存。 */
  async function saveActive() {
    const tab = activeTab.value;
    if (!tab || tab.readonly) return;
    setError('');
    if (!tab.path) {
      // 打开对话框（内容由组件确认后回调 doSaveAs）。
      saveAsVisible.value = true;
      return;
    }
    try {
      const { mtime } = await writeFile(tab.path, tab.content, tab.mtime, tab.hasBom, tab.encoding);
      tab.mtime = mtime;
      tab.dirty = false;
      status.value = t('saved');
    } catch (e) {
      setError(`${t('saveFailed')}: ${(e as Error).message}`);
    }
  }

  /** 另存为对话框确认：写入目标路径并绑定标签。 */
  async function doSaveAs(target: string) {
    const tab = activeTab.value;
    if (!tab) return;
    saveAsVisible.value = false;
    try {
      const { mtime } = await writeFile(target, tab.content, '', tab.hasBom, tab.encoding);
      lastSaveDir.value = target.replace(/[\\/][^\\/]+$/, '');
      localStorage.setItem('omniedit.lastSaveDir', lastSaveDir.value);
      // tab 来自 activeTab computed（响应式代理），赋值安全。
      tab.path = target;
      tab.name = fileNameOf(target);
      tab.isMarkdown = isMd(target);
      tab.mtime = mtime;
      tab.dirty = false;
      status.value = `${t('saved')} ${target}`;
    } catch (e) {
      setError(`${t('saveFailed')}: ${(e as Error).message}`);
    }
  }

  function closeSaveAs() {
    saveAsVisible.value = false;
  }

  function closeTab(id: number) {
    const tab = tabById(id);
    if (!tab) return;
    if (tab.dirty && !window.confirm(`${tab.name} ${t('confirmCloseDirty')}`)) return;
    const idx = tabs.value.findIndex(tb => tb.id === id);
    tabs.value.splice(idx, 1);
    if (activeId.value === id) {
      activeId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? 0;
    }
    // 草稿从未落盘无需 unwatch；已打开文件通知后端释放监控。失败忽略。
    if (tab.path) void unwatchFile(tab.path).catch(() => {});
  }

  /**
   * 从磁盘重新加载某文件内容（外部变更后刷新）。
   * 成功返回 true；文件不可读或已删除返回 false。
   */
  async function reloadFile(path: string): Promise<boolean> {
    const tab = tabs.value.find(tb => tb.path === path);
    if (!tab) return false;
    try {
      const { file } = await readFile(path);
      tab.content = file.content;
      tab.mtime = file.mtime;
      tab.dirty = false;
      tab.readonly = file.truncated === true;
      tab.hasBom = file.encoding === 'utf-8-bom';
      tab.encoding = file.encoding ?? 'utf-8';
      tab.lineEnding = file.lineEnding ?? '';
      const det = detectIndent(file.content);
      tab.indent = det.style;
      tab.indentWidth = det.width;
      return true;
    } catch {
      return false;
    }
  }

  function markDirty(id: number, content: string) {
    const tab = tabById(id);
    if (tab) {
      tab.content = content;
      tab.dirty = true;
    }
  }

  return {
    tabs, activeId, activeTab, activePath, error, status,
    saveAsVisible, lastSaveDir,
    indentMode, indentWidth, fontSize, lineWrapping, showLineNumbers,
    setIndentMode, setFontSize, setLineWrapping, setShowLineNumbers,
    cycleIndentWidth, cycleFontSize,
    openViaPicker,
    openFile, saveActive, closeTab, markDirty, newUntitled, setError,
    doSaveAs, closeSaveAs,
    reloadFile, tabById,
  };
});

function fileNameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function isMd(path: string): boolean {
  const ext = fileNameOf(path).split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
}

export type { FileMeta };
