import {
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel,
  openSearchPanel,
} from '@codemirror/search';
import type { EditorView, Panel } from '@codemirror/view';
import { t } from './i18n';

/**
 * 菜单「查找…/替换…」入口：打开官方搜索面板并把焦点放到对应输入框。
 * PanelRefs 桥接：createPanel 闭包创建时注册当前面板的输入框引用。
 *
 * 替换行展开/收起：replaceExpanded 为会话级记忆（本次页面内保持上次的模式）；
 * 查找模式只显示搜索行，替换模式展开替换行。applyReplaceMode 由面板 mount
 * 注册，openSearch 在面板已打开时可即时切换模式。
 */
let activeRefs: { search: HTMLInputElement; replace: HTMLInputElement } | null = null;
let replaceExpanded = false;
let applyReplaceMode: ((v: boolean) => void) | null = null;

export function openSearch(view: EditorView, mode: 'find' | 'replace') {
  replaceExpanded = mode === 'replace';
  openSearchPanel(view);
  // 面板可能刚创建：等一帧让 mount 完成。
  requestAnimationFrame(() => {
    applyReplaceMode?.(replaceExpanded);
    const target = mode === 'replace' ? activeRefs?.replace : activeRefs?.search;
    if (target) {
      target.focus();
      target.select();
    } else {
      // 官方面板兜底（不会发生：我们的 createPanel 总是注册）
      (document.querySelector('.omni-input') as HTMLInputElement | null)?.focus();
    }
  });
}

/**
 * 自定义搜索浮窗（官方 createPanel 定制点）。
 *
 * 搜索状态机（匹配高亮、循环跳转、正则/大小写/整词、替换）全部由
 * @codemirror/search 提供——这里只做三件事：
 *   1. 按设计稿构建 DOM（右上角悬浮卡片，样式见 styles.css 的 .cm-panels 规则）；
 *   2. 把控件交互翻译成 setSearchQuery effect / 官方 command；
 *   3. update() 回读 query 状态回填 UI（官方快捷键改变 query 时面板不脱节）。
 */

interface PanelRefs {
  searchInput: HTMLInputElement;
  replaceInput: HTMLInputElement;
  caseBtn: HTMLButtonElement;
  regexpBtn: HTMLButtonElement;
  wordBtn: HTMLButtonElement;
  countEl: HTMLElement;
}

function btn(label: string, title: string, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `omni-sbtn${cls ? ' ' + cls : ''}`;
  b.textContent = label;
  b.title = title;
  return b;
}

function toggle(cls: string, label: string, title: string): HTMLButtonElement {
  const b = btn(label, title, 'omni-toggle ' + cls);
  b.setAttribute('aria-pressed', 'false');
  return b;
}

