import type { EditorView } from '@codemirror/view';

/**
 * 空白符号可见化（Notepad++「显示符号」风格）——**独立覆盖层实现**。
 *
 * 关键决策（v0.4.8）：符号**不进文本流**。此前用 Decoration（widget/mark）
 * 挂在文本内部，即使 CSS 零宽/absolute，元素插入文本流后浏览器折行排版仍
 * 被带偏（实测：折行右侧空白塌陷、词被挤下行）。Notepad++/VS Code 的符号
 * 是渲染层叠加——我们也这样做：
 *
 *   - 符号画在**独立覆盖层 div**（absolute 铺满编辑区，pointer-events:none，
 *     与 cm-editor 同级而非其内部），浏览器折行排版完全不受影响；
 *   - 坐标来自 view.coordsAtPos（实测可靠的采样法），换算到编辑器坐标系；
 *   - rAF 同步滚动偏移；滚动停止 180ms 后重新检测（节流）。
 */

export interface WhitespaceConfig {
  showSpaces: boolean;
  showTabs: boolean;
  showLineBreaks: boolean;
}

/** 一个待绘制符号：type 决定字符，x/y 为编辑器坐标系像素位置 */
interface WsMark {
  type: 'space' | 'tab' | 'break' | 'soft';
  x: number;
  y: number;
}

/** 检测符号位置（页面坐标，基于 coordsAtPos 采样）。 */
function detectMarks(view: EditorView, cfg: WhitespaceConfig): WsMark[] {
  const marks: WsMark[] = [];
  const doc = view.state.doc;
  const lineHeight = view.defaultLineHeight || 20;
  const sample = (pos: number): { top: number; left: number } | null => {
    try {
      const c = view.coordsAtPos(pos);
      return c ? { top: c.top, left: c.left } : null;
    } catch {
      return null;
    }
  };

  for (let pos = view.viewport.from; pos <= view.viewport.to; ) {
    const line = doc.lineAt(pos);

    // 行尾真实换行 ↵（文档最后一行无换行符，跳过）
    if (cfg.showLineBreaks && line.to < doc.length) {
      const c = sample(line.to);
      if (c) marks.push({ type: 'break', x: c.left, y: c.top });
    }

    // 空格 · 与制表符 →
    if (cfg.showSpaces || cfg.showTabs) {
      const text = line.text;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ' && cfg.showSpaces) {
          const c = sample(line.from + i);
          if (c) marks.push({ type: 'space', x: c.left, y: c.top });
        } else if (ch === '\t' && cfg.showTabs) {
          const c = sample(line.from + i);
          if (c) marks.push({ type: 'tab', x: c.left, y: c.top });
        }
      }
    }

    // 软折行 ↩：coordsAtPos y 跳变采样（先 32 字符粗扫 + 二分细化）。
    // 折行点的 x 即「该视觉行最后一个字符」的右边界——直接用采样坐标。
    if (cfg.showLineBreaks) {
      const topFirst = sample(line.from);
      const topLast = sample(Math.max(line.from, line.to - 1));
      if (
        topFirst !== null &&
        topLast !== null &&
        Math.abs(topLast.top - topFirst.top) >= lineHeight / 2
      ) {
        const step = 32;
        let lastY = topFirst.top;
        let lastPos = line.from;
        for (let p = line.from + step; p < line.to; p += step) {
          const c = sample(p);
          if (!c) continue;
          if (Math.abs(c.top - lastY) >= lineHeight / 2) {
            // 二分细化：找第一个跳到新视觉行的字符，↩ 画在其前一字符的行尾
            let lo = lastPos + 1;
            let hi = p;
            let breakPos = p;
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              const mc = sample(mid);
              if (mc === null || Math.abs(mc.top - lastY) >= lineHeight / 2) {
                breakPos = mid;
                hi = mid - 1;
              } else {
                lo = mid + 1;
              }
            }
            const prevC = sample(Math.max(line.from, breakPos - 1));
            if (prevC) marks.push({ type: 'soft', x: prevC.left, y: prevC.top });
            lastY = c.top;
          }
          lastPos = p;
        }
      }
    }

    pos = line.to + 1;
  }
  return marks;
}

/** 覆盖层句柄：销毁与手动刷新（配置变化时由 App.vue 调用）。 */
export interface WhitespaceOverlay {
  destroy(): void;
  refresh(): void;
}

/** 创建覆盖层并启动同步。返回销毁函数与刷新函数。 */
export function createWhitespaceOverlay(
  host: HTMLElement,
  getView: () => EditorView,
  getCfg: () => WhitespaceConfig,
): WhitespaceOverlay {
  const overlay = document.createElement('div');
  overlay.className = 'ws-overlay';
  host.style.position = 'relative';
  host.appendChild(overlay);

  let rafId = 0;
  let detectTimer: number | undefined;
  let destroyed = false;

  function draw() {
    if (destroyed) return;
    const cfg = getCfg();
    try {
      const marks = cfg.showSpaces || cfg.showTabs || cfg.showLineBreaks
        ? detectMarks(getView(), cfg)
        : [];
      // 页面坐标 → 编辑器坐标系（覆盖层与 cm-editor 同原点，直接减去编辑器偏移）
      const editorRect = getView().dom.getBoundingClientRect();
      const html = marks
        .map((m) => {
          const ch = m.type === 'space' ? '·' : m.type === 'tab' ? '→' : m.type === 'break' ? '↵' : '↩';
          const cls =
            m.type === 'soft'
              ? 'ws-mark ws-soft'
              : m.type === 'break'
                ? 'ws-mark ws-brk'
                : 'ws-mark';
          return `<span class="${cls}" style="left:${m.x - editorRect.left}px;top:${m.y}px">${ch}</span>`;
        })
        .join('');
      overlay.innerHTML = html;
      // 跟随滚动：覆盖层固定，内容滚动时整体平移
      syncScroll();
    } catch (err) {
      console.warn('[whitespace] draw 异常:', err);
      overlay.innerHTML = '';
    }
  }

  function syncScroll() {
    if (destroyed) return;
    const { scrollLeft, scrollTop } = getView().scrollDOM;
    overlay.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
  }

  function scheduleDetect() {
    window.clearTimeout(detectTimer);
    detectTimer = window.setTimeout(() => {
      rafId = requestAnimationFrame(draw);
    }, 180);
  }

  // 滚动跟随：rAF 同步平移（不重检测），滚动停止后节流重画
  const onScroll = () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(syncScroll);
    scheduleDetect();
  };
  getView().scrollDOM.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', scheduleDetect);

  // 初始绘制
  rafId = requestAnimationFrame(draw);

  return {
    destroy() {
      destroyed = true;
      cancelAnimationFrame(rafId);
      window.clearTimeout(detectTimer);
      getView().scrollDOM.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', scheduleDetect);
      overlay.remove();
    },
    refresh() {
      rafId = requestAnimationFrame(draw);
    },
  };
}
