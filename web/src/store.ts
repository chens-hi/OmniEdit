import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { readFile, writeFile, unwatchFile, getPrefs, putPrefs, type FileMeta } from './api';
import { sdk } from './api';
import { t } from './i18n';
import { BUILTIN_FONTS, DEFAULT_FONT_ID, applyEditorFont } from './fonts';
import { setThemeOverride, type ThemeMode } from './theme';

// ---- 编辑器设置（菜单栏驱动；后端 prefs 唯一持久化源，无 localStorage 兜底） ----

type IndentMode = 'spaces' | 'tabs';

/** 配置项 KEY 常量：统一管理，禁止散落字符串字面量（防手滑拼错）。 */
export const PREF_KEYS = {
  indentMode: 'indentMode',
  indentWidth: 'indentWidth',
  fontSize: 'fontSize',
  fontFamily: 'fontFamily', // 存的是字体 id（BUILTIN_FONTS），与 CSS font-family 语义对齐
  themeMode: 'themeMode', // 主题模式：auto=跟随宿主系统，light/dark=用户强制指定
  lineWrapping: 'lineWrapping',
  showLineNumbers: 'showLineNumbers',
  showSpaces: 'showSpaces',
  showTabs: 'showTabs',
  showLineBreaks: 'showLineBreaks',
  autoPreview: 'autoPreview',
  lastSaveDir: 'lastSaveDir',
} as const;

/** 默认值：与 KEY 对齐，一屏看全所有配置项（单一事实来源）。 */
export const PREF_DEFAULTS = {
  indentMode: 'spaces' as IndentMode,
  indentWidth: 4,
  fontSize: 16,
  fontFamily: DEFAULT_FONT_ID, // 默认 JetBrains Mono
  themeMode: 'auto' as ThemeMode, // 默认跟随宿主系统
  lineWrapping: true,
  showLineNumbers: true,
  showSpaces: false,
  showTabs: false,
  showLineBreaks: false,
  autoPreview: true,
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
  /** 预览渲染类型（md/htm/html 有预览，其它 null）；打开/另存时按文件名设置。 */
  previewKind: 'markdown' | 'html' | null;
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
  /**
   * 磁盘内容已被外部修改，但用户还没决定是重载还是保留。
   * 非活动页签收到变更时只置此标记（不弹框打扰），切到该页签时再询问。
   */
  externalChanged?: boolean;
  /** 询问框是否正在展示（防重入，不持久化、不参与模板渲染）。 */
  externalPrompting?: boolean;
}