export function createSearchPanel(): (view: EditorView) => Panel {
  return (view: EditorView): Panel => {
    const refs = {} as PanelRefs;

    const root = document.createElement('div');
    root.className = 'omni-search';

    // ---- 搜索行 ----
    const row1 = document.createElement('div');
    row1.className = 'omni-row';

    refs.searchInput = document.createElement('input');
    refs.searchInput.className = 'omni-input';
    refs.searchInput.placeholder = t('searchPlaceholder');
    refs.searchInput.spellcheck = false;

    const nav = document.createElement('div');
    nav.className = 'omni-nav';
    const prevBtn = btn('▲', `${t('prevMatch')} (Shift+F3)`);
    const nextBtn = btn('▼', `${t('nextMatch')} (F3)`);
    prevBtn.addEventListener('mousedown', (e) => { e.preventDefault(); findPrevious(view); });
    nextBtn.addEventListener('mousedown', (e) => { e.preventDefault(); findNext(view); });
    nav.append(prevBtn, nextBtn);

    refs.caseBtn = toggle('omni-tcase', 'Aa', t('matchCase'));
    refs.regexpBtn = toggle('omni-tregexp', '.*', t('regexp'));
    refs.wordBtn = toggle('omni-tword', '「」', t('wholeWord'));

    // 替换行展开/收起切换钮（▾ 展开 / ▴ 收起，aria-pressed 亮起=已展开）
    const expandBtn = toggle('omni-texpand', replaceExpanded ? '▴' : '▾', t('toggleReplace'));
    expandBtn.setAttribute('aria-pressed', replaceExpanded ? 'true' : 'false');

    const closeBtn = btn('✕', t('closeSearch'), 'omni-close');
    closeBtn.addEventListener('mousedown', (e) => { e.preventDefault(); closeSearchPanel(view); });

    row1.append(refs.searchInput, nav, refs.caseBtn, refs.regexpBtn, refs.wordBtn, expandBtn, closeBtn);

    // ---- 替换行 ----
    const row2 = document.createElement('div');
    row2.className = 'omni-row';

    refs.replaceInput = document.createElement('input');
    refs.replaceInput.className = 'omni-input';
    refs.replaceInput.placeholder = t('replacePlaceholder');

    const actions = document.createElement('div');
    actions.className = 'omni-actions';
    const repBtn = btn(t('replaceBtn'), t('replaceBtn'));
    const repAllBtn = btn(t('replaceAllBtn'), t('replaceAllBtn'));
    repBtn.addEventListener('mousedown', (e) => { e.preventDefault(); replaceNext(view); });
    repAllBtn.addEventListener('mousedown', (e) => { e.preventDefault(); replaceAll(view); });
    actions.append(repBtn, repAllBtn);

    refs.countEl = document.createElement('span');
    refs.countEl.className = 'omni-count';
    refs.countEl.textContent = '';

    row2.append(refs.replaceInput, actions, refs.countEl);
    row2.style.display = replaceExpanded ? '' : 'none'; // 初始模式：查找=收起，替换=展开
    root.append(row1, row2);

    /** 切换替换行显隐并联动按钮态/焦点。 */
    function setExpanded(v: boolean) {
      replaceExpanded = v;
      row2.style.display = v ? '' : 'none';
      expandBtn.textContent = v ? '▴' : '▾';
      expandBtn.setAttribute('aria-pressed', v ? 'true' : 'false');
      if (v) refs.replaceInput.focus();
      else refs.searchInput.focus();
    }
    expandBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      setExpanded(!replaceExpanded);
    });

    // ---- 状态与派发 ----
    // 所有 DOM 引用统一走 safe() 守卫：任何一处缺失只降级功能，绝不让
    // 面板异常沿 CodeMirror update 链传播把编辑器拖崩。
    function safe<T>(ref: T | undefined, name: string): T | null {
      if (ref === undefined) {
        console.warn(`[searchPanel] DOM 引用缺失: ${name}`);
        return null;
      }
      return ref;
    }

    function currentQuery(): SearchQuery {
      const caseBtn = safe(refs.caseBtn, 'caseBtn');
      const regexpBtn = safe(refs.regexpBtn, 'regexpBtn');
      const wordBtn = safe(refs.wordBtn, 'wordBtn');
      return new SearchQuery({
        search: refs.searchInput?.value ?? '',
        replace: refs.replaceInput?.value ?? '',
        caseSensitive: caseBtn?.getAttribute('aria-pressed') === 'true',
        regexp: regexpBtn?.getAttribute('aria-pressed') === 'true',
        wholeWord: wordBtn?.getAttribute('aria-pressed') === 'true',
      });
    }

    function dispatchQuery() {
      view.dispatch({ effects: setSearchQuery.of(currentQuery()) });
    }

    function syncToggles(q: SearchQuery) {
      const set = (b: HTMLButtonElement | null, on: boolean) =>
        b?.setAttribute('aria-pressed', on ? 'true' : 'false');
      set(safe(refs.caseBtn, 'caseBtn'), q.caseSensitive);
      set(safe(refs.regexpBtn, 'regexpBtn'), q.regexp);
      set(safe(refs.wordBtn, 'wordBtn'), q.wholeWord);
    }

    // ---- 匹配计数（150ms 防抖；文档超 1 万行显示 …）----
    let countTimer: number | undefined;
    let lastSearch = '';
    let lastDocRev = -1;

    function scheduleCount() {
      window.clearTimeout(countTimer);
      countTimer = window.setTimeout(() => {
        const search = refs.searchInput.value;
        const rev = view.state.doc.toString().length; // 粗略版本号：内容长度变化即重算
        if (search === lastSearch && rev === lastDocRev) return;
        lastSearch = search;
        lastDocRev = rev;
        if (!search) { refs.countEl.textContent = ''; return; }
        if (view.state.doc.lines > 10000) { refs.countEl.textContent = '…'; return; }
        try {
          const q = getSearchQuery(view.state);
          let total = 0;
          const cursor = q.getCursor(view.state.doc);
          while (!cursor.next().done && total < 9999) total++;
          refs.countEl.textContent = total > 0
            ? `${Math.min(total, 9999)} ${t('matchesUnit')}`
            : t('noMatch');
        } catch {
          // 非法正则输入中途态：不显示计数
          refs.countEl.textContent = '';
        }
      }, 150);
    }

    refs.searchInput.addEventListener('input', () => { dispatchQuery(); scheduleCount(); });
    refs.replaceInput.addEventListener('input', dispatchQuery);
    refs.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); findNext(view); }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); findPrevious(view); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        // 面板输入框不经 CM keymap：手动接管，否则落到浏览器默认查找。
        e.preventDefault();
        refs.searchInput.select();
      }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); setExpanded(!replaceExpanded); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); }
    });
    refs.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); replaceNext(view); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        refs.searchInput.focus();
        refs.searchInput.select();
      }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); setExpanded(!replaceExpanded); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); }
    });

    for (const b of [refs.caseBtn, refs.regexpBtn, refs.wordBtn]) {
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        dispatchQuery();
        scheduleCount();
      });
    }

    // ---- Panel 接口 ----
    return {
      dom: root,
      top: true,
      mount() {
        // 注册面板引用（菜单 openSearch 用）；面板关闭时由 Panel destroy 清理。
        activeRefs = { search: refs.searchInput, replace: refs.replaceInput };
        applyReplaceMode = setExpanded; // openSearch 即时切换替换行模式
        // focus/select 逐个守卫：面板挂载异常绝不能沿 update 链传播。
        try {
          refs.searchInput?.focus();
          refs.searchInput?.select();
          syncToggles(getSearchQuery(view.state));
          scheduleCount();
        } catch (err) {
          console.warn('[searchPanel] mount 异常已兜底:', err);
        }
      },
      destroy() {
        if (activeRefs && activeRefs.search === refs.searchInput) activeRefs = null;
        applyReplaceMode = null;
      },
      update(u) {
        // 官方 keymap/外部 effect 改了 query 时回填 UI
        try {
          const q = getSearchQuery(u.state);
          if (refs.searchInput && q.search !== lastSearch) {
            refs.searchInput.value = q.search;
            lastSearch = q.search;
            scheduleCount();
          }
          if (refs.replaceInput && refs.replaceInput.value !== q.replace) {
            refs.replaceInput.value = q.replace;
          }
          syncToggles(q);
        } catch (err) {
          console.warn('[searchPanel] update 异常已兜底:', err);
        }
      },
    } satisfies Panel;
  };
}
