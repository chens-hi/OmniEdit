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
 * 空白符号可见化（Notepad++「显示符号」风格）——**CodeMirror 原生 Decoration**。
 *
 * 只做三类符号：空格 ·、制表符 →、行尾 ↩。全部由 CM 自己管理视口/滚动/
 * 重排，不引入外部覆盖层，因此不存在坐标换算、滚动残影、节流重画等问题。
 *
 * 关键实现决策（v0.4.2 真机验证）：
 *   - 空格/Tab 用 **Decoration.mark**（保字符、只加样式类）——绝不用 replace，
 *     替换会把 · / → 的字宽强加给原字符位置，破坏等宽字体列对齐；
 *   - 行尾 ↩ 用 **Decoration.widget** 挂在 line.to（零宽叠加，不占布局宽度）；
 *   - mark/widget 都是 CM 视口级装饰，滚动/折行时 CM 自动重算，天然稳定。
 */

export interface WhitespaceConfig {
  showSpaces: boolean;
  showTabs: boolean;
  showLineBreaks: boolean;
}

/** 行尾 ↩（真实回车；widget 零宽叠加在行末，不参与布局） */
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
const tabDeco = Decoration.mark({ class: 'cm-ws-tab' });

/** 构建视口内装饰（每次 update 重建，CM 视口级，成本极低）。 */
function buildDecorations(view: EditorView, cfg: WhitespaceConfig): DecorationSet {
  if (!cfg.showSpaces && !cfg.showTabs && !cfg.showLineBreaks) {
    return Decoration.none;
  }

  const doc = view.state.doc;
  const { from, to } = view.viewport;
  const pending: { from: number; to: number; deco: Decoration }[] = [];

  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos);

    if (cfg.showSpaces || cfg.showTabs) {
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ' && cfg.showSpaces) {
          pending.push({ from: line.from + i, to: line.from + i + 1, deco: spaceDeco });
        } else if (ch === '\t' && cfg.showTabs) {
          pending.push({ from: line.from + i, to: line.from + i + 1, deco: tabDeco });
        }
      }
    }
    // 行尾 ↩（文档最后一行无换行符，跳过）
    if (cfg.showLineBreaks && line.to < doc.length) {
      pending.push({ from: line.to, to: line.to, deco: lineBreakDeco });
    }
    pos = line.to + 1;
  }

  // RangeSetBuilder 要求位置严格递增；按行扫描天然有序，但为稳妥排序
  pending.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of pending) builder.add(d.from, d.to, d.deco);
  return builder.finish();
}

/** 创建空白符号扩展（插件 + 主题）。 */
export function whitespaceExtensions(getCfg: () => WhitespaceConfig) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, getCfg());
      }
      update(u: ViewUpdate) {
        // 无条件重建：视口/文档/折行变化时 CM 都会派发 update，
        // 视口内逐字符扫描成本极低，无需条件判断（避免漏帧）。
        this.decorations = buildDecorations(u.view, getCfg());
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, whitespaceTheme];
}

/**
 * 符号样式（baseTheme 全局注入，scoped 样式够不到 CM 内部 DOM）。
 * 颜色走 styles.css 的主题变量（--ws-*），明暗主题自动切换。
 */
export const whitespaceTheme = EditorView.baseTheme({
  // 空格：底色小圆点（mark 保字符，宽度不变）
  '.cm-ws-space': {
    backgroundImage: 'radial-gradient(circle, var(--ws-dot-color) 1px, transparent 1.2px)',
    backgroundSize: '100% 100%',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  },
  // 制表符：底部短线（宽度 = tab 渲染宽度，天然对齐）
  '.cm-ws-tab': {
    backgroundImage: 'linear-gradient(to right, var(--ws-line-color) 0 60%, transparent 60%)',
    backgroundSize: '100% 1px',
    backgroundPosition: 'left bottom',
    backgroundRepeat: 'no-repeat',
  },
  // 行尾 ↩：零宽 inline 叠加，pointer-events 关闭
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
