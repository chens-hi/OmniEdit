import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
  WidgetType,
  EditorView,
} from '@codemirror/view';
import { RangeSetBuilder, StateField, StateEffect, type Extension } from '@codemirror/state';

/**
 * 空白符号可见化（Notepad++「显示符号」风格）。
 *
 * 实现（v0.4.7 结构化重写）：
 *   - **mark 不 replace**：空格/Tab 保留原字符只加样式类，等宽对齐零偏移；
 *   - **软折行点（↩）用两阶段异步检测**：同步阶段画 ↵/·/→（不依赖折行几何）；
 *     异步阶段（requestAnimationFrame 后，折行测量已就绪）用 coordsAtPos
 *     采样定位折点，经 StateEffect 写入 StateField，装饰层从 field 读取——
 *     field 变化触发 CM 正常 update 循环，装饰可靠重渲染。
 *   - CM6 无公开视觉行 API（viewportLineBlocks 是逻辑行块，三版实测无效），
 *     coordsAtPos y 跳变采样是唯一可靠途径（Playwright 实测折点 60/120/180/240）。
 */

/** 插件配置。 */
export interface WhitespaceConfig {
  showSpaces: boolean;
  showTabs: boolean;
  showLineBreaks: boolean;
}

// ---- 软折行位置 StateField ----

/** 异步检测完成后派发：写入当前软折行位置集合 */
export const setSoftWrapPoints = StateEffect.define<number[]>();

/** 软折行位置集合（视口内，按位置排序） */
const softWrapField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSoftWrapPoints)) return e.value;
    }
    // 文档变化时旧位置失效，清空（下一轮异步重算）
    if (tr.docChanged) return [];
    return value;
  },
});

/** 行尾真实换行符 ↵ */
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
const spaceDeco = Decoration.mark({ class: 'cm-ws-space' });
const tabDeco = Decoration.mark({ class: 'cm-ws-tab' });

/** 同步装饰：↵ + 空格 mark + Tab mark（不依赖折行几何） */
function buildSyncDecorations(view: EditorView, cfg: WhitespaceConfig, softPoints: number[]): DecorationSet {
  const pending: { from: number; to: number; deco: Decoration }[] = [];

  for (let pos = view.viewport.from; pos <= view.viewport.to; ) {
    const line = view.state.doc.lineAt(pos);
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
    if (cfg.showLineBreaks && line.to < view.state.doc.length) {
      pending.push({ from: line.to, to: line.to, deco: lineBreakDeco });
    }
    pos = line.to + 1;
  }

  // 软折行 ↩（来自 StateField 的异步检测结果）
  if (cfg.showLineBreaks) {
    for (const p of softPoints) {
      if (p >= view.viewport.from && p <= view.viewport.to) {
        pending.push({ from: p, to: p, deco: softWrapDeco });
      }
    }
  }

  pending.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of pending) builder.add(d.from, d.to, d.deco);
  return builder.finish();
}

/** 异步软折行检测：coordsAtPos y 跳变采样（折行测量就绪后调用才可靠）。 */
function detectSoftWrapPoints(view: EditorView): number[] {
  const doc = view.state.doc;
  const points: number[] = [];
  const lineHeight = view.defaultLineHeight || 20;
  const sample = (pos: number): number | null => {
    try {
      const c = view.coordsAtPos(pos);
      return c ? c.top : null;
    } catch {
      return null;
    }
  };

  for (let pos = view.viewport.from; pos <= view.viewport.to; ) {
    const line = doc.lineAt(pos);
    const topFirst = sample(line.from);
    const topLast = sample(Math.max(line.from, line.to - 1));
    if (topFirst === null || topLast === null || Math.abs(topLast - topFirst) < lineHeight / 2) {
      pos = line.to + 1;
      continue;
    }
    // 已折行：粗扫 32 字符 + 二分细化
    const step = 32;
    let lastY = topFirst;
    let lastPos = line.from;
    for (let p = line.from + step; p < line.to; p += step) {
      const y = sample(p);
      if (y === null) continue;
      if (Math.abs(y - lastY) > lineHeight / 2) {
        let lo = lastPos + 1;
        let hi = p;
        let breakPos = p;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const my = sample(mid);
          if (my === null || Math.abs(my - lastY) > lineHeight / 2) {
            breakPos = mid;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }
        const markPos = Math.max(line.from + 1, breakPos - 1);
        points.push(markPos);
        lastY = y;
      }
      lastPos = p;
    }
    pos = line.to + 1;
  }
  return points;
}

/** 创建空白符号扩展集（插件 + 软折行 field + 主题）。 */
export function whitespaceExtensions(getCfg: () => WhitespaceConfig): Extension[] {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /** 上次异步检测的调度标记（防重复排队） */
      private scheduled = false;

      constructor(view: EditorView) {
        this.decorations = buildSyncDecorations(view, getCfg(), view.state.field(softWrapField, false) ?? []);
        this.scheduleDetect(view);
      }
      update(u: ViewUpdate) {
        this.decorations = buildSyncDecorations(u.view, getCfg(), u.state.field(softWrapField, false) ?? []);
        this.scheduleDetect(u.view);
      }
      /** 排队异步软折行检测（折行测量就绪后执行；结果经 effect 回写）。 */
      private scheduleDetect(view: EditorView) {
        if (this.scheduled || !getCfg().showLineBreaks) return;
        this.scheduled = true;
        setTimeout(() => {
          this.scheduled = false;
          const points = detectSoftWrapPoints(view);
          const current = view.state.field(softWrapField, false) ?? [];
          // 有变化才 dispatch（避免无限循环）
          if (JSON.stringify(points) !== JSON.stringify(current)) {
            view.dispatch({ effects: setSoftWrapPoints.of(points) });
          }
        }, 80);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
  return [softWrapField, plugin, whitespaceTheme];
}

/**
 * 符号样式（baseTheme 全局注入）。颜色走 styles.css 主题变量（--ws-*），
 * 明暗主题自动切换。
 */
export const whitespaceTheme = EditorView.baseTheme({
  // .cm-line 相对定位：行尾符号的 absolute 锚点
  '.cm-line': {
    position: 'relative',
  },
  '.cm-ws-space': {
    backgroundImage: 'radial-gradient(circle, var(--ws-dot-color) 1px, transparent 1.2px)',
    backgroundSize: '100% 100%',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  },
  '.cm-ws-tab': {
    backgroundImage: 'linear-gradient(to right, var(--ws-line-color) 0 60%, transparent 60%)',
    backgroundSize: '100% 1px',
    backgroundPosition: 'left bottom',
    backgroundRepeat: 'no-repeat',
  },
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
