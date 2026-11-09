import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

/**
 * 空白符号可见化（Notepad++「显示符号」风格）。
 *
 * 三类独立开关（经 data 属性由 CSS/插件读取）：
 *   - 空格 → 行内浅色 `·`
 *   - 制表符 → `→`
 *   - 换行符 → 行尾 `¶`（文件真实回车）
 *   - 软折行点 → `↩`（仅自动换行开启时产生，区分屏幕折行与真实回车）
 *
 * 实现：视口内逐行扫描（大文件只算可见部分）+ Decoration mark/widget。
 * 开关经 ConfigReceiver（自定义 Compartment 数据）传入，热切换即时生效。
 */

/** 插件配置（由 compartment 传入）。 */
export interface WhitespaceConfig {
  showSpaces: boolean;
  showTabs: boolean;
  showLineBreaks: boolean;
}

/** 行尾真实换行符 ¶ */
class LineBreakWidget extends WidgetType {
  constructor() {
    super();
  }
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

/** 软折行点 ↩（自动换行产生的屏幕折行） */
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

/** 空格/Tab 行内替换：保留原字符占位（不可见色），上方叠可见符号 */
class SpaceMarkWidget extends WidgetType {
  constructor(private readonly ch: string) {
    super();
  }
  eq(other: SpaceMarkWidget) {
    return other.ch === this.ch;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ls-mark cm-ls-ws';
    span.textContent = this.ch === '\t' ? '→' : '·';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

/** 构建视口内的装饰集合。 */
function buildDecorations(view: EditorView, cfg: WhitespaceConfig): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (!cfg.showSpaces && !cfg.showTabs && !cfg.showLineBreaks) {
    return builder.finish();
  }

  const doc = view.state.doc;
  // 视口范围（前后各扩一行，滚动时无空窗）
  const { from, to } = view.viewport;

  let lastLineEnd = -1;
  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos);
    // 行内空格/Tab
    if (cfg.showSpaces || cfg.showTabs) {
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ' && cfg.showSpaces) {
          builder.add(line.from + i, line.from + i + 1, Decoration.replace({ widget: new SpaceMarkWidget(' ') }));
        } else if (ch === '\t' && cfg.showTabs) {
          builder.add(line.from + i, line.from + i + 1, Decoration.replace({ widget: new SpaceMarkWidget('\t') }));
        }
      }
    }
    // 行尾真实换行 ¶（文档最后一行无换行符，跳过）
    if (cfg.showLineBreaks && line.to < doc.length) {
      builder.add(line.to, line.to, lineBreakDeco);
    }
    lastLineEnd = line.to;
    pos = line.to + 1;
  }

  // 软折行标记：遍历可见块的行块（每视觉行一个 block；一个逻辑行被折成多块）
  if (cfg.showLineBreaks) {
    for (const { from: bFrom, to: bTo } of view.visibleRanges) {
      // visibleRanges 给的是可见文本区间；折行块边界用 line 的语义：
      // CodeMirror 在 lineWrapping 开启时每个逻辑行可占多个视觉行，
      // 视口行块信息在 view.viewportLineBlocks。这里退而求其次：
      // 在每个可视区间起点画 ↩（该点即上一个视觉行的折回处），首区间跳过。
      void bTo;
      if (bFrom > from && bFrom !== lastLineEnd) {
        builder.add(bFrom, bFrom, softWrapDeco);
      }
    }
  }

  return builder.finish();
}

/** 创建空白符号插件（返回 ViewPlugin 扩展；cfg 由外层闭包每次 reconfigure 提供新值）。 */
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

/** 样式注入（浅色符号，跟随主题变量；由 styles.css 承担，这里仅类名约定）。 */
export const whitespaceTheme = EditorView.baseTheme({
  '.cm-ls-mark': {
    color: 'rgba(128, 128, 128, 0.55)',
    fontWeight: 'normal',
    pointerEvents: 'none',
  },
  '.cm-ls-soft': {
    color: 'rgba(128, 160, 255, 0.55)',
  },
  '.cm-ls-ws': {
    letterSpacing: '0',
  },
});
