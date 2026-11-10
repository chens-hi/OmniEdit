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

/**
 * 制表符 → widget：固定像素宽（= 该 tab 的 tab-stop 宽度），内部绝对定位画
 * 居中横杆 + 右端箭头尖。宽度显式 → 显示/不显示制表符布局完全一致。
 */
class TabWidget extends WidgetType {
  constructor(readonly widthPx: number) {
    super();
  }
  eq(other: TabWidget) {
    return other.widthPx === this.widthPx;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ws-tab';
    span.style.width = `${this.widthPx}px`;
    // 横杆（居中）+ 箭头尖（贴右、与横杆垂直对齐）
    const shaft = document.createElement('span');
    shaft.className = 'cm-ws-tab-shaft';
    const head = document.createElement('span');
    head.className = 'cm-ws-tab-head';
    span.appendChild(shaft);
    span.appendChild(head);
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  estimatedWidth() {
    return this.widthPx;
  }
  ignoreEvent() {
    return true;
  }
}

const lineBreakDeco = Decoration.widget({ widget: new LineBreakWidget(), side: 1 });
const spaceDeco = Decoration.mark({ class: 'cm-ws-space' });

function buildDecorations(view: EditorView, cfg: WhitespaceConfig): DecorationSet {
  if (!cfg.showSpaces && !cfg.showTabs && !cfg.showLineBreaks) {
    return Decoration.none;
  }

  const { state } = view;
  const tabSize = state.tabSize;
  // 单空格渲染宽度。诊断实测：defaultCharacterWidth == 单空格宽（== 16空格探针 ==
  // canvas measureText），浏览器原生 tab 宽 = slots × 该值。直接用它，宽度与原生一致，
  // 且不受首次 buildDecorations 时布局/字体未就绪的影响（自测探针在那一刻会量错）。
  const spaceW = cfg.showTabs ? view.defaultCharacterWidth : 0;
  const doc = state.doc;
  const { from, to } = view.viewport;
  const pending: { from: number; to: number; deco: Decoration }[] = [];

  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos);
    const text = line.text;

    if (cfg.showSpaces || cfg.showTabs) {
      let col = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\t' && cfg.showTabs) {
          const slots = tabSize - (col % tabSize);
          // 用实测单空格宽 × slots，与浏览器原生 tab 宽度口径一致（保留小数）
          const widthPx = Math.max(spaceW * slots, 1);
          pending.push({
            from: line.from + i,
            to: line.from + i + 1,
            deco: Decoration.replace({ widget: new TabWidget(widthPx), inclusive: false }),
          });
          col += slots;
        } else {
          if (ch === ' ' && cfg.showSpaces) {
            pending.push({ from: line.from + i, to: line.from + i + 1, deco: spaceDeco });
          }
          col += 1;
        }
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
  // Tab widget：固定像素宽（内联 style），高 1em，底边贴 baseline（无 in-flow 内容，
  // inline-block 基线=下边距边）。内部绝对定位画居中横杆 + 右端箭头尖 →。
  // cursor:text：widget 内部只有空 div（无文字节点），cursor:auto 会退回默认箭头，
  // 显式设 text 才与编辑器其它区域的 I-beam 光标一致。
  '.cm-ws-tab': {
    display: 'inline-block',
    position: 'relative',
    height: '1em',
    verticalAlign: 'baseline',
    cursor: 'text',
  },
  // 居中横杆：left:0 → right:0.5em（右侧留给箭头尖）。竖直位置 = 文字视觉中心。
  // 文字视觉中心约在 baseline 上方 0.4em；盒顶=baseline 上方 1em → 距盒顶 0.6em。
  '.cm-ws-tab-shaft': {
    position: 'absolute',
    left: '0',
    right: '0.5em',
    top: '0.6em',
    height: '1px',
    backgroundColor: 'var(--ws-line-color)',
    pointerEvents: 'none',
  },
  // 居中箭头尖：贴右端，竖直中心与横杆对齐（横杆在 0.6em，箭头高 0.85em → top 0.175em）。
  '.cm-ws-tab-head': {
    position: 'absolute',
    right: '0',
    top: '0.175em',
    width: '0.5em',
    height: '0.85em',
    backgroundColor: 'var(--ws-line-color)',
    WebkitMaskImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 12'%3E%3Cpath d='M1.5 1 L6.5 6 L1.5 11' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
    maskImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 12'%3E%3Cpath d='M1.5 1 L6.5 6 L1.5 11' fill='none' stroke='white' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskSize: '100% 100%',
    maskSize: '100% 100%',
    pointerEvents: 'none',
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