export const useEditorStore = defineStore('editor', () => {
  const tabs = ref<Tab[]>([]);
  const activeId = ref<number>(0);

  // ---- 编辑器设置（菜单栏驱动；初值一律 = 默认值，initPrefs 再用后端值覆盖） ----
  const indentMode = ref<IndentMode>(PREF_DEFAULTS.indentMode);
  const indentWidth = ref<number>(PREF_DEFAULTS.indentWidth);
  const fontSize = ref<number>(PREF_DEFAULTS.fontSize);
  // 编辑器字体（存 fontFamily = 字体 id，引用 fonts.ts 内置注册表；应用 = 写 --font-mono 变量）
  const fontFamily = ref<string>(PREF_DEFAULTS.fontFamily);
  // 主题模式（auto=跟随宿主系统）：应用经 theme.ts 的 setThemeOverride
  const themeMode = ref<ThemeMode>(PREF_DEFAULTS.themeMode);
  const lineWrapping = ref<boolean>(PREF_DEFAULTS.lineWrapping);
  const showLineNumbers = ref<boolean>(PREF_DEFAULTS.showLineNumbers);
  // 空白符号可见化（Notepad++「显示符号」风格）
  const showSpaces = ref<boolean>(PREF_DEFAULTS.showSpaces);
  const showTabs = ref<boolean>(PREF_DEFAULTS.showTabs);
  const showLineBreaks = ref<boolean>(PREF_DEFAULTS.showLineBreaks);
  // 自动预览总开关（视图菜单「自动预览」勾选）：可预览类型（md/htm/html）打开/切换时按它决定是否自动显示预览。
  const autoPreview = ref<boolean>(PREF_DEFAULTS.autoPreview);

  /** restoreGuard=true 期间不写盘：恢复过程产生的中间态不是用户操作。 */
  let restoreGuard = false;

  /**
   * prefsSnapshot 把「全部偏好 + 会话」收敛成一个对象——后端整体覆盖写回的唯一单元。
   *
   * 关键约束：会话必须与偏好同源同写。历史上存在两条写路径——persistPrefs 只写
   * 偏好（不含 session）、persistSession 才带上会话；而 PUT /api/prefs 是整体
   * 覆盖写回，于是任何一次设置改动（字号/字体/主题/换行/行号/缩进/自动预览/
   * 另存目录）都会把 session 键抹掉，下次启动就读不到会话，表现为「最近打开的
   * 文件全被清空」。故此处强制合并 session，禁止再出现只写偏好的路径。
   *
   * KEY 引用常量，新增配置项时在此补一行即可，避免漏存。
   */
  function prefsSnapshot(): Record<string, unknown> {
    return {
      [PREF_KEYS.indentMode]: indentMode.value,
      [PREF_KEYS.indentWidth]: indentWidth.value,
      [PREF_KEYS.fontSize]: fontSize.value,
      [PREF_KEYS.fontFamily]: fontFamily.value,
      [PREF_KEYS.themeMode]: themeMode.value,
      [PREF_KEYS.lineWrapping]: lineWrapping.value,
      [PREF_KEYS.showLineNumbers]: showLineNumbers.value,
      [PREF_KEYS.showSpaces]: showSpaces.value,
      [PREF_KEYS.showTabs]: showTabs.value,
      [PREF_KEYS.showLineBreaks]: showLineBreaks.value,
      [PREF_KEYS.autoPreview]: autoPreview.value,
      [PREF_KEYS.lastSaveDir]: lastSaveDir.value,
      [SESSION_KEY]: sessionSnapshot(),
    };
  }

  /** 后端是否可达（null=未探测）。initPrefs 时探测，供诊断/提示用。 */
  const prefsBackendOk = ref<boolean | null>(null);

  /**
   * 启动恢复中（booting）。true 期间界面不渲染空白页欢迎语——
   * 否则会话恢复慢时用户会先看到「欢迎页闪一下」再看到标签冒出来。
   * initPrefs 结束（无论成功与否）置 false。
   */
  const booting = ref<boolean>(true);

  /** 启动时是否成功读到后端偏好（false = 服务端可能有数据但没读到，写前需补读）。 */
  let prefsLoaded = false;

  /** 补读失败计数：连续 3 次仍失败才允许盲写（见 persistAll）。 */
  let prefsReadFailures = 0;

  /**
   * writeChain 写盘串行链：偏好久会话都是整体覆盖写，并发 PUT 乱序到达时
   * 会用旧快照盖掉新快照（例如刚打开文件写入会话，紧接着的设置改动后发先至，
   * 又把会话抹回空）。串行化保证落盘顺序 = 状态演进顺序。
   */
  let writeChain: Promise<void> = Promise.resolve();

  /**
   * persistAll 把「偏好 + 会话」整体写回后端（fire-and-forget，队列串行）。
   * 后端失败静默——编辑器不因偏好存储故障而不可用，下次改动会重试。
   * 返回是否写盘成功（仅 resetToDefaults 需要等待结果，其余调用点忽略）。
   */
  function persistAll(): Promise<boolean> {
    if (restoreGuard) return Promise.resolve(false);
    const snap = prefsSnapshot();
    const p = writeChain.then(async (): Promise<boolean> => {
      // 启动补读失败时的兜底：服务端很可能存着上次的会话，直接覆盖会把它清掉。
      // 先取回来，本地会话为空（说明确实没恢复出标签）时沿用服务端的。
      if (!prefsLoaded) {
        try {
          const server = await getPrefs();
          prefsLoaded = true;
          prefsReadFailures = 0;
          const localSess = snap[SESSION_KEY] as { tabs?: string[] } | undefined;
          const serverSess = server[SESSION_KEY] as { tabs?: string[] } | undefined;
          if (!localSess?.tabs?.length && serverSess?.tabs?.length) {
            snap[SESSION_KEY] = serverSess;
          }
        } catch {
          // 仍读不到：宁可这次不写，也不拿「空会话」覆盖服务端可能存在的会话。
          // 连续失败 3 次后放行，避免后端长期异常时偏好永远无法保存（此地仍有
          // 风险，但属于「服务端已不可读」的极端场景，优先保证设置可用）。
          prefsReadFailures += 1;
          if (prefsReadFailures < 3) return false;
        }
      }
      try {
        await putPrefs(snap);
        prefsBackendOk.value = true;
        return true;
      } catch {
        prefsBackendOk.value = false;
        return false;
      }
    });
    // 队列只关心顺序，不传播失败（否则一次失败会阻断后续所有写盘）。
    writeChain = p.then(() => undefined, () => undefined);
    return p;
  }

  /** persistPrefs 兼容旧调用点：与会话同源写盘（见 prefsSnapshot 注释）。 */
  function persistPrefs() {
    persistAll();
  }

  function setIndentMode(mode: IndentMode, width: number) {
    indentMode.value = mode;
    indentWidth.value = width;
    persistPrefs();
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
  /** 主题模式：auto=跟随宿主系统；light/dark 强制指定。经 theme.ts 应用并持久化。 */
  function setThemeMode(mode: ThemeMode) {
    themeMode.value = mode;
    setThemeOverride(mode);
    persistPrefs();
  }
  /** 自动预览总开关：视图菜单「自动预览」勾选，即时生效并持久化。 */
  function setAutoPreview(on: boolean) {
    autoPreview.value = on;
    persistPrefs();
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

  /**
   * setError 报错统一走 toast。
   * 状态栏只做「文件信息展示」（路径/编码/行数/大小），不再承担任何提示——
   * 早期 status/error 双通道并存，导致同一件事有时在状态栏、有时在 toast，
   * 且状态栏在无活动标签（空白页）时整个不渲染，错误会彻底看不见。
   * 现统一为 toast 单一通道。setError 保留为语义化别名，便于调用点自解释。
   */
  function setError(msg: string) {
    if (msg) toast(msg, 'error', 6500);
  }

  function newUntitled(): Tab | null {
    // 标签数上限：拒绝新开（toast 提示），绝不自动关闭已有标签。
    if (tabs.value.length >= MAX_TABS) {
      toast(t('tabLimitReached').replace('{n}', String(MAX_TABS)), 'error');
      return null;
    }
    untitledSeq += 1;
    const draft: Tab = {
      id: ++tabSeq,
      path: '',
      name: `${t('untitled')}${untitledSeq > 1 ? ` (${untitledSeq})` : ''}`,
      content: '', mtime: '',
      dirty: false, isMarkdown: false, previewKind: null, loading: false, readonly: false,
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

  /**
   * addTabStub 只建占位标签（不发请求、不改 activeId）。
   * 会话恢复用：先把全部标签一次性铺出来，界面立刻是「标签栏 + 骨架」，
   * 而不是空白页 → 空白页 → 一个个蹦出来。
   * 已存在同路径标签则直接返回它（不重复建）。
   */
  function addTabStub(path: string): Tab {
    const existing = tabs.value.find(tb => tb.path === path);
    if (existing) return existing;
    const draft: Tab = {
      id: ++tabSeq, path, name: fileNameOf(path), content: '', mtime: '',
      dirty: false, isMarkdown: isMd(path), previewKind: previewKindOf(path), loading: true, readonly: false,
      hasBom: false,
      encoding: 'utf-8',
      lineEnding: '',
      indent: 'spaces',
      indentWidth: 4,
    };
    tabs.value.push(draft);
    // 返回响应式代理（原始 draft 不经过代理，改它对模板不可见）。
    return tabById(draft.id)!;
  }

  /** applyFile 把后端读到的文件内容写入已存在的标签（纯赋值，无请求）。 */
  function applyFile(tab: Tab, file: FileMeta) {
    tab.content = file.content;
    tab.mtime = file.mtime;
    tab.loading = false;
    tab.readonly = false;
    tab.hasBom = file.encoding === 'utf-8-bom';
    tab.encoding = file.encoding ?? 'utf-8';
    tab.lineEnding = file.lineEnding ?? '';
    const det = detectIndent(file.content);
    tab.indent = det.style;
    tab.indentWidth = det.width;
  }

  /**
   * fillTab 拉取文件内容填入已存在的占位标签（不建标签、不改 activeId）。
   * 失败时移除该标签并按需报错；silent=true 用于后台补加载——
   * 恢复会话里有文件已被删除/超限时，不该弹一堆 toast 打断启动。
   */
  async function fillTab(tab: Tab, silent = false): Promise<boolean> {
    try {
      const { file } = await readFile(tab.path);
      applyFile(tab, file);
      return true;
    } catch (e) {
      const idx = tabs.value.findIndex(tb => tb.id === tab.id);
      if (idx >= 0) tabs.value.splice(idx, 1);
      if (activeId.value === tab.id) activeId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? 0;
      if (!silent) reportOpenError(e);
      return false;
    }
  }

  /**
   * reportOpenError 打开失败的统一提示（单一 toast 通道，见 setError）。
   *
   * 文案结构：标题一句话说清「不行在哪」，细节另起一段给数据。
   * 旧实现是 `${t('openFailed')}: ${后端原文}`，渲染成
   * 「打开失败: 文件过大：50.0 MB（上限 10 MB），无法打开」——
   * 半角冒号 + 中外两层冒号套叠 + 尾部「无法打开」与开头「打开失败」重复。
   * 现改为：标题「文件过大，无法打开」+ 细节「50.0 MB 超过了 10 MB 的上限」。
   *
   * 时长 6.5s：文案较长，默认 3.2s 读不完。
   */
  function reportOpenError(e: unknown) {
    const err = e as Error;
    const raw = err.message;
    if (raw.includes('UTF-8')) {
      setError(t('notUtf8'));
      return;
    }
    // 文件过大：后端只回事实「文件过大：50.0 MB，上限 10 MB」，
    // 这里取出两个数字，用整句模板重新组织（不拼冒号，标点由模板统一）。
    const m = raw.match(/文件过大：([\d.]+\s*\w+)，上限\s*([\d.]+\s*\w+)/);
    if (m) {
      setError(t('openTooLarge', { size: m[1], limit: m[2] }));
      return;
    }
    setError(raw);
  }

  /**
   * openFile 打开文件（已打开则激活；标签数达上限时拒绝并提示）。
   *
   * 关键：**先读成功再建标签**。旧实现是先 push 占位标签再拉内容，
   * 失败时再把标签删掉——超大文件会先冒出一个页签、闪一下又消失，
   * 观感上像「打开了再关掉」。现在读取失败（含文件过大）直接提示，
   * 标签栏完全不受影响。
   */
  async function openFile(path: string) {
    const existing = tabs.value.find(tb => tb.path === path);
    if (existing) {
      activeId.value = existing.id;
      return;
    }
    if (tabs.value.length >= MAX_TABS) {
      toast(t('tabLimitReached').replace('{n}', String(MAX_TABS)), 'error');
      return;
    }
    // 读取在「无标签」状态下进行：后端对超大文件是 Stat 后直接拒绝，
    // 不会传内容，所以这里几乎立即返回，界面不会长时间无反馈。
    let file: FileMeta;
    try {
      ({ file } = await readFile(path));
    } catch (e) {
      reportOpenError(e);
      return;
    }
    // 读取成功才建标签：此时数据已就绪，页签一出现就是可编辑的完整内容。
    if (tabs.value.length >= MAX_TABS) {
      toast(t('tabLimitReached').replace('{n}', String(MAX_TABS)), 'error');
      return;
    }
    const tab = addTabStub(path);
    applyFile(tab, file);
    activeId.value = tab.id;
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

  // ---- 全局轻提示（toast）：非阻塞通知，自动消失（AppToast 组件渲染）----

  type ToastType = 'info' | 'success' | 'warning' | 'error';
  const toasts = ref<{ id: number; message: string; type: ToastType }[]>([]);
  let toastSeq = 0;

  /**
   * toast 弹出一条轻提示，duration 毫秒后自动消失（点击卡片可提前关闭）。
   * 这是应用**唯一**的提示通道：打开/保存/重新加载/报错全部走这里，
   * 状态栏只负责展示文件信息，不承担任何提示语义。
   * 最多同时 4 条，超量移除最旧（其定时器之后触发 dismissToast 对已移除项
   * 是空操作，无需跟踪句柄）。
   */
  function toast(message: string, type: ToastType = 'info', duration = 3200) {
    const id = ++toastSeq;
    toasts.value.push({ id, message, type });
    if (toasts.value.length > 4) toasts.value.shift();
    window.setTimeout(() => dismissToast(id), duration);
  }

  /** AppToast 回调：按 id 关闭（点击卡片或定时器到期）。 */
  function dismissToast(id: number) {
    toasts.value = toasts.value.filter(x => x.id !== id);
  }

  /** 保存当前活动标签（Ctrl+S / 菜单入口）。 */
  async function saveActive() {
    const tab = activeTab.value;
    if (tab) await saveTab(tab.id);
  }

  /**
   * 保存任意标签（saveActive 的核心实现）：有路径直存；草稿先激活再打开
   * 另存为（另存为对话框面向活动标签，先切换保证语义正确）。
   * 返回是否已落盘（草稿弹对话框视为未落盘，返回 false）。
   */
  async function saveTab(id: number): Promise<boolean> {
    const tab = tabById(id);
    if (!tab || tab.readonly) return false;
    if (!tab.path) {
      activeId.value = tab.id;
      saveAsVisible.value = true;
      return false;
    }
    try {
      const content = getTabContent(id);
      const { mtime } = await writeFile(tab.path, content, tab.mtime, tab.hasBom, tab.encoding);
      tab.mtime = mtime;
      tab.dirty = false;
      // 成功不提示：页签黄点消失本身就是「已保存」的反馈，再弹 toast 是噪音。
      // （保存失败仍要提示——那是用户必须知道的异常。）
      return true;
    } catch (e) {
      setError(`${t('saveFailed')}：${(e as Error).message}`);
      return false;
    }
  }

  /** 另存为对话框确认：写入目标路径并绑定标签。 */
  async function doSaveAs(target: string) {
    const tab = activeTab.value;
    if (!tab) return;
    saveAsVisible.value = false;
    try {
      const content = getTabContent(tab.id);
      const { mtime } = await writeFile(target, content, '', tab.hasBom, tab.encoding);
      lastSaveDir.value = target.replace(/[\\/][^\\/]+$/, '');
      // tab 来自 activeTab computed（响应式代理），赋值安全。
      tab.path = target;
      tab.name = fileNameOf(target);
      tab.isMarkdown = isMd(target);
      tab.previewKind = previewKindOf(target);
      tab.mtime = mtime;
      tab.dirty = false;
      // 不提示：页签名已变成新文件名、黄点消失，反馈已经很明确。
      // 草稿落盘后成为会话一员（有路径）→ 一次性写回偏好 + 会话
      // （lastSaveDir 也在同一份快照里；不再额外先写一次偏好，避免冗余 PUT）。
      persistSession();
    } catch (e) {
      setError(`${t('saveFailed')}：${(e as Error).message}`);
    }
  }

  function closeSaveAs() {
    saveAsVisible.value = false;
  }

  /**
   * 批量关闭确认状态：目标里未保存的页签分两组——
   *   toSave：有路径的脏文件（可「保存全部并关闭」）
   *   toDiscard：非空草稿（将丢弃，明示后果）
   * 空草稿不进列表（无损失，不打扰）。
   */
  const batchClose = ref<{
    visible: boolean;
    toSave: { id: number; name: string }[];
    toDiscard: { id: number; name: string }[];
    ids: number[];
  }>({ visible: false, toSave: [], toDiscard: [], ids: [] });
  let batchResolver: ((v: 'saved' | 'closed' | 'cancel') => void) | null = null;

  /** 移除单个标签（不含确认）：splice + 活动页调整 + unwatch + 持久化会话。 */
  function removeTabRaw(id: number) {
    const idx = tabs.value.findIndex(tb => tb.id === id);
    if (idx < 0) return;
    const tab = tabs.value[idx];
    tabs.value.splice(idx, 1);
    if (activeId.value === id) {
      activeId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? 0;
    }
    // 草稿从未落盘无需 unwatch；已打开文件通知后端释放监控。失败忽略。
    if (tab.path) void unwatchFile(tab.path).catch(() => {});
    persistSession();
  }

  /**
   * 批量关闭入口：收集目标里未保存的页签，一次列出（不逐个弹）。
   *   - 有路径的脏文件 → toSave（「保存全部并关闭」覆盖）
   *   - 非空草稿 → toDiscard（「不保存关闭」将丢弃，明示后果）
   *   - 空草稿 → 直接忽略
   * 无未保存项则直接关闭全部；否则弹批量确认模态。
   * 返回 'saved'（保存后关闭）/ 'closed'（未涉及保存直接关）/ 'cancel'（用户取消）。
   */
  function requestCloseMany(ids: number[]): Promise<'saved' | 'closed' | 'cancel'> {
    const toSave: { id: number; name: string }[] = [];
    const toDiscard: { id: number; name: string }[] = [];
    for (const id of ids) {
      const t = tabById(id);
      if (!t || !t.dirty) continue;
      if (t.path) toSave.push({ id, name: t.name });
      else if (getTabContent(id).trim() !== '') toDiscard.push({ id, name: t.name });
      // 空草稿：无损失，直接忽略不进列表
    }
    if (toSave.length === 0 && toDiscard.length === 0) {
      ids.forEach(removeTabRaw);
      return Promise.resolve('closed');
    }
    batchClose.value = { visible: true, toSave, toDiscard, ids };
    return new Promise(resolve => { batchResolver = resolve; });
  }

  /** 批量关闭模态回调：save=先存 toSave 再全关；discard=直接全关；cancel=不动。 */
  async function settleBatchClose(choice: 'save' | 'discard' | 'cancel') {
    const { ids, toSave } = batchClose.value;
    batchClose.value.visible = false;
    const resolve = batchResolver;
    batchResolver = null;
    if (!resolve) return;
    if (choice === 'cancel') { resolve('cancel'); return; }
    if (choice === 'save') {
      // 逐个保存有路径的脏文件；任一失败（写盘错误）即中止，不动手关。
      for (const t of toSave) {
        const ok = await saveTab(t.id);
        if (!ok) { resolve('cancel'); return; }
      }
    }
    ids.forEach(removeTabRaw);
    resolve(choice === 'save' ? 'saved' : 'closed');
  }

  /**
   * 关闭单个标签（页签 × 按钮 / 文件菜单关闭 / 右键当前页签）。
   * 复用批量关闭模态（三按钮：保存并关闭/放弃并关闭/取消），脏页签可选保存。
   * 返回是否已关闭（取消=false）。
   */
  async function closeTab(id: number): Promise<boolean> {
    const r = await requestCloseMany([id]);
    return r !== 'cancel';
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
      tab.externalChanged = false;
      tab.readonly = false;
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

  /**
   * promptExternalChange 询问用户「外部已修改，重载还是保持当前」。
   *
   * 只有活动页签会走到这里（fileWatch 对非活动页签只打标记，切页时再问）。
   * 无论本地有没有未保存修改都询问——磁盘内容变了，取舍应由用户决定；
   * 选「保持当前」则保留内存中的版本（下次保存会覆盖磁盘内容）。
   */
  async function promptExternalChange(id: number): Promise<void> {
    const tab = tabById(id);
    if (!tab || !tab.externalChanged) return;
    // 防重入：询问期间同一标签又来变更，不叠加第二个对话框。
    if (tab.externalPrompting) return;
    tab.externalPrompting = true;
    try {
      const reload = await confirm(`${tab.name} ${t('externalChangePrompt')}`, {
        title: t('externalChangeTitle'),
        confirmText: t('fileChangedReload'),
        cancelText: t('fileChangedKeep'),
        danger: tab.dirty, // 有未保存修改时重载会丢弃，标红警示
      });
      if (reload) {
        await reloadFile(tab.path);
      } else {
        // 保留当前：清掉标记，避免每次切页都再问一遍。
        tab.externalChanged = false;
      }
      if (reload) toast(t('reloaded'), 'success');
    } finally {
      tab.externalPrompting = false;
    }
  }

  // ---- 编辑器内容 provider（大文件性能核心：编辑期不逐键同步全文）----
  // 每键只置 dirty（O(1)）；全文由 App 注册的 provider 在关键点按需拉取
  // （保存/另存/空草稿判定），tab.content 仅作「非活动标签」的快照缓存。
  let contentProvider: ((id: number) => string | null) | null = null;

  /** App 挂载编辑器时注册：按 id 返回该标签当前编辑器全文；非挂载标签返回 null。 */
  function setContentProvider(fn: (id: number) => string | null) {
    contentProvider = fn;
  }

  /** 取标签当前全文：优先经 provider 拉活动编辑器内容，回退快照（非活动标签）。 */
  function getTabContent(id: number): string {
    const fromEditor = contentProvider?.(id);
    if (fromEditor != null) return fromEditor;
    return tabById(id)?.content ?? '';
  }

  /** 每键编辑标记（轻量）：只置 dirty，不触碰 content（消灭每键 O(n) toString）。 */
  function markDirtyLight(id: number) {
    const tab = tabById(id);
    if (tab) tab.dirty = true;
  }

  /** 把当前编辑器全文写回 tab.content 快照（切页签 / 预览防抖同步时由 App 调）。 */
  function syncContent(id: number, content: string) {
    const tab = tabById(id);
    if (tab) tab.content = content;
  }

  // ---- 会话恢复：记录「打开未关闭」的标签，下次自动还原（VS Code 式） ----

  /**
   * sessionSnapshot 取当前会话（已落盘标签的路径 + 活动标签）。
   * 无路径草稿（未保存的无标题）不记——没内容可恢复。
   * 注意：仅由 prefsSnapshot 调用，不单独写盘（见 prefsSnapshot 注释）。
   */
  function sessionSnapshot(): Record<string, unknown> {
    const paths = tabs.value.filter(tb => tb.path).map(tb => tb.path);
    const active = activeTab.value;
    const activePath = active && active.path ? active.path : (paths[paths.length - 1] ?? '');
    if (!paths.length) return { [SESSION_TABS]: [], [SESSION_ACTIVE]: '' };
    return { [SESSION_TABS]: paths, [SESSION_ACTIVE]: activePath };
  }

  /**
   * persistSession 把会话（连带偏好）整体写回。
   * 直接改 tabs/activeId 后调用（openFile/closeTab/doSaveAs），即操作即存，
   * 不依赖页面卸载（浏览器 unload 阶段 fetch 不可靠）。
   * 与 persistPrefs 共用 persistAll：两者都写完整快照，避免互相抹字段。
   */
  function persistSession() {
    persistAll();
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
      prefsLoaded = true;
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
      themeMode.value = pick(PREF_KEYS.themeMode, themeMode.value);
      setThemeOverride(themeMode.value);
      lineWrapping.value = pick(PREF_KEYS.lineWrapping, lineWrapping.value);
      showLineNumbers.value = pick(PREF_KEYS.showLineNumbers, showLineNumbers.value);
      showSpaces.value = pick(PREF_KEYS.showSpaces, showSpaces.value);
      showTabs.value = pick(PREF_KEYS.showTabs, showTabs.value);
      showLineBreaks.value = pick(PREF_KEYS.showLineBreaks, showLineBreaks.value);
      autoPreview.value = pick(PREF_KEYS.autoPreview, autoPreview.value);
      lastSaveDir.value = pick(PREF_KEYS.lastSaveDir, lastSaveDir.value);
    }

    // 恢复会话：后端 session（唯一来源）。旧版本会话可能超过标签上限：
    // 按上限裁剪恢复，超限时回写一次收敛持久化体积（否则 prefs 持续超限）。
    // booting 必须无条件复位：任何异常都不该让界面永久停在「加载中」。
    try {
      const sess = (prefs[SESSION_KEY] ?? null) as
        | { [SESSION_TABS]?: string[]; [SESSION_ACTIVE]?: string }
        | null;
      const allPaths = Array.isArray(sess?.[SESSION_TABS]) ? sess![SESSION_TABS]! : [];
      const paths = allPaths.slice(0, MAX_TABS);
      if (!paths.length) return { hasSession: false, activePath: '' };

      restoreGuard = true;
      let want = sess?.[SESSION_ACTIVE] ?? '';
      if (!paths.includes(want)) want = paths[paths.length - 1];
      try {
        // 阶段一：一次性铺出全部占位标签（零请求、零编辑器重挂）。
        // 关键：绝不在这里逐个改 activeId——那会让 watch(activeId) 把 CodeMirror
        // 反复 destroy/new 一遍，N 个标签就重建 N 次（旧实现正是如此，表现为
        // 「挨个加载」的卡顿感）。
        const stubs = paths.map(p => addTabStub(p));
        // 先定位活动标签：界面立刻落到用户上次停留的页，而不是最左/最右。
        const target = stubs.find(s => s.path === want) ?? stubs[stubs.length - 1];
        if (target) activeId.value = target.id;

        // 阶段二：只等活动标签加载完（用户真正要看的那一个），其余后台补。
        // 这样首屏可见时间 ≈ 1 次文件读取，而不是 N 次串行往返。
        if (target) await fillTab(target, true);

        // 阶段三：后台并发补加载剩余标签（不 await，不阻塞启动）。
        // 失败静默移除（文件可能已被删除/超限），不弹一堆 toast 打断启动。
        const rest = stubs.filter(s => s !== target);
        void Promise.all(rest.map(s => fillTab(s, true))).then(() => {
          // 全部补完后再落盘一次：以「实际还能打开」的标签收敛会话，
          // 避免下次启动继续尝试那些已经打不开的路径。
          // 此时 restoreGuard 已在 finally 里复位，这次写入是正常持久化。
          persistSession();
        });
      } finally {
        restoreGuard = false;
      }
      if (allPaths.length > MAX_TABS) persistSession();
      return { hasSession: true, activePath: want };
    } finally {
      booting.value = false;
    }
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
    themeMode.value = PREF_DEFAULTS.themeMode;
    setThemeOverride(themeMode.value);
    lineWrapping.value = PREF_DEFAULTS.lineWrapping;
    showLineNumbers.value = PREF_DEFAULTS.showLineNumbers;
    showSpaces.value = PREF_DEFAULTS.showSpaces;
    showTabs.value = PREF_DEFAULTS.showTabs;
    showLineBreaks.value = PREF_DEFAULTS.showLineBreaks;
    lastSaveDir.value = PREF_DEFAULTS.lastSaveDir;

    // 后端写回默认值快照（含空会话）= 清空持久化偏好与会话（下次 initPrefs 走默认值）。
    // 不再写 {}：后端 Set 对空对象虽合法，但快照化后语义更明确，且复用同一条
    // 串行写队列，避免与恢复后的首个 persistSession 乱序（旧实现直接裸 putPrefs）。
    const ok = await persistAll();

    // 回到初始界面：一个空白无标题草稿。
    untitledSeq = 0;
    newUntitled();
    toast(t('resetDone'), 'success');
    return ok;
  }

  return {
    tabs, activeId, activeTab, activePath,
    saveAsVisible, lastSaveDir,
    confirmDialog, confirm, settleConfirm,
    batchClose, requestCloseMany, settleBatchClose,
    toasts, toast, dismissToast,
    indentMode, indentWidth, fontSize, fontFamily, themeMode, lineWrapping, showLineNumbers,
    showSpaces, showTabs, showLineBreaks, autoPreview,
    setIndentMode, setFontSize, setFontFamily, setThemeMode, setLineWrapping, setShowLineNumbers,
    setShowSpaces, setShowTabs, setShowLineBreaks, setAutoPreview,
    builtinFonts: BUILTIN_FONTS,
    openViaPicker,
    openFile, saveActive, saveTab, closeTab, newUntitled, setError,
    setContentProvider, getTabContent, markDirtyLight, syncContent,
    doSaveAs, closeSaveAs,
    reloadFile, tabById, promptExternalChange,
    initPrefs, persistSession, prefsBackendOk, resetToDefaults,
    booting,
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

/** 预览渲染类型（md/htm/html 有预览，其它 null），与 language.ts 的 previewKind 同规则。 */
function previewKindOf(path: string): 'markdown' | 'html' | null {
  const ext = fileNameOf(path).split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'htm' || ext === 'html') return 'html';
  return null;
}

export type { FileMeta };
