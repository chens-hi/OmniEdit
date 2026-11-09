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
 * 关键实现决策：
 *   - **mark 不 replace**：空格/Tab 保留原字符只加样式类，等宽对齐零偏移；
 *   - **装饰必须按位置递增喂 RangeSetBuilder**：v0.4.2 曾把软折行标记在主
 *     循环后追加，位置乱序导致 RangeSetBuilder 抛错、装饰整批丢失（表现：
 *     自动换行符不显示）。现改为先收集数组、按 from 排序、再统一构建；
 *   - **软折行检测用 view.viewportLineBlocks**：visibleRanges 是可视文本
 *     区间不是折行块；viewportLineBlocks 给视口内每个视觉行块，同一逻辑行
 *     的后续块（doc.lineAt(block.from).from !== block.from）即软折行点。
 */

/** 插件配置（由 compartment 传入）。 */
export interface WhitespaceConfig {
  showSpaces: boolean;
  showTabs: boolean;
  showLineBreaks: boolean;
}

/** 行尾真实换行符 ↵（回车键符号，直角；widget 零宽叠加不占布局） */
class LineBreakWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ls-mark';
    span.textContent = '↵';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

/** 软折行点 ↩（自动换行产生的屏幕折行，弯钩形） */
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

/** 空格/Tab 可见化：mark 装饰（保字符、只加样式类，宽度不变） */
const spaceDeco = Decoration.mark({ class: 'cm-ws-space' });
const tabDeco = Decoration.mark({ class: 'cm-ws-tab' });

interface PendingDeco {
  from: number;
  to: number;
  deco: Decoration;
}

/** 构建视口内的装饰集合（收集 → 排序 → 构建两级，保证位置递增）。 */
function buildDecorations(view: EditorView, cfg: WhitespaceConfig): DecorationSet {
  if (!cfg.showSpaces && !cfg.showTabs && !cfg.showLineBreaks) {
    return Decoration.none;
  }

  const doc = view.state.doc;
  const { from, to } = view.viewport;
  const pending: PendingDeco[] = [];

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
    // 行尾真实换行 ↵（文档最后一行无换行符，跳过）
    if (cfg.showLineBreaks && line.to < doc.length) {
      pending.push({ from: line.to, to: line.to, deco: lineBreakDeco });
    }
    pos = line.to + 1;
  }

  // 软折行标记 ↩：viewportLineBlocks 中同一逻辑行的第 2+ 视觉块，
  // 画在**上一视觉块的末尾**（blocks[i-1].to）——画在续块行首会被 CM 的
  // 行首零宽 widget 处理吞进前一行且溢出方向错误，视觉上"消失"（真机实测）。
  // 与 ¶（line.to 处）位置天然互斥：软折行块末尾不是逻辑行末尾。
  if (cfg.showLineBreaks) {
    const blocks = view.viewportLineBlocks;
    for (let i = 1; i < blocks.length; i++) {
      const prev = blocks[i - 1];
      const block = blocks[i];
      // 该视觉块的起点不是其逻辑行的行首 → 它是上一视觉块的折行续块
      if (doc.lineAt(block.from).from !== block.from) {
        pending.push({ from: prev.to, to: prev.to, deco: softWrapDeco });
      }
    }
  }

  // 严格按位置排序（RangeSetBuilder 要求递增；同位置时 widget 顺序稳定）
  pending.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const d of pending) {
    builder.add(d.from, d.to, d.deco);
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
        // 无条件重建：软折行块信息（viewportLineBlocks）可能在
        // docChanged/viewportChanged/geometryChanged 均未置位的帧里更新
        // （折行重排晚一拍），条件判断会漏掉时序差（真机实测"↩ 不显示"）。
        // 视口内扫描成本低，每次 update 重建无感知。
        this.decorations = buildDecorations(u.view, getCfg());
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}

/**
 * 符号样式（baseTheme 全局注入，scoped 样式够不到 CM 内部 DOM）。
 * 颜色全部走 styles.css 的主题变量（--ws-*），明暗主题自动切换。
 *
 * 关键（v0.4.6）：行尾 ¶/↩ widget 改为 **position:absolute 脱离文档流**。
 * 此前的 width:0 + overflow:visible 方案中，溢出内容参与 CM 行宽测量——
 * 折行测量把溢出符号当行内容，折点计算偏移（自动换行右侧大段空白）且
 * 横向滚动条反复出现。absolute 元素不贡献 scrollWidth，测量恢复精确。
 */
export const whitespaceTheme = EditorView.baseTheme({
  // 折行/符号定位锚点：.cm-line 相对定位（absolute 符号的包含块）
  '.cm-line': {
    position: 'relative',
  },
  // 空格：底色小点感（利用 background 圆点径向渐变，居中，不占额外宽度）
  '.cm-ws-space': {
    backgroundImage: 'radial-gradient(circle, var(--ws-dot-color) 1px, transparent 1.2px)',
    backgroundSize: '100% 100%',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  },
  // 制表符：底部一条短横线（宽度 = tab 渲染宽度，天然对齐）
  '.cm-ws-tab': {
    backgroundImage: 'linear-gradient(to right, var(--ws-line-color) 0 60%, transparent 60%)',
    backgroundSize: '100% 1px',
    backgroundPosition: 'left bottom',
    backgroundRepeat: 'no-repeat',
  },
  // 行尾 ↵ / 软折行 ↩：absolute 定位在行尾右侧 2px，脱离测量流
  '.cm-ls-mark': {
    color: 'var(--ws-mark-color)',
    pointerEvents: 'none',
    position: 'absolute',
    whiteSpace: 'pre',
    fontSize: '0.9em',
    transform: 'translateX(2px)',
  },
  '.cm-ls-soft': {
    color: 'var(--ws-soft-color)',
  },
});
