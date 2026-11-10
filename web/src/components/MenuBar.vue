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
  (e: 'shortcuts'): void;
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
  /** 点击循环项：点击时闪烁 accent 高亮作为反馈 */
  cycle?: boolean;
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

function doSaveAs() {
  openMenu.value = null;
  // 另存为：打开对话框（mode 由 App 侧按 activeTab.path 决定）
  store.saveAsVisible = true;
}

function doExit() {
  openMenu.value = null;
  if (!sdk.isStandaloneWeb) {
    void sdk.close();
  }
}

/** 显示子菜单父项右侧的当前值摘要（有任一符号开启即显示"符号: 开"）。 */
function displayValueText(): string {
  if (store.showSpaces || store.showTabs || store.showLineBreaks) return t('showOn');
  return t('showOff');
}

// ---- 菜单定义 ----

const saveItem = computed<MenuItem | null>(() => {
  const tab = store.activeTab;
  if (!tab) return null;
  if (!tab.path) {
    // 草稿：只显示「保存为…」
    return { type: 'item', label: t('menuSaveAs'), action: doSaveAs };
  }
  const canSave = tab.dirty;
  const items: MenuItem[] = [
    { type: 'item', label: t('menuSave'), shortcut: 'Ctrl+S', disabled: () => !canSave, action: () => { openMenu.value = null; store.saveActive(); } },
    { type: 'item', label: t('menuSaveAs'), action: doSaveAs },
  ];
  return items[0];
});

const menus = computed<Menu[]>((): Menu[] => {
  const tab = store.activeTab;
  const fileItems: MenuItem[] = [
    { type: 'item', label: t('menuNew'), shortcut: 'Ctrl+N', action: () => { openMenu.value = null; store.newUntitled(); } },
    { type: 'item', label: t('menuOpen'), shortcut: 'Ctrl+O', action: () => { openMenu.value = null; void store.openViaPicker(); } },
    { type: 'sep' },
  ];
  if (saveItem.value) fileItems.push(saveItem.value);
  if (tab && tab.path) {
    fileItems.push({ type: 'item', label: t('menuSaveAs'), action: doSaveAs });
  }
  fileItems.push(
    { type: 'sep' },
    { type: 'item', label: t('menuExit'), action: doExit },
  );

  const canSearch = !!tab && !tab.loading;

  return [
    { label: t('menuFile'), items: fileItems },
    {
      label: t('menuEdit'),
      items: [
        { type: 'item', label: t('menuFind'), shortcut: 'Ctrl+F', disabled: () => !canSearch, action: () => doFind('find') },
        { type: 'item', label: t('menuReplace'), disabled: () => !canSearch, action: () => doFind('replace') },
      ],
    },
    {
      label: t('menuView'),
      items: [
        {
          // 显示 ▸ 行号/空格/制表符/换行符（Notepad++ 显示符号风格）
          type: 'item',
          label: t('menuDisplay'),
          valueText: () => displayValueText(),
          children: [
            {
              type: 'radio',
              label: t('menuLineNumbers'),
              radioGroup: 'display',
              selected: () => store.showLineNumbers,
              action: () => store.setShowLineNumbers(!store.showLineNumbers),
            },
            { type: 'sep' },
            {
              type: 'radio',
              label: t('showSpacesLabel'),
              radioGroup: 'display',
              selected: () => store.showSpaces,
              action: () => store.setShowSpaces(!store.showSpaces),
            },
            {
              type: 'radio',
              label: t('showTabsLabel'),
              radioGroup: 'display',
              selected: () => store.showTabs,
              action: () => store.setShowTabs(!store.showTabs),
            },
            {
              type: 'radio',
              label: t('showLineEndingsLabel'),
              radioGroup: 'display',
              selected: () => store.showLineBreaks,
              action: () => store.setShowLineBreaks(!store.showLineBreaks),
            },
          ],
        },
        { type: 'checkbox', label: t('menuWordWrap'), checked: () => store.lineWrapping, action: () => store.setLineWrapping(!store.lineWrapping) },
        { type: 'sep' },
        {
          // 缩进 ▸ 空格（点击循环 2→4→8→2）/ 制表符（固定 4）
          // 父项右侧按当前选择显示：空格 2/4/8 或 制表符。循环项无圆点。
          type: 'item',
          label: t('menuIndent'),
          valueText: () => (store.indentMode === 'spaces' ? `${t('menuIndentSpacesCycle')} ${store.indentWidth}` : t('menuIndentTabFixed')),
          children: [
            {
              type: 'item',
              label: t('menuIndentSpacesCycle'),
              cycle: true,
              action: () => store.cycleIndentWidth(),
            },
            {
              type: 'item',
              label: t('menuIndentTabFixed'),
              cycle: true,
              action: () => store.setIndentMode('tabs', 4),
            },
          ],
        },
        { type: 'sep' },
        {
          // 字号：点击循环 12→14→16→18→20→12。数值右置（valueText），对齐缩进渲染。
          type: 'item',
          label: t('menuFontSizeItem'),
          valueText: () => `${store.fontSize}`,
          cycle: true,
          action: () => store.cycleFontSize(),
        },
      ],
    },
    {
      label: t('menuHelp'),
      items: [
        { type: 'item', label: t('menuShortcuts'), action: () => { openMenu.value = null; emit('shortcuts'); } },
        { type: 'item', label: t('menuAbout'), action: () => { openMenu.value = null; emit('about'); } },
      ],
    },
  ] as Menu[];
});

// ---- 展开状态与交互 ----

const openMenu = ref<number | null>(null);
const subOpen = ref<number | null>(null); // 当前展开的二级子菜单（父项 index）
// 点击反馈：记录正在闪烁的菜单项标识（150ms 后清除，CSS 动画渐出）。
const flashItem = ref<string>('');
let flashTimer: number | undefined;
function flashOf(item: MenuItem): string {
  return item.label ?? '';
}
function onItemClick(item: MenuItem) {
  item.action?.();
  if (item.cycle) {
    flashItem.value = flashOf(item);
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => (flashItem.value = ''), 180);
  }
}
// keepOpen 计数：子菜单点击后不关闭面板（响应式触发重渲染以刷新 valueText/
// selected），点击非循环项（如另一模式）或外部/Esc 时才关闭。
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
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onGlobalClick);
  document.removeEventListener('keydown', onGlobalKey);
});

// 语言引用防 tree-shake（i18n 响应式依赖）
void lang;
</script>

<template>
  <nav ref="rootEl" class="menubar">
    <div
      v-for="(menu, idx) in menus"
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
                    flash: child.cycle && flashItem === child.label,
                  }"
                  :disabled="child.disabled?.()"
                  @click.stop="onItemClick(child); keepOpenCount++; subOpen = iidx"
                >
                  <span class="m-mark">{{ child.type === 'radio' ? (child.selected?.() ? '●' : '○') : '' }}</span>
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
              flash: item.cycle && flashItem === item.label,
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

/* 循环项点击反馈：accent 闪烁 180ms 渐出 */
.m-item.flash {
  animation: mflash 180ms ease-out;
}
@keyframes mflash {
  from { background: rgba(255, 255, 255, 0.18); }
  to { background: transparent; }
}

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
</style>
