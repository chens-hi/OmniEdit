import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { readFile, writeFile, unwatchFile, getPrefs, putPrefs, type FileMeta } from './api';
import { sdk } from './api';
import { t } from './i18n';
import { BUILTIN_FONTS, DEFAULT_FONT_ID, applyEditorFont } from './fonts';

// ---- 编辑器设置（菜单栏驱动；后端 prefs 唯一持久化源，无 localStorage 兜底） ----

type IndentMode = 'spaces' | 'tabs';

/** 配置项 KEY 常量：统一管理，禁止散落字符串字面量（防手滑拼错）。 */
export const PREF_KEYS = {
  indentMode: 'indentMode',
  indentWidth: 'indentWidth',
  fontSize: 'fontSize',
  fontFamily: 'fontFamily', // 存的是字体 id（BUILTIN_FONTS），与 CSS font-family 语义对齐
  lineWrapping: 'lineWrapping',
  showLineNumbers: 'showLineNumbers',
  showSpaces: 'showSpaces',
  showTabs: 'showTabs',
  showLineBreaks: 'showLineBreaks',
  lastSaveDir: 'lastSaveDir',
} as const;

/** 默认值：与 KEY 对齐，一屏看全所有配置项（单一事实来源）。 */
export const PREF_DEFAULTS = {
  indentMode: 'spaces' as IndentMode,
  indentWidth: 4,
  fontSize: 16,
  fontFamily: DEFAULT_FONT_ID, // 默认 JetBrains Mono
  lineWrapping: true,
  showLineNumbers: true,
  showSpaces: false,
  showTabs: false,
  showLineBreaks: false,
  lastSaveDir: '',
};

export type PrefKey = keyof typeof PREF_KEYS;

/**
 * 单窗口最大标签数（VS Code 同思路：到上限提示阻止新开，绝不自动关闭）。
 * 动机：内存本身炸不了（超大文件有 256KB 截断，20 标签最坏 ~10MB），真正的
 * 风险是 session.tabs 路径列表把 prefs 撑破 64KB 上限、以及 DOM/可用性。
 */
export const MAX_TABS = 20;

