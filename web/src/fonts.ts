/**
 * 内置字体注册表 + 编辑器字体应用（字体切换的单一事实来源）。
 *
 * 加一个内置字体 = ① 丢 woff2 进 assets/fonts/ ② 在 assets/fonts/fonts.css 补
 * @font-face（含 unicode-range）③ 在下方 BUILTIN_FONTS 加一条。
 * 字体切换即时生效：写 document.documentElement 的 --font-mono 变量，
 * 代码区/行号（CM theme 的 var(--font-mono)）都消费它，无需重建编辑器。
 */

export interface BuiltinFont {
  /** 稳定标识（存 prefs 用，勿改）。 */
  id: string;
  /** 展示名（菜单 UI 用）。 */
  name: string;
  /** @font-face 的 font-family 名（须与 fonts.css 声明一致）。 */
  family: string;
}

/** 内置等宽字体清单（顺序即菜单顺序；首个为默认）。 */
export const BUILTIN_FONTS: BuiltinFont[] = [
  { id: 'jetbrains-mono', name: 'JetBrains Mono', family: 'JetBrains Mono' },
  // 将来内置更多时在此追加，如：
  // { id: 'cascadia-code', name: 'Cascadia Code', family: 'Cascadia Code' },
  // { id: 'fira-code',     name: 'Fira Code',     family: 'Fira Code' },
];

/** 默认字体 id（JetBrains Mono）。 */
export const DEFAULT_FONT_ID = BUILTIN_FONTS[0].id;

/** 系统等宽回退栈（不打包，零成本）+ 中文回退（JetBrains Mono 不含 CJK）。 */
const SYSTEM_MONO_FALLBACK =
  "'Cascadia Code', Consolas, 'Courier New', monospace, 'Microsoft YaHei', 'PingFang SC', sans-serif";

/** 按字体 id 生成完整 font-family 栈：选中字体 → 系统等宽 → 中文回退。 */
export function fontStack(id: string): string {
  const font = BUILTIN_FONTS.find(f => f.id === id) ?? BUILTIN_FONTS[0];
  return `'${font.family}', ${SYSTEM_MONO_FALLBACK}`;
}

/** 把字体栈写到 <html> 的 --font-mono 变量（代码区/行号 CSS 消费它）。 */
export function applyEditorFont(id: string): void {
  document.documentElement.style.setProperty('--font-mono', fontStack(id));
}
