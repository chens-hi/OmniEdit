import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
  WidgetType,
  EditorView,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

/**
 * 空白符号可见化（Notepad++「显示符号」风格）。
 *
 * 三类符号：空格 ·、制表符 →（居中箭头）、行尾 ↩。
 *
 * 实现策略：
 *   - 空格 → mark（背景圆点，不影响布局）
 *   - Tab  → replace + Widget：把 tab 字符从 DOM 整个替换成固定像素宽的箭头 widget。
 *     关键：用 mark 套 span 会改变浏览器对 tab 字符的 tab-stop 计算，导致「显示/不显示
 *     制表符宽度不一致」；replace 后宽度由我们按 tab-stop 显式计算，显示与否完全一致，
 *     且竖直位置全控（可精确居中于相邻文字）。
 *   - 行尾 ↩ → widget side:1（零宽叠加）
 */

export interface WhitespaceConfig {
  showSpaces: boolean;
  showTabs: boolean;
  showLineBreaks: boolean;
}

/** 行尾 ↩ */
class LineBreakWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ls-mark';
    span.textContent = '↩';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const lineBreakDeco = Decoration.widget({ widget: new LineBreakWidget(), side: 1 });
const spaceDeco = Decoration.mark({ class: 'cm-ws-space' });
// 制表符：用 mark 保留**真 tab 字符**，宽度由浏览器原生决定（含 CJK 混排也正确），
// 箭头用 mask-image 背景画在 mark 上（随原生宽度自适应，零计算）。
// 之前用 replace+Widget 需自算像素宽，而宽度在混排 CJK 行里算不准（中文占 ~2 列），
// 导致显示/不显示制表符宽度不一致——回到 mark 从根上消除该问题。
const tabDeco = Decoration.mark({ class: 'cm-ws-tab' });

function buildDecorations(view: EditorView, cfg: WhitespaceConfig): DecorationSet {
  if (!cfg.showSpaces && !cfg.showTabs && !cfg.showLineBreaks) {
    return Decoration.none;
  }

  const doc = view.state.doc;
  const { from, to } = view.viewport;
  const pending: { from: number; to: number; deco: Decoration }[] = [];

  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos);
    const text = line.text;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === ' ' && cfg.showSpaces) {
        pending.push({ from: line.from + i, to: line.from + i + 1, deco: spaceDeco });
      } else if (ch === '\t' && cfg.showTabs) {
        pending.push({ from: line.from + i, to: line.from + i + 1, deco: tabDeco });
      }
    }

    if (cfg.showLineBreaks && line.to < doc.length) {
      pending.push({ from: line.to, to: line.to, deco: lineBreakDeco });
    }
    pos = line.to + 1;
  }

  pending.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of pending) builder.add(d.from, d.to, d.deco);
  return builder.finish();
}

export function whitespaceExtensions(getCfg: () => WhitespaceConfig) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, getCfg());
      }
      update(u: ViewUpdate) {
        this.decorations = buildDecorations(u.view, getCfg());
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, whitespaceTheme];
}

export const whitespaceTheme = EditorView.baseTheme({
  // 空格：底色小圆点
  '.cm-ws-space': {
    backgroundImage: 'radial-gradient(circle, var(--ws-dot-color) 1px, transparent 1.2px)',
    backgroundSize: '100% 100%',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  },
  // 制表符：mark 保留真 tab 字符（宽度由浏览器原生决定，CJK 混排也正确），只用
  // 背景渐变在垂直居中处画一条 1px 横线。inline 元素背景可渲染（同空格圆点机制），
  // 不改布局 → 显示/不显示制表符宽度一致，点击/光标由真 tab 字符原生处理。
  '.cm-ws-tab': {
    backgroundImage: 'linear-gradient(var(--ws-line-color), var(--ws-line-color))',
    backgroundSize: '100% 1px',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  },
  // 行尾 ↩：零宽叠加
  '.cm-ls-mark': {
    color: 'var(--ws-mark-color)',
    pointerEvents: 'none',
    display: 'inline-block',
    width: '0',
    overflow: 'visible',
    whiteSpace: 'nowrap',
    fontSize: '0.9em',
  },
});
