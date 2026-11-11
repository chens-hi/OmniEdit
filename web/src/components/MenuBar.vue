<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useEditorStore } from '../store';
import { sdk } from '../api';
import { t, lang } from '../i18n';

/**
 * 顶部菜单栏（文件/编辑/视图/帮助）。
 * 数据驱动渲染；点击展开、悬停切换（打开时）、Esc/外点关闭。
 * 动作通过 emit 上抛（需要访问 App.vue 内的 view 实例的动作），
 * 纯 store 动作直接调用。
 */

const store = useEditorStore();

const emit = defineEmits<{
  (e: 'find', mode: 'find' | 'replace'): void;
  (e: 'about'): void;
}>();

/** 菜单项定义 */
interface MenuItem {
  type: 'item' | 'sep' | 'checkbox' | 'radio';
  label?: string;
  shortcut?: string;
  disabled?: () => boolean;
  /** checkbox 勾选态（必须为函数——模板统一以 item.checked?.() 调用） */
  checked?: () => boolean;
  /** radio 选中态（必须为函数——模板统一以 item.selected?.() 调用，传布尔会在运行时崩） */
  selected?: () => boolean;
  action?: () => void;
  radioGroup?: string;
  radioValue?: unknown;
  /** 二级子菜单：父项悬停展开右侧弹层 */
  children?: MenuItem[];
  /** 父项右侧的动态值（如缩进当前宽度） */
  valueText?: () => string;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

// ---- 动作 ----

function doFind(mode: 'find' | 'replace') {
  openMenu.value = null;
  emit('find', mode);
}

function doExit() {
  openMenu.value = null;
  if (!sdk.isStandaloneWeb) {
    void sdk.close();
  }
}

// 文件菜单的保存/另存为/关闭：均作用于当前活动标签（触摸端唯一保存入口）。
function doSave() {
  openMenu.value = null;
  void store.saveActive();
}
function doSaveAs() {
  openMenu.value = null;
  store.saveAsVisible = true;
}
function doClose() {
  openMenu.value = null;
  if (store.activeTab) void store.closeTab(store.activeTab.id);
}

/** 还原初始状态：二次确认后清空设置/标签并写回后端（破坏性，不可撤销）。 */
async function doReset() {
  openMenu.value = null;
  if (!(await store.confirm(t('resetConfirm'), { danger: true }))) return;
  void store.resetToDefaults();
}

// ---- 菜单定义 ----

const menus = computed<Menu[]>((): Menu[] => {
  const tab = store.activeTab;
  const canSave = !!tab && !!tab.path && tab.dirty;
  const fileItems: MenuItem[] = [
    { type: 'item', label: t('menuNew'), action: () => { openMenu.value = null; store.newUntitled(); } },
    { type: 'item', label: t('menuOpen'), action: () => { openMenu.value = null; void store.openViaPicker(); } },
  ];
  // 无活动页签时：隐藏 保存/另存/关闭 整组（含其上方分割线），只留 新建/打开/退出。
  // 分割线随分组一起条件渲染，避免出现孤立/多余的分割线。
  if (tab) {
    fileItems.push(
      { type: 'sep' },
      { type: 'item', label: t('menuSave'), shortcut: 'Ctrl+S', disabled: () => !canSave, action: doSave },
      { type: 'item', label: t('menuSaveAs'), action: doSaveAs },
      { type: 'item', label: t('close'), action: doClose },
      { type: 'sep' },
    );
  }
  fileItems.push({ type: 'item', label: t('menuExit'), action: doExit });

  const canSearch = !!tab && !tab.loading;

  return [
    { label: t('menuFile'), items: fileItems },
    {
      label: t('menuEdit'),
      items: [
        { type: 'item', label: t('menuFind'), shortcut: 'Ctrl+F', disabled: () => !canSearch, action: () => doFind('find') },
        { type: 'item', label: t('menuReplace'), shortcut: 'Ctrl+H', disabled: () => !canSearch, action: () => doFind('replace') },
      ],
    },
    {
      label: t('menuView'),
      items: [
        {
          // 显示符号 ▸ 行号/空格/制表符/换行符（Notepad++ 显示符号风格）
          type: 'item',
          label: t('menuDisplay'),
          children: [            {
              type: 'checkbox',
              label: t('menuLineNumbers'),
              checked: () => store.showLineNumbers,
              action: () => store.setShowLineNumbers(!store.showLineNumbers),
            },
            {
              type: 'checkbox',
              label: t('showSpacesLabel'),
              checked: () => store.showSpaces,
              action: () => store.setShowSpaces(!store.showSpaces),
            },
            {
              type: 'checkbox',
              label: t('showTabsLabel'),
              checked: () => store.showTabs,
              action: () => store.setShowTabs(!store.showTabs),
            },
            {
              type: 'checkbox',
              label: t('showLineEndingsLabel'),
              checked: () => store.showLineBreaks,
              action: () => store.setShowLineBreaks(!store.showLineBreaks),
            },
          ],
        },
        {
          // 缩进风格 ▸ 具体选项勾选：空格 2/4/8 或 制表符。
          // 父项右侧按当前选择显示：空格 2/4/8 或 制表符。
          type: 'item',
          label: t('menuIndent'),
          valueText: () => (store.indentMode === 'spaces' ? `${t('menuIndentSpaces')} ${store.indentWidth}` : t('menuIndentTabFixed')),
          children: [
            { type: 'checkbox', label: `${t('menuIndentSpaces')} 2`, checked: () => store.indentMode === 'spaces' && store.indentWidth === 2, action: () => store.setIndentMode('spaces', 2) },
            { type: 'checkbox', label: `${t('menuIndentSpaces')} 4`, checked: () => store.indentMode === 'spaces' && store.indentWidth === 4, action: () => store.setIndentMode('spaces', 4) },
            { type: 'checkbox', label: `${t('menuIndentSpaces')} 8`, checked: () => store.indentMode === 'spaces' && store.indentWidth === 8, action: () => store.setIndentMode('spaces', 8) },
            { type: 'checkbox', label: t('menuIndentTabFixed'), checked: () => store.indentMode === 'tabs', action: () => store.setIndentMode('tabs', 4) },
          ],
        },
        { type: 'checkbox', label: t('menuWordWrap'), checked: () => store.lineWrapping, action: () => store.setLineWrapping(!store.lineWrapping) },
        { type: 'sep' },
        {
          // 主题 ▸ 自动（跟随宿主系统）/浅色/深色，存配置表默认自动。
          // 父项右侧显示当前模式；描述始终为所选模式名（自动不附解析结果）。
          type: 'item',
          label: t('menuTheme'),
          valueText: () => store.themeMode === 'auto' ? t('themeAuto')
            : store.themeMode === 'light' ? t('themeLight') : t('themeDark'),
          children: [
            { type: 'checkbox', label: t('themeAuto'), checked: () => store.themeMode === 'auto', action: () => store.setThemeMode('auto') },
            { type: 'checkbox', label: t('themeLight'), checked: () => store.themeMode === 'light', action: () => store.setThemeMode('light') },
            { type: 'checkbox', label: t('themeDark'), checked: () => store.themeMode === 'dark', action: () => store.setThemeMode('dark') },
          ],
        },
        {
          // 字体：子菜单勾选内置字体（默认 JetBrains Mono）。父项右置当前字体名。
          type: 'item',
          label: t('menuFont'),
          valueText: () => store.builtinFonts.find(f => f.id === store.fontFamily)?.name ?? store.fontFamily,
          children: store.builtinFonts.map(f => ({
            type: 'checkbox' as const,
            label: f.name,
            checked: () => store.fontFamily === f.id,
            action: () => store.setFontFamily(f.id),
          })),
        },
        {
          // 字号 ▸ 具体选项勾选（12/14/16/18/20）。数值右置（valueText），对齐缩进渲染。
          type: 'item',
          label: t('menuFontSizeItem'),
          valueText: () => `${store.fontSize}`,
          children: [12, 14, 16, 18, 20].map(n => ({
            type: 'checkbox' as const,
            label: `${n}`,
            checked: () => store.fontSize === n,
            action: () => store.setFontSize(n),
          })),
        },
      ],
    },
    {
      label: t('menuHelp'),
      items: [
        { type: 'item', label: t('menuAbout'), action: () => { openMenu.value = null; emit('about'); } },
        { type: 'sep' },
        { type: 'item', label: t('menuReset'), action: doReset },
      ],
    },
  ] as Menu[];
});

// ---- 窄屏检测（抽屉菜单触发）----
// 用 pointer/宽度媒体查询而非 UA 嗅探：窄窗口或触摸设备都会走抽屉形态。
// 桌面（宽屏 + 鼠标）保持原横排菜单，零影响。
const narrowMq =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(max-width: 768px), (pointer: coarse)')
    : null;
const isNarrow = ref(narrowMq?.matches ?? false);
function onNarrowChange(e: MediaQueryListEvent) {
  isNarrow.value = e.matches;
  if (!e.matches) closeDrawer(); // 切回宽屏时收起抽屉
}

// ---- 展开状态与交互 ----

const openMenu = ref<number | null>(null);
const subOpen = ref<number | null>(null); // 当前展开的二级子菜单（父项 index）

// ---- 抽屉（窄屏）状态 ----
const drawerOpen = ref(false);
const openGroup = ref<number | null>(null); // 抽屉内展开的菜单组
const drawerSub = ref<number | null>(null); // 组内内联展开的二级子菜单

function toggleGroup(idx: number) {
  openGroup.value = openGroup.value === idx ? null : idx;
  drawerSub.value = null;
}
function toggleDrawerSub(iidx: number) {
  drawerSub.value = drawerSub.value === iidx ? null : iidx;
}
/**
 * 抽屉内点击叶子项：复选/单选保留抽屉（可连续切换并看到勾选态刷新），
 * 普通动作项执行后关闭抽屉（与桌面「动作后收起菜单」语义一致）。
 */
function onDrawerItemClick(item: MenuItem) {
  if (item.disabled?.()) return;
  item.action?.();
  if (item.type === 'checkbox' || item.type === 'radio') return;
  closeDrawer();
}
function closeDrawer() {
  drawerOpen.value = false;
  openGroup.value = null;
  drawerSub.value = null;
}
function onItemClick(item: MenuItem) {
  item.action?.();
}
// keepOpen 计数：子菜单点击后不关闭面板（响应式触发重渲染以刷新 valueText/
// selected），点击其他模式或外部/Esc 时才关闭。
const keepOpenCount = ref(0);
const rootEl = ref<HTMLElement | null>(null);

function toggleMenu(idx: number) {
  openMenu.value = openMenu.value === idx ? null : idx;
  subOpen.value = null;
}

function onMenuEnter(idx: number) {
  if (openMenu.value !== null) openMenu.value = idx; // 已有打开时悬停切换
}

function onGlobalClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) openMenu.value = null;
}

