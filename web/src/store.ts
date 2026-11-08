import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { readFile, writeFile, listDir, listRoots, type FileMeta, type DirEntry } from './api';
import { t } from './i18n';

/** 一个已打开的标签页。 */
export interface Tab {
  path: string;
  name: string;
  content: string;
  mtime: string;       // 服务端 mtime，用于冲突检测
  dirty: boolean;
  isMarkdown: boolean;
  loading: boolean;
  /** 只读（超大文件截断预览时为 true，禁止保存）。 */
  readonly: boolean;
}

export const useEditorStore = defineStore('editor', () => {
  const tabs = ref<Tab[]>([]);
  const activePath = ref<string>('');
  const error = ref<string>('');
  const status = ref<string>(t('ready'));
  const authorizedRoots = ref<string[]>([]);
  const treeEntries = ref<DirEntry[]>([]);
  // 待跳转行号（搜索结果点击后设置，编辑器消费后应清零）。
  const pendingLine = ref<number>(0);

  const activeTab = computed(() => tabs.value.find(t => t.path === activePath.value));

  function tabByPath(path: string) {
    return tabs.value.find(t => t.path === path);
  }

  function setError(msg: string) {
    error.value = msg;
    if (msg) status.value = t('error');
  }

  /** 打开文件（已打开则激活）。 */
  async function openFile(path: string) {
    setError('');
    const existing = tabByPath(path);
    if (existing) {
      activePath.value = path;
      return;
    }
    // 先创建一个占位标签并激活，展示 loading。
    const tab: Tab = {
      path, name: fileNameOf(path), content: '', mtime: '',
      dirty: false, isMarkdown: isMd(path), loading: true, readonly: false,
    };
    tabs.value.push(tab);
    activePath.value = path;
    try {
      let { file } = await readFile(path);
      // 大文件保护：首次读取返回 tooLarge，弹确认后以只读预览方式打开。
      if (file.tooLarge) {
        // 移除占位标签，等用户确认后再决定是否打开。
        tabs.value = tabs.value.filter(x => x.path !== path);
        if (activePath.value === path) activePath.value = tabs.value[tabs.value.length - 1]?.path ?? '';
        const ok = window.confirm(
          `「${fileNameOf(path)}」${(file.size / 1024 / 1024).toFixed(1)} MB — ${t('largeFileConfirm')}`,
        );
        if (!ok) {
          status.value = t('ready');
          return;
        }
        // 重新创建占位标签并加载只读预览。
        const previewTab: Tab = {
          path, name: fileNameOf(path), content: '', mtime: '',
          dirty: false, isMarkdown: isMd(path), loading: true, readonly: true,
        };
        tabs.value.push(previewTab);
        activePath.value = path;
        const res = await readFile(path, true);
        file = res.file;
        previewTab.content = file.content;
        previewTab.mtime = file.mtime;
        previewTab.loading = false;
        previewTab.readonly = true;
        status.value = `${t('opened')} ${file.displayPath ?? file.path}（${t('readOnlyPreview')}）`;
        return;
      }
      tab.content = file.content;
      tab.mtime = file.mtime;
      tab.loading = false;
      tab.readonly = file.truncated === true;
      status.value = `${t('opened')} ${file.displayPath ?? file.path}`;
    } catch (e) {
      // 打开失败：移除占位标签并报错。
      tabs.value = tabs.value.filter(t => t.path !== path);
      if (activePath.value === path) activePath.value = tabs.value[tabs.value.length - 1]?.path ?? '';
      setError((e as Error).message);
    }
  }

  /** 保存当前活动文件。 */
  async function saveActive() {
    const tab = activeTab.value;
    if (!tab) return;
    setError('');
    try {
      const { mtime } = await writeFile(tab.path, tab.content, tab.mtime);
      tab.mtime = mtime;
      tab.dirty = false;
      status.value = t('saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function closeTab(path: string) {
    const idx = tabs.value.findIndex(t => t.path === path);
    if (idx === -1) return;
    tabs.value.splice(idx, 1);
    if (activePath.value === path) {
      activePath.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.path ?? '';
    }
  }

  /**
   * 从磁盘重新加载某文件内容（外部变更后刷新）。
   * 成功返回 true；文件不可读或已删除返回 false。
   */
  async function reloadFile(path: string): Promise<boolean> {
    const tab = tabByPath(path);
    if (!tab) return false;
    try {
      const { file } = await readFile(path);
      tab.content = file.content;
      tab.mtime = file.mtime;
      tab.dirty = false;
      // 只读标记随 truncated 变化（大文件预览保持只读）。
      tab.readonly = file.truncated === true;
      return true;
    } catch {
      return false;
    }
  }

  function markDirty(path: string, content: string) {
    const tab = tabByPath(path);
    if (tab) {
      tab.content = content;
      tab.dirty = true;
    }
  }

  /** 加载授权目录列表（目录树浏览起点）。 */
  async function loadRoots() {
    setError('');
    try {
      const { roots } = await listRoots();
      authorizedRoots.value = roots;
    } catch (e) {
      // 获取授权根目录失败不阻塞编辑器（用户仍可通过文件管理器右键打开）。
      authorizedRoots.value = [];
    }
  }

  /** 浏览某个目录。 */
  async function browse(path: string) {
    setError('');
    try {
      const res = await listDir(path);
      treeEntries.value = res.entries;
      status.value = res.displayPath;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return {
    tabs, activePath, activeTab, error, status,
    authorizedRoots, treeEntries, pendingLine,
    openFile, saveActive, closeTab, markDirty, loadRoots, browse, setError,
    tabByPath, reloadFile,
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
