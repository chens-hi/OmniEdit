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
  preview: { zh: '预览', en: 'Preview' },
  ready: { zh: '就绪', en: 'Ready' },
  saved: { zh: '已保存', en: 'Saved' },
  saving: { zh: '保存中…', en: 'Saving…' },
  loading: { zh: '加载中…', en: 'Loading…' },
  opened: { zh: '已打开', en: 'Opened' },
  readOnlyPreview: { zh: '只读预览', en: 'read-only preview' },
  largeFileConfirm: {
    zh: '体积较大，完整打开可能卡顿。是否以只读预览方式打开（仅加载前 256 KB）？',
    en: 'is large; opening it fully may freeze the editor. Open as read-only preview (first 256 KB only)?',
  },
  openFailed: { zh: '打开失败', en: 'Open failed' },
  saveFailed: { zh: '保存失败', en: 'Save failed' },
  error: { zh: '出错', en: 'Error' },

  // 侧边栏
  files: { zh: '文件', en: 'Files' },
  search: { zh: '搜索', en: 'Search' },
  noAuthDir: { zh: '暂无授权目录。', en: 'No authorized directory.' },
  openFromFileManager: { zh: '可从文件管理器右键打开文件。', en: 'Open a file via the file manager context menu.' },
  toggleSidebar: { zh: '切换侧边栏', en: 'Toggle sidebar' },

  // 搜索
  searchPlaceholder: { zh: '在当前目录搜索内容…', en: 'Search in current directory…' },
  searchButton: { zh: '搜索', en: 'Search' },
  searching: { zh: '搜索中…', en: 'Searching…' },
  searchResults: { zh: '个结果 · 扫描', en: 'results · scanned' },
  filesUnit: { zh: '个文件', en: 'files' },
  truncated: { zh: '（已截断）', en: '(truncated)' },
  scope: { zh: '范围', en: 'Scope' },
  noMatch: { zh: '无匹配结果', en: 'No matches' },

  // 欢迎页
  welcomeTitle: { zh: 'OmniEdit', en: 'OmniEdit' },
  welcomeSub: { zh: '飞牛原生 · 全格式文件编辑器', en: 'Native all-format file editor for fnOS' },
  welcomeHint: { zh: '从文件管理器右键打开文件，或在侧边栏浏览目录', en: 'Open a file from the file manager, or browse directories in the sidebar' },

  // 状态栏
  noFile: { zh: '未打开文件', en: 'No file open' },
  previewTitle: { zh: '预览（Markdown）', en: 'Preview (Markdown)' },

  // 标签栏
  unsaved: { zh: '未保存', en: 'Unsaved' },
  close: { zh: '关闭', en: 'Close' },

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
 * 从宿主读取语言并应用。
 * fnOS 语言标识形如 zh-CN / en-US，取主语言前缀。
 * 独立浏览器（无宿主）或读取失败时保持中文默认。
 */
export async function initLang(): Promise<void> {
  try {
    if (sdk.isStandaloneWeb) return;
    const config = await sdk.getPlatformConfig();
    const l = (config?.language ?? '').toLowerCase();
    lang.value = l.startsWith('en') ? 'en' : 'zh';
  } catch {
    lang.value = 'zh';
  }
}