/** 会话 KEY：记录「打开未关闭」的标签，下次自动恢复（VS Code 式会话还原）。 */
const SESSION_KEY = 'session';
const SESSION_TABS = 'tabs';
const SESSION_ACTIVE = 'activePath';

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

  // ---- 编辑器设置（菜单栏驱动；初值一律 = 默认值，initPrefs 再用后端值覆盖） ----
  const indentMode = ref<IndentMode>(PREF_DEFAULTS.indentMode);
  const indentWidth = ref<number>(PREF_DEFAULTS.indentWidth);
  const fontSize = ref<number>(PREF_DEFAULTS.fontSize);
  // 编辑器字体（存 fontFamily = 字体 id，引用 fonts.ts 内置注册表；应用 = 写 --font-mono 变量）
  const fontFamily = ref<string>(PREF_DEFAULTS.fontFamily);
  const lineWrapping = ref<boolean>(PREF_DEFAULTS.lineWrapping);
  const showLineNumbers = ref<boolean>(PREF_DEFAULTS.showLineNumbers);
  // 空白符号可见化（Notepad++「显示符号」风格）
  const showSpaces = ref<boolean>(PREF_DEFAULTS.showSpaces);
  const showTabs = ref<boolean>(PREF_DEFAULTS.showTabs);
  const showLineBreaks = ref<boolean>(PREF_DEFAULTS.showLineBreaks);

  /**
   * prefsSnapshot 把当前全部偏好收敛成一个对象（后端整体覆盖写回的最小单元）。
   * KEY 引用常量，新增配置项时在此补一行即可，避免漏存。
   */
  function prefsSnapshot(): Record<string, unknown> {
    return {
      [PREF_KEYS.indentMode]: indentMode.value,
      [PREF_KEYS.indentWidth]: indentWidth.value,
      [PREF_KEYS.fontSize]: fontSize.value,
      [PREF_KEYS.fontFamily]: fontFamily.value,
      [PREF_KEYS.lineWrapping]: lineWrapping.value,
      [PREF_KEYS.showLineNumbers]: showLineNumbers.value,
      [PREF_KEYS.showSpaces]: showSpaces.value,
      [PREF_KEYS.showTabs]: showTabs.value,
      [PREF_KEYS.showLineBreaks]: showLineBreaks.value,
      [PREF_KEYS.lastSaveDir]: lastSaveDir.value,
    };
  }

  /** 后端是否可达（null=未探测）。initPrefs 时探测，供诊断/提示用。 */
  const prefsBackendOk = ref<boolean | null>(null);

  /**
   * persistPrefs 把当前偏好 fire-and-forget 推到后端（跨浏览器共享）。
   * 后端失败静默——编辑器不因偏好存储故障而不可用，下次改动会重试。
   */
  function persistPrefs() {
    putPrefs(prefsSnapshot())
      .then(() => { prefsBackendOk.value = true; })
      .catch(() => { prefsBackendOk.value = false; });
  }

  function setIndentMode(mode: IndentMode, width: number) {
    indentMode.value = mode;
    indentWidth.value = width;
    persistPrefs();
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
    persistPrefs();
  }
  /** 编辑器字体：切到指定内置字体，即时应用（写 --font-mono）并持久化。 */
  function setFontFamily(id: string) {
    fontFamily.value = BUILTIN_FONTS.some(f => f.id === id) ? id : DEFAULT_FONT_ID;
    applyEditorFont(fontFamily.value);
    persistPrefs();
  }
  /** 字体循环切换（菜单「字体」项点击）：按内置清单顺序循环。 */
  function cycleFont() {
    const idx = BUILTIN_FONTS.findIndex(f => f.id === fontFamily.value);
    const next = BUILTIN_FONTS[(idx + 1) % BUILTIN_FONTS.length];
    setFontFamily(next.id);
  }
  function setLineWrapping(on: boolean) {
    lineWrapping.value = on;
    persistPrefs();
  }
  function setShowLineNumbers(on: boolean) {
    showLineNumbers.value = on;
    persistPrefs();
  }
  function setShowSpaces(on: boolean) {
    showSpaces.value = on;
    persistPrefs();
  }
  function setShowTabs(on: boolean) {
    showTabs.value = on;
    persistPrefs();
  }
  function setShowLineBreaks(on: boolean) {
    showLineBreaks.value = on;
    persistPrefs();
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

  function newUntitled(): Tab | null {
    // 标签数上限：拒绝新开（提示在状态栏），绝不自动关闭已有标签。
    if (tabs.value.length >= MAX_TABS) {
      setError(t('tabLimitReached').replace('{n}', String(MAX_TABS)));
      return null;
    }
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

  /** 打开文件（已打开则激活；标签数达上限时拒绝并提示）。 */
  async function openFile(path: string) {
    setError('');
    const existing = tabs.value.find(tb => tb.path === path);
    if (existing) {
      activeId.value = existing.id;
      return;
    }
    if (tabs.value.length >= MAX_TABS) {
      setError(t('tabLimitReached').replace('{n}', String(MAX_TABS)));
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
        const ok = await confirm(
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
    // 打开/打开失败都会改变标签集 → 即时持久化会话（restoreGuard 期间跳过）。
    persistSession();
  }

  /** 另存为对话框状态：可见性与目标标签（草稿）。 */
  const saveAsVisible = ref(false);
  /** 上次保存目录（走 prefs 持久化，第二次另存免重选；跨浏览器共享）。 */
  const lastSaveDir = ref<string>(PREF_DEFAULTS.lastSaveDir);

  // ---- 统一确认对话框（替代 window.confirm，Promise 化）----
  const confirmDialog = ref<{
    visible: boolean;
    message: string;
    title?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }>({ visible: false, message: '' });
  let confirmResolver: ((ok: boolean) => void) | null = null;

  /**
   * confirm 弹出统一确认框，返回 Promise<boolean>（确定=true / 取消=false）。
   * 用法：`if (!(await store.confirm('确定删除？'))) return;`
   * 替代原生 window.confirm，外观与应用主题一致。
   */
  function confirm(
    message: string,
    opts: { title?: string; confirmText?: string; cancelText?: string; danger?: boolean } = {},
  ): Promise<boolean> {
    // 若已有未决的确认框，先以 false 结清（理论上单例不会并发，防御性处理）。
    if (confirmResolver) { confirmResolver(false); confirmResolver = null; }
    confirmDialog.value = {
      visible: true,
      message,
      title: opts.title,
      confirmText: opts.confirmText,
      cancelText: opts.cancelText,
      danger: opts.danger,
    };
    return new Promise<boolean>(resolve => { confirmResolver = resolve; });
  }

  /** ConfirmDialog 回调：结算 Promise 并关闭。 */
  function settleConfirm(ok: boolean) {
    confirmDialog.value.visible = false;
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve?.(ok);
  }

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
      persistPrefs();
      // tab 来自 activeTab computed（响应式代理），赋值安全。
      tab.path = target;
      tab.name = fileNameOf(target);
      tab.isMarkdown = isMd(target);
      tab.mtime = mtime;
      tab.dirty = false;
      status.value = `${t('saved')} ${target}`;
      // 草稿落盘后成为会话一员（有路径）→ 持久化会话。
      persistSession();
    } catch (e) {
      setError(`${t('saveFailed')}: ${(e as Error).message}`);
    }
  }

  function closeSaveAs() {
    saveAsVisible.value = false;
  }

  async function closeTab(id: number) {
    const tab = tabById(id);
    if (!tab) return;
    if (tab.dirty && !(await confirm(`${tab.name} ${t('confirmCloseDirty')}`, { danger: true }))) return;
    const idx = tabs.value.findIndex(tb => tb.id === id);
    tabs.value.splice(idx, 1);
    if (activeId.value === id) {
      activeId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? 0;
    }
    // 草稿从未落盘无需 unwatch；已打开文件通知后端释放监控。失败忽略。
    if (tab.path) void unwatchFile(tab.path).catch(() => {});
    // 标签集变化 → 持久化会话。
    persistSession();
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

  // ---- 会话恢复：记录「打开未关闭」的标签，下次自动还原（VS Code 式） ----

  /** restoreGuard=true 期间不回写会话，避免恢复过程把中间态当作用户操作存盘。 */
  let restoreGuard = false;

  /**
   * sessionSnapshot 取当前会话（已落盘标签的路径 + 活动标签）。
   * 无路径草稿（未保存的无标题）不记——没内容可恢复。
   */
  function sessionSnapshot(): Record<string, unknown> | null {
    const paths = tabs.value.filter(tb => tb.path).map(tb => tb.path);
    const active = activeTab.value;
    const activePath = active && active.path ? active.path : (paths[paths.length - 1] ?? '');
    if (!paths.length) return { [SESSION_TABS]: [], [SESSION_ACTIVE]: '' };
    return { [SESSION_TABS]: paths, [SESSION_ACTIVE]: activePath };
  }

  /**
   * persistSession 把会话快照并入偏好整体写回。
   * 直接改 tabs/activeId 后调用（openFile/closeTab/doSaveAs），即操作即存，
   * 不依赖页面卸载（浏览器 unload 阶段 fetch 不可靠）。
   */
  function persistSession() {
    if (restoreGuard) return;
    const snap = prefsSnapshot();
    const sess = sessionSnapshot();
    if (sess) {
      snap[SESSION_KEY] = sess;
    }
    putPrefs(snap)
      .then(() => { prefsBackendOk.value = true; })
      .catch(() => { prefsBackendOk.value = false; });
  }

  /**
   * initPrefs 启动时从后端拉偏好并恢复会话。
   * 顺序：先取偏好填充各项 → 再按 session.tabs 逐个 openFile → 定位活动标签。
   * 返回是否存在可恢复的会话，供 App.vue 决定是否还要打开 URL ?path= 或新建草稿。
   * 后端失败/首次无数据：各项保持默认值（localStorage 已移除，后端是唯一持久化源）。
   */
  async function initPrefs(): Promise<{ hasSession: boolean; activePath: string }> {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = await getPrefs();
      prefsBackendOk.value = true;
    } catch {
      prefsBackendOk.value = false;
    }
    if (Object.keys(prefs).length) {
      // 后端值覆盖默认值（缺字段保留当前默认，做字段级兼容）。
      const pick = <T,>(key: PrefKey, cur: T): T =>
        (key in prefs && prefs[key] !== undefined && prefs[key] !== null ? prefs[key] as T : cur);
      indentMode.value = pick(PREF_KEYS.indentMode, indentMode.value);
      indentWidth.value = pick(PREF_KEYS.indentWidth, indentWidth.value);
      fontSize.value = pick(PREF_KEYS.fontSize, fontSize.value);
      // 字段迁移：旧版用 fontStyle 存字体 id，现改 fontFamily。新键缺失时回落读旧键，
      // 保证升级前设置过字体的用户不丢配置（写回统一用新键，旧键随覆盖自然淘汰）。
      const legacyFont = typeof prefs['fontStyle'] === 'string' ? prefs['fontStyle'] as string : undefined;
      fontFamily.value = pick(PREF_KEYS.fontFamily, legacyFont ?? fontFamily.value);
      applyEditorFont(fontFamily.value);
      lineWrapping.value = pick(PREF_KEYS.lineWrapping, lineWrapping.value);
      showLineNumbers.value = pick(PREF_KEYS.showLineNumbers, showLineNumbers.value);
      showSpaces.value = pick(PREF_KEYS.showSpaces, showSpaces.value);
      showTabs.value = pick(PREF_KEYS.showTabs, showTabs.value);
      showLineBreaks.value = pick(PREF_KEYS.showLineBreaks, showLineBreaks.value);
      lastSaveDir.value = pick(PREF_KEYS.lastSaveDir, lastSaveDir.value);
    }

    // 恢复会话：后端 session（唯一来源）。旧版本会话可能超过标签上限：
    // 按上限裁剪恢复，超限时回写一次收敛持久化体积（否则 prefs 持续超限）。
    const sess = (prefs[SESSION_KEY] ?? null) as
      | { [SESSION_TABS]?: string[]; [SESSION_ACTIVE]?: string }
      | null;
    const allPaths = Array.isArray(sess?.[SESSION_TABS]) ? sess![SESSION_TABS]! : [];
    const paths = allPaths.slice(0, MAX_TABS);
    if (!paths.length) return { hasSession: false, activePath: '' };

    restoreGuard = true;
    let want = sess?.[SESSION_ACTIVE] ?? '';
    try {
      for (const p of paths) {
        // 逐个 await：openFile 内部 push 占位再异步填内容，串行保证顺序与 activeId 稳定。
        await openFile(p);
      }
      const target = tabs.value.find(tb => tb.path === want)
        ?? tabs.value[tabs.value.length - 1];
      if (target) activeId.value = target.id;
      else want = '';
    } finally {
      restoreGuard = false;
    }
    if (allPaths.length > MAX_TABS) persistSession();
    return { hasSession: true, activePath: want || paths[paths.length - 1] };
  }

  /**
   * resetToDefaults 还原到初始状态：全部偏好回默认值、关闭所有标签、
   * 清空会话与 lastSaveDir，并把空偏好写回后端（清空持久化，下次启动即默认）。
   * 后端失败不阻塞——本地状态已重置，下次改动会以当前（默认）值重写后端。
   * 返回是否成功推到后端（供 UI 提示，失败不回滚本地重置）。
   */
  async function resetToDefaults(): Promise<boolean> {
    // 关闭全部标签（含未保存草稿——还原初始状态本就丢弃一切，无需逐个 confirm）。
    // 先释放后端文件监控，再清空。
    for (const tb of [...tabs.value]) {
      if (tb.path) void unwatchFile(tb.path).catch(() => {});
    }
    tabs.value = [];
    activeId.value = 0;

    // 全部偏好 ref 回默认值。
    indentMode.value = PREF_DEFAULTS.indentMode;
    indentWidth.value = PREF_DEFAULTS.indentWidth;
    fontSize.value = PREF_DEFAULTS.fontSize;
    fontFamily.value = PREF_DEFAULTS.fontFamily;
    applyEditorFont(fontFamily.value);
    lineWrapping.value = PREF_DEFAULTS.lineWrapping;
    showLineNumbers.value = PREF_DEFAULTS.showLineNumbers;
    showSpaces.value = PREF_DEFAULTS.showSpaces;
    showTabs.value = PREF_DEFAULTS.showTabs;
    showLineBreaks.value = PREF_DEFAULTS.showLineBreaks;
    lastSaveDir.value = PREF_DEFAULTS.lastSaveDir;

    // 后端写回空对象 = 清空持久化偏好与会话（下次 initPrefs 走默认值）。
    let ok = false;
    try {
      await putPrefs({});
      prefsBackendOk.value = true;
      ok = true;
    } catch {
      prefsBackendOk.value = false;
    }

    // 回到初始界面：一个空白无标题草稿。
    untitledSeq = 0;
    newUntitled();
    status.value = t('resetDone');
    return ok;
  }

  return {
    tabs, activeId, activeTab, activePath, error, status,
    saveAsVisible, lastSaveDir,
    confirmDialog, confirm, settleConfirm,
    indentMode, indentWidth, fontSize, fontFamily, lineWrapping, showLineNumbers,
    showSpaces, showTabs, showLineBreaks,
    setIndentMode, setFontSize, setFontFamily, setLineWrapping, setShowLineNumbers,
    setShowSpaces, setShowTabs, setShowLineBreaks,
    cycleIndentWidth, cycleFontSize, cycleFont,
    builtinFonts: BUILTIN_FONTS,
    openViaPicker,
    openFile, saveActive, closeTab, markDirty, newUntitled, setError,
    doSaveAs, closeSaveAs,
    reloadFile, tabById,
    initPrefs, persistSession, prefsBackendOk, resetToDefaults,
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