function onGlobalKey(e: KeyboardEvent) {
  if (e.key === 'Escape') openMenu.value = null;
}

onMounted(() => {
  document.addEventListener('click', onGlobalClick);
  document.addEventListener('keydown', onGlobalKey);
  narrowMq?.addEventListener('change', onNarrowChange);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onGlobalClick);
  document.removeEventListener('keydown', onGlobalKey);
  narrowMq?.removeEventListener('change', onNarrowChange);
});

// 语言引用防 tree-shake（i18n 响应式依赖）
void lang;
</script>

<template>
  <nav ref="rootEl" class="menubar">
    <!-- 窄屏触发器：汉堡按钮（宽屏不渲染） -->
    <button
      v-if="isNarrow"
      class="m-burger"
      :aria-expanded="drawerOpen"
      aria-label="Menu"
      @click.stop="drawerOpen = !drawerOpen"
    >
      <span class="m-burger-bar" /><span class="m-burger-bar" /><span class="m-burger-bar" />
    </button>

    <div
      v-for="(menu, idx) in menus"
      v-show="!isNarrow"
      :key="menu.label"
      class="m-top"
      :class="{ open: openMenu === idx }"
      @click="toggleMenu(idx)"
      @mouseenter="onMenuEnter(idx)"
    >
      <span class="m-label">{{ menu.label }}</span>
      <div v-if="openMenu === idx" class="m-drop">
        <template v-for="(item, iidx) in menu.items" :key="iidx">
          <div v-if="item.type === 'sep'" class="m-sep" />
          <div
            v-else-if="item.children"
            class="m-item m-has-sub"
            @mouseenter="subOpen = iidx"
            @mouseleave="subOpen = null"
          >
            <span class="m-mark">{{ item.selected?.() ? '●' : '' }}</span>
            <span class="m-text">{{ item.label }}</span>
            <span v-if="item.valueText" class="m-shortcut">{{ item.valueText() }}</span>
            <span class="m-arrow">▸</span>
            <div v-if="subOpen === iidx" class="m-subdrop">
              <template v-for="(child, cidx) in item.children" :key="cidx">
                <div v-if="child.type === 'sep'" class="m-sep" />
                <button
                  v-else
                  class="m-item"
                  :class="{
                    disabled: child.disabled?.(),
                    radio: child.type === 'radio',
                    selected: child.type === 'radio' && child.selected?.(),
                  }"
                  :disabled="child.disabled?.()"
                  @click.stop="onItemClick(child); keepOpenCount++; subOpen = iidx"
                >
                  <span class="m-mark">{{ child.type === 'checkbox' ? (child.checked?.() ? '✓' : '') : child.type === 'radio' ? (child.selected?.() ? '●' : '○') : '' }}</span>
                  <span class="m-text">{{ child.label }}</span>
                  <span v-if="child.shortcut" class="m-shortcut">{{ child.shortcut }}</span>
                </button>
              </template>
            </div>
          </div>
          <button
            v-else
            class="m-item"
            :class="{
              disabled: item.disabled?.(),
              checked: item.type === 'checkbox' && item.checked?.(),
              radio: item.type === 'radio',
              selected: item.type === 'radio' && item.selected?.(),
            }"
            :disabled="item.disabled?.()"
            @click.stop="onItemClick(item)"
          >
            <span class="m-mark">
              {{ item.type === 'checkbox' ? (item.checked?.() ? '✓' : '') : item.type === 'radio' ? (item.selected?.() ? '●' : '○') : '' }}
            </span>
            <span class="m-text">{{ item.label }}</span>
            <span v-if="item.valueText" class="m-shortcut">{{ item.valueText() }}</span>
            <span v-if="item.shortcut" class="m-shortcut">{{ item.shortcut }}</span>
          </button>
        </template>
      </div>
    </div>
  </nav>

  <!-- 窄屏抽屉：覆盖层 + 左侧手风琴面板 -->
  <template v-if="isNarrow && drawerOpen">
    <div class="m-overlay" @click="closeDrawer" />
    <aside class="m-drawer" role="menu">
      <div class="m-drawer-body">
        <div v-for="(menu, idx) in menus" :key="menu.label" class="m-group">
          <button class="m-group-head" @click="toggleGroup(idx)">
            <span class="m-text">{{ menu.label }}</span>
            <span class="m-group-arrow">{{ openGroup === idx ? '▾' : '▸' }}</span>
          </button>
          <div v-if="openGroup === idx" class="m-group-body">
            <template v-for="(item, iidx) in menu.items" :key="iidx">
              <div v-if="item.type === 'sep'" class="m-sep" />
              <!-- 二级子菜单：内联展开，避免窄屏右侧溢出 -->
              <div v-else-if="item.children" class="m-sub">
                <button class="m-item m-sub-head" @click="toggleDrawerSub(iidx)">
                  <span class="m-mark">{{ item.selected?.() ? '●' : '' }}</span>
                  <span class="m-text">{{ item.label }}</span>
                  <span v-if="item.valueText" class="m-shortcut">{{ item.valueText() }}</span>
                  <span class="m-arrow">{{ drawerSub === iidx ? '▾' : '▸' }}</span>
                </button>
                <div v-if="drawerSub === iidx" class="m-sub-body">
                  <button
                    v-for="(child, cidx) in item.children"
                    :key="cidx"
                    class="m-item m-sub-item"
                    :class="{
                      disabled: child.disabled?.(),
                      radio: child.type === 'radio',
                      selected: child.type === 'radio' && child.selected?.(),
                    }"
                    :disabled="child.disabled?.()"
                    @click="onDrawerItemClick(child)"
                  >
                    <span class="m-mark">{{ child.type === 'checkbox' ? (child.checked?.() ? '✓' : '') : child.type === 'radio' ? (child.selected?.() ? '●' : '○') : '' }}</span>
                    <span class="m-text">{{ child.label }}</span>
                  </button>
                </div>
              </div>
              <button
                v-else
                class="m-item"
                :class="{
                  disabled: item.disabled?.(),
                  checked: item.type === 'checkbox' && item.checked?.(),
                  radio: item.type === 'radio',
                  selected: item.type === 'radio' && item.selected?.(),
                }"
                :disabled="item.disabled?.()"
                @click="onDrawerItemClick(item)"
              >
                <span class="m-mark">
                  {{ item.type === 'checkbox' ? (item.checked?.() ? '✓' : '') : item.type === 'radio' ? (item.selected?.() ? '●' : '○') : '' }}
                </span>
                <span class="m-text">{{ item.label }}</span>
                <span v-if="item.shortcut" class="m-shortcut">{{ item.shortcut }}</span>
              </button>
            </template>
          </div>
        </div>
      </div>
    </aside>
  </template>
