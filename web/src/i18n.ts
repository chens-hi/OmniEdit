import { ref, computed } from 'vue';
import { sdk } from './api';

export type Lang = 'zh' | 'en';

/** 当前语言（响应式），默认中文。 */
export const lang = ref<Lang>('zh');

/** 文案字典。键为语义标识，值为各语言文案。 */
const dict = {
  // 工具栏 / 通用
  appName: { zh: 'OmniEdit', en: 'OmniEdit' },
  save: { zh: '保存', en: 'Save' },
  saveShortcut: { zh: '保存 (Ctrl+S)', en: 'Save (Ctrl+S)' },
  newFile: { zh: '新建', en: 'New' },
  preview: { zh: '预览', en: 'Preview' },
  ready: { zh: '就绪', en: 'Ready' },
  saved: { zh: '已保存', en: 'Saved' },
  saving: { zh: '保存中…', en: 'Saving…' },
  loading: { zh: '加载中…', en: 'Loading…' },
  opened: { zh: '已打开', en: 'Opened' },
  readOnlyPreview: { zh: '只读预览', en: 'read-only preview' },
  untitled: { zh: '无标题', en: 'Untitled' },
  largeFileConfirm: {
    zh: '体积较大，完整打开可能卡顿。是否以只读预览方式打开（仅加载前 256 KB）？',
    en: 'is large; opening it fully may freeze the editor. Open as read-only preview (first 256 KB only)?',
  },
  openFailed: { zh: '打开失败', en: 'Open failed' },
  saveFailed: { zh: '保存失败', en: 'Save failed' },
  error: { zh: '出错', en: 'Error' },
  notUtf8: {
    zh: '文件编码无法识别（不是 UTF-8/GBK 系编码），暂不支持编辑以避免乱码。',
    en: 'Unrecognized encoding (not UTF-8/GBK family). Editing is disabled to avoid mojibake.',
  },
  encodingBadge: { zh: 'ANSI (GB18030)', en: 'ANSI (GB18030)' },

  // 另存为对话框
  saveAsDraftTitle: { zh: '保存为', en: 'Save As' },
  saveAsCopyTitle: { zh: '另存为', en: 'Save a Copy' },
  saveAsTitle: { zh: '另存为', en: 'Save As' },
  saveLocation: { zh: '保存位置', en: 'Location' },
  choose: { zh: '选择…', en: 'Choose…' },
  fileName: { zh: '文件名', en: 'File name' },
  overwriteHint: { zh: '目标已存在同名文件，将覆盖', en: 'A file with this name exists and will be overwritten' },
  cancel: { zh: '取消', en: 'Cancel' },
  saveBtn: { zh: '保存', en: 'Save' },
  invalidName: { zh: '文件名包含非法字符（/ \\ 或控制符）', en: 'File name contains invalid characters' },
  errNeedDir: { zh: '请选择保存位置', en: 'Choose a location first' },
  errNeedName: { zh: '请输入文件名', en: 'Enter a file name' },

  // 另存为 / 宿主授权
  pickDirTitle: { zh: '选择保存位置', en: 'Choose a save location' },
  pickDirOk: { zh: '确认授权', en: 'Authorize' },
  promptDir: { zh: '输入保存目录（本地开发模式）：', en: 'Enter save directory (local dev mode):' },
  promptName: { zh: '输入文件名：', en: 'File name:' },
  requestingAuth: { zh: '正在请求访问授权…', en: 'Requesting file access…' },
  confirmCloseDirty: { zh: '有未保存的修改，确定关闭？', en: 'has unsaved changes. Close anyway?' },
  confirmTitle: { zh: '确认', en: 'Confirm' },
  confirmOk: { zh: '确定', en: 'OK' },

  // 菜单栏
  menuFile: { zh: '文件', en: 'File' },
  menuEdit: { zh: '编辑', en: 'Edit' },
  menuView: { zh: '视图', en: 'View' },
  menuHelp: { zh: '帮助', en: 'Help' },
  menuNew: { zh: '新建', en: 'New' },
  menuOpen: { zh: '打开', en: 'Open' },
  menuSave: { zh: '保存', en: 'Save' },
  menuSaveAs: { zh: '另存', en: 'Save As' },
  menuExit: { zh: '退出', en: 'Exit' },
  menuFind: { zh: '查找…', en: 'Find…' },
  menuReplace: { zh: '替换…', en: 'Replace…' },
  menuWordWrap: { zh: '自动换行', en: 'Word Wrap' },
  menuDisplay: { zh: '显示符号', en: 'Show Symbols' },
  showSpacesLabel: { zh: '空格', en: 'Spaces' },
  showTabsLabel: { zh: '制表符', en: 'Tabs' },
  showLineEndingsLabel: { zh: '换行符', en: 'Line Endings' },
  showOn: { zh: '显示', en: 'Show' },
  showOff: { zh: '不显示', en: 'Hide' },
  on: { zh: '开', en: 'On' },
  off: { zh: '关', en: 'Off' },
  menuLineNumbers: { zh: '行号', en: 'Line Numbers' },
  menuIndent: { zh: '缩进风格', en: 'Indent Style' },
  menuIndentSpaces: { zh: '空格', en: 'Spaces' },
  menuIndentTabFixed: { zh: '制表符', en: 'Tab' },
  menuFont: { zh: '字体', en: 'Font' },
  menuTheme: { zh: '主题', en: 'Theme' },
  themeAuto: { zh: '自动', en: 'Auto' },
  themeLight: { zh: '浅色', en: 'Light' },
  themeDark: { zh: '深色', en: 'Dark' },
  menuFontSizeItem: { zh: '字号', en: 'Font Size' },
  menuAbout: { zh: '关于 OmniEdit', en: 'About OmniEdit' },
  menuReset: { zh: '还原初始状态', en: 'Reset to Defaults' },
  resetConfirm: {
    zh: '将清除全部设置并关闭所有标签，恢复到初始状态。此操作不可撤销，确定继续？',
    en: 'This clears all settings and closes every tab, restoring the initial state. This cannot be undone. Continue?',
  },
  resetDone: { zh: '已还原到初始状态', en: 'Reset to defaults' },
  promptOpenPath: { zh: '输入要打开的文件路径（本地开发模式）：', en: 'Enter file path to open (local dev mode):' },

  // 状态栏
  noFile: { zh: '未打开文件', en: 'No file open' },
  previewTitle: { zh: '预览（Markdown）', en: 'Preview (Markdown)' },
  linesUnit: { zh: '行', en: 'lines' },
  indentSpacesWord: { zh: '空格', en: 'Spaces' },
  indentMixedWord: { zh: '混合', en: 'Mixed' },
  indentHint: { zh: '缩进风格与宽度（打开时检测）', en: 'Indentation (detected on open)' },

  // 搜索浮窗
  searchPlaceholder: { zh: '搜索', en: 'Find' },
  replacePlaceholder: { zh: '替换为', en: 'Replace with' },
  prevMatch: { zh: '上一个匹配', en: 'Previous match' },
  nextMatch: { zh: '下一个匹配', en: 'Next match' },
  matchCase: { zh: '区分大小写', en: 'Match case' },
  regexp: { zh: '正则表达式', en: 'Regular expression' },
  wholeWord: { zh: '整词匹配', en: 'Whole word' },
  replaceBtn: { zh: '替换', en: 'Replace' },
  replaceAllBtn: { zh: '全部替换', en: 'Replace all' },
  toggleReplace: { zh: '展开/收起替换 (Ctrl+H)', en: 'Toggle Replace (Ctrl+H)' },
  closeSearch: { zh: '关闭 (Esc)', en: 'Close (Esc)' },
  matchesUnit: { zh: '处', en: 'matches' },
  noMatch: { zh: '无匹配', en: 'No matches' },

  // 标签栏
  unsaved: { zh: '未保存', en: 'Unsaved' },
  close: { zh: '关闭', en: 'Close' },
  // 页签右键「关闭」子菜单（父项已是「关闭」，子项省略「页签」后缀）
  closeCurrent: { zh: '当前', en: 'Current' },
  closeRight: { zh: '右侧', en: 'To the Right' },
  closeLeft: { zh: '左侧', en: 'To the Left' },
  closeOthers: { zh: '其他', en: 'Others' },
  closeAllTabs: { zh: '所有', en: 'All' },
  // 批量关闭确认模态
  batchCloseTitle: { zh: '关闭页签', en: 'Close Tabs' },
  batchCloseModified: { zh: '以下文件未保存：', en: 'These files are unsaved:' },
  batchCloseDrafts: { zh: '以下草稿将丢弃：', en: 'These drafts will be discarded:' },
  batchCloseSaveAll: { zh: '保存并关闭', en: 'Save & Close' },
  batchCloseDiscard: { zh: '放弃并关闭', en: 'Discard & Close' },
  batchCloseSingleMsg: { zh: '有未保存的修改，是否保存后关闭？', en: 'Has unsaved changes. Save before closing?' },
  // 编辑区右键菜单
  ctxCopy: { zh: '复制', en: 'Copy' },
  ctxCut: { zh: '剪切', en: 'Cut' },
  ctxPaste: { zh: '粘贴', en: 'Paste' },
  ctxSelectAll: { zh: '全选', en: 'Select All' },
  tabLimitReached: {
    zh: '标签数已达上限（{n}），请先关闭部分标签',
    en: 'Tab limit reached ({n}); close some tabs first',
  },

  // 欢迎页
  welcomeTitle: { zh: 'OmniEdit', en: 'OmniEdit' },
  welcomeSub: { zh: '飞牛原生 · 全格式文件编辑器', en: 'Native all-format file editor for fnOS' },
  placeholderDblClick: { zh: '双击空白处新建页签', en: 'Double-click to open a new tab' },

  // 外部变更
  fileChangedReload: { zh: '重新加载', en: 'Reload' },
  fileChangedKeep: { zh: '保留我的修改', en: 'Keep my changes' },
  externalChangePrompt: {
    zh: '已被外部修改，是否重新加载？（保留你的未保存修改将覆盖外部改动）',
    en: 'was changed externally. Reload it? (Keeping your unsaved changes will overwrite the external edit.)',
  },
  reloaded: { zh: '已从磁盘重新加载', en: 'Reloaded from disk' },
} as const;

export type MsgKey = keyof typeof dict;

/** 翻译函数：返回当前语言文案。 */
export function t(key: MsgKey): string {
  const entry = dict[key];
  return entry[lang.value] ?? entry.zh;
}

/** 响应式翻译（用于模板 computed）。 */
export function useI18n() {
  const tf = computed(() => (key: MsgKey) => t(key));
  return { t: tf, lang };
}

/**
 * 从宿主读取语言并应用，同时监听宿主语言实时切换（SDK 事件 `os/language`）。
 * fnOS 语言标识形如 zh-CN / en-US，取主语言前缀。
 * 独立浏览器（无宿主）或读取失败时保持中文默认。
 */
function applyLangCode(code: string) {
  lang.value = code.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

export async function initLang(): Promise<void> {
  try {
    if (sdk.isStandaloneWeb) return;
    const config = await sdk.getPlatformConfig();
    applyLangCode(config?.language ?? '');
  } catch {
    lang.value = 'zh';
    return;
  }
  try {
    await sdk.$on('os/language', (payload: unknown) => {
      const value = typeof payload === 'string' ? payload
        : (payload as { language?: string })?.language;
      if (value) applyLangCode(value);
    });
  } catch {
    // 事件总线不可用：维持启动读取结果。
  }
}
