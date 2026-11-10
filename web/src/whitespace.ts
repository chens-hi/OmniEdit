import type { EditorView } from '@codemirror/view';

/**
 * 空白符号可见化（Notepad++「显示符号」风格）——**独立覆盖层实现**。
 *
 * 符号画在独立覆盖层（absolute 铺满编辑区、pointer-events:none），不进
 * CM 文本流，折行排版完全不受影响。仅三类符号：空格 ·、制表符 →、行尾 ↩。
 *
 * v0.5.2 决策：砍掉软折行标记（↩ 与 ↵ 双符号区分）。CM6 基于 DOM 排版，
 * 无可靠的视觉行边界 API，coordsAtPos 采样在行尾空格紧贴折点时存在盲区，
 * 迭代 6 版仍无法彻底稳定且引入大量时序兜底代码，性价比过低。
 * 用户需求反向满足：有行尾 ↩ = 文件真实回车；折下来的行没有 ↩ = 自动折行。
 */

export interface WhitespaceConfig {
  showSpaces: boolean;
  showTabs: boolean;
  showLineBreaks: boolean;
}

/** 一个待绘制符号：type 决定字符，x/y 为页面坐标 */
interface WsMark {
  type: 'space' | 'tab' | 'break';
  x: number;
  y: number;
}

/** 检测符号位置（页面坐标，基于 coordsAtPos 采样，视口内逐字符）。 */
function detectMarks(view: EditorView, cfg: WhitespaceConfig): WsMark[] {
  const marks: WsMark[] = [];
  const doc = view.state.doc;
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

    // 行尾真实换行 ↩（文档最后一行无换行符，跳过）
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

    pos = line.to + 1;
  }
  return marks;
}

/** 覆盖层句柄：销毁与手动刷新（配置变化时由 App.vue 调用）。 */
export interface WhitespaceOverlay {
  destroy(): void;
  refresh(): void;
}

/** 创建覆盖层并启动同步。 */
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
      // 页面坐标 → 覆盖层坐标：x/y 都减去编辑器视口偏移。
      // x 钳制：行尾/长单词可能超出可视宽度，钳到右缘内侧 14px 保证可见。
      const editorRect = getView().dom.getBoundingClientRect();
      const maxX = editorRect.width - 14;
      const html = marks
        .map((m) => {
          const ch = m.type === 'space' ? '·' : m.type === 'tab' ? '→' : '↩';
          const cls = m.type === 'break' ? 'ws-mark ws-brk' : 'ws-mark';
          const x = Math.min(m.x - editorRect.left, maxX);
          return `<span class="${cls}" style="left:${x}px;top:${m.y - editorRect.top}px">${ch}</span>`;
        })
        .join('');
      overlay.innerHTML = html;
    } catch (err) {
      console.warn('[whitespace] draw 异常:', err);
      overlay.innerHTML = '';
    }
  }

  function scheduleDetect() {
    window.clearTimeout(detectTimer);
    detectTimer = window.setTimeout(() => {
      rafId = requestAnimationFrame(draw);
    }, 180);
  }

  // 滚动/尺寸变化：节流重画（视觉坐标随滚动变化，重画即对齐）
  const onScroll = () => scheduleDetect();
  getView().scrollDOM.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', scheduleDetect);
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