</template>

<style scoped>
.menubar {
  display: flex;
  align-items: stretch;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  user-select: none;
  position: relative;
  z-index: 50;
}

.m-top {
  position: relative;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fg);
}
.m-top:hover, .m-top.open { background: rgba(255, 255, 255, 0.08); }

.m-drop {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 220px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  padding: 4px;
  z-index: 60;
}

.m-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--fg);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  text-align: left;
}
.m-item:hover:not(.disabled) { background: rgba(255, 255, 255, 0.08); }
.m-item.disabled { opacity: 0.4; cursor: default; }

.m-mark { width: 14px; flex-shrink: 0; text-align: center; color: var(--accent); }
.m-text { flex: 1; }
.m-shortcut { color: #888; font-size: 11px; }

.m-sep { height: 1px; background: var(--border); margin: 4px 8px; }

/* 二级子菜单 */
.m-has-sub { position: relative; cursor: pointer; }
.m-has-sub:hover { background: rgba(255, 255, 255, 0.08); }
.m-arrow { color: #888; font-size: 11px; margin-left: 4px; }
.m-subdrop {
  position: absolute;
  top: -5px;
  left: 100%;
  min-width: 170px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  padding: 4px;
  z-index: 70;
}

/* ---------- 窄屏抽屉 ---------- */

/* 汉堡触发器：≥44px 触摸目标，宽屏不渲染（v-if） */
.m-burger {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 4px;
  width: 44px;
  height: 40px;
  margin: 0 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  border-radius: 6px;
  flex-shrink: 0;
}
.m-burger:hover { background: rgba(255, 255, 255, 0.08); }
.m-burger-bar {
  display: block;
  width: 20px;
  height: 2px;
  background: currentColor;
  border-radius: 1px;
}

/* 覆盖层：遮住编辑区，点击关闭；背景高斯模糊突出抽屉层级 */
.m-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px); /* Safari */
  z-index: 100;
  animation: mFadeIn 0.15s ease-out;
}
@keyframes mFadeIn { from { opacity: 0; } to { opacity: 1; } }

