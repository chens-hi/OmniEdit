import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
  WidgetType,
  EditorView,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

/** 插件配置（由 compartment 传入）。 */
export interface WhitespaceConfig {
  showSpaces: boolean;
  showTabs: boolean;
  showLineBreaks: boolean;
}

/**
 * 空白符号可见化（Notepad++「显示符号」风格）。
 *
 * 关键实现决策（v0.4.2 修正）：**用 Decoration.mark 给原字符加样式类，
 * 绝不用 Decoration.replace 替换字符**——替换会把 · / → 的字宽强加给原
 * 空格/Tab 位置，破坏等宽字体的列对齐（实测：开启后行尾注释全部错位）。
 * mark 只挂 span 不改文本流，宽度与原字符完全一致，对齐零偏移。
 *
 *   - 空格 → mark 类 cm-ws-space（CSS 背景点/下划线视觉）
 *   - 制表符 → mark 类 cm-ws-tab（CSS 底部箭头线）
 *   - 真实换行 → 行尾 widget ¶（零宽叠加，不影响布局）
 *   - 软折行 → ↩ widget（仅自动换行时有意义）
 */

/** 行尾真实换行符 ¶（widget 叠加在行末，不占文档位置） */
class LineBreakWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ls-mark';
    span.textContent = '¶';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

/** 软折行点 ↩ */
class SoftWrapWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ls-mark cm-ls-soft';
    span.textContent = '↩';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

const lineBreakDeco = Decoration.widget({ widget: new LineBreakWidget(), side: 1 });
const softWrapDeco = Decoration.widget({ widget: new SoftWrapWidget(), side: 1 });

/** 空格/Tab 可见化：mark 装饰（保字符、只加样式类） */
const spaceDeco = Decoration.mark({ class: 'cm-ws-space' });
const tabDeco = Decoration.mark({ class: 'cm-ws-tab' });

/** 构建视口内的装饰集合。 */
function buildDecorations(view: EditorView, cfg: WhitespaceConfig): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (!cfg.showSpaces && !cfg.showTabs && !cfg.showLineBreaks) {
    return builder.finish();
  }

  const doc = view.state.doc;
  const { from, to } = view.viewport;

  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos);
    if (cfg.showSpaces || cfg.showTabs) {
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ' && cfg.showSpaces) {
          builder.add(line.from + i, line.from + i + 1, spaceDeco);
        } else if (ch === '\t' && cfg.showTabs) {
          builder.add(line.from + i, line.from + i + 1, tabDeco);
        }
      }
    }
    // 行尾真实换行 ¶（文档最后一行无换行符，跳过）
    if (cfg.showLineBreaks && line.to < doc.length) {
      builder.add(line.to, line.to, lineBreakDeco);
    }
    pos = line.to + 1;
  }

  // 软折行标记 ↩（每个可视区间起点=上一视觉行折回处；首区间跳过）
  if (cfg.showLineBreaks) {
    for (const { from: bFrom } of view.visibleRanges) {
      if (bFrom > from) {
        builder.add(bFrom, bFrom, softWrapDeco);
      }
    }
  }

  return builder.finish();
}

/** 创建空白符号插件（cfg 由外层闭包每次 reconfigure 提供新值）。 */
export function whitespacePlugin(getCfg: () => WhitespaceConfig) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, getCfg());
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.geometryChanged) {
          this.decorations = buildDecorations(u.view, getCfg());
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}

/**
 * 符号样式（baseTheme 全局注入，scoped 样式够不到 CM 内部 DOM）。
 * mark 方案下空格仍是空格字符——宽度不变；可见性由背景/下划线提供。
 */
export const whitespaceTheme = EditorView.baseTheme({
  // 空格：底色小点感（利用 background 圆点径向渐变，居中，不占额外宽度）
  '.cm-ws-space': {
    backgroundImage: 'radial-gradient(circle, var(--ws-dot-color, rgba(128,128,128,0.6)) 1px, transparent 1.2px)',
    backgroundSize: '100% 100%',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  },
  // 制表符：底部一条短横线（宽度 = tab 渲染宽度，天然对齐）
  '.cm-ws-tab': {
    backgroundImage: 'linear-gradient(to right, var(--ws-dot-color, rgba(128,128,128,0.5)) 0 60%, transparent 60%)',
    backgroundSize: '100% 1px',
    backgroundPosition: 'left bottom',
    backgroundRepeat: 'no-repeat',
  },
  // 行尾 ¶ / 软折行 ↩：绝对定位叠加，不参与文档流宽度
  '.cm-ls-mark': {
    color: 'var(--ws-mark-color, rgba(128,128,128,0.55))',
    pointerEvents: 'none',
    display: 'inline-block',
    width: '0',
    overflow: 'visible',
    whiteSpace: 'nowrap',
  },
  '.cm-ls-soft': {
    color: 'var(--ws-soft-color, rgba(120,150,255,0.6))',
  },
});