/* 抽屉面板：左侧滑入，宽度不超过屏宽 85%。
   层级（自适应主题）：抽屉底 --bg → 分组头 --toolbar-bg 色带（左侧 accent 竖条）
   → 展开内容 --bg 缩进面板。三段靠色带与缩进区分，不糊在一起。 */
.m-drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(320px, 85vw);
  background: var(--bg);
  border-right: 1px solid var(--border);
  z-index: 101;
  display: flex;
  flex-direction: column;
  animation: mSlideIn 0.2s ease-out;
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.35);
}
@keyframes mSlideIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }

.m-drawer-body {
  flex: 1;
  overflow-y: auto;
  /* 隐藏滚动条（与 TabBar 一致；移动端抽屉靠手势滚动，不需要滚动条），
     避免内容较长时右侧出现滚动条被误认为色块 */
  scrollbar-width: none;
  /* 菜单贴齐抽屉顶部（不额外留顶部空隙）；底部留白给最后一项呼吸 */
  padding: 0 0 24px;
}
.m-drawer-body::-webkit-scrollbar { display: none; }

/* 手风琴分组头：--toolbar-bg 色带 + 左侧 accent 竖条，作为醒目分区头 */
.m-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 48px;
  padding: 0 14px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  background: var(--toolbar-bg);
  color: var(--fg);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}
.m-group-head:hover { background: color-mix(in srgb, var(--toolbar-bg) 80%, var(--fg) 8%); }
.m-group-arrow { color: var(--fg-muted); font-size: 12px; }
/* 展开的菜单内容区：落在 --bg 主表面，左侧缩进体现从属于分组头 */
.m-group-body {
  padding: 6px 0 10px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

/* 抽屉内菜单项：加大触摸目标（≥44px 高），覆盖桌面的小 padding */
.m-drawer .m-item {
  min-height: 44px;
  padding: 8px 14px;
  font-size: 14px;
  gap: 10px;
}
.m-drawer .m-sub-head { font-weight: 500; }
.m-drawer .m-sub-item { padding-left: 34px; } /* 缩进体现层级 */
.m-drawer .m-arrow { margin-left: 2px; }

</style>
