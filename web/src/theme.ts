import { ref } from 'vue';
import { sdk } from './api';

export type Theme = 'dark' | 'light';

/** 当前主题（响应式），默认暗色。 */
export const theme = ref<Theme>('dark');

/** 把主题写到 <html data-theme>，驱动 CSS 变量切换。 */
function applyTheme(t: Theme) {
  theme.value = t;
  document.documentElement.setAttribute('data-theme', t);
}

/**
 * 从宿主读取平台配置并应用主题，同时监听宿主主题实时切换。
 * 独立浏览器（isStandaloneWeb）下没有宿主，保持默认暗色。
 *
 * 事件名来自官方 JS SDK 文档（@trimjs/web-app README · Host Events）：
 * `os/theme` 回调参数即主题字符串。监听失败静默降级为"仅启动读取一次"。
 */
export async function initTheme(): Promise<void> {
  try {
    if (sdk.isStandaloneWeb) {
      // 独立浏览器：无宿主主题，保持默认。
      applyTheme('dark');
      return;
    }
    const config = await sdk.getPlatformConfig();
    applyTheme(config?.theme === 'light' ? 'light' : 'dark');
  } catch {
    // 读取失败（如非宿主环境）保持默认暗色，不阻塞编辑器。
    applyTheme('dark');
    return;
  }
  // 实时跟随：宿主深/浅色切换时热更新（App.vue 对 theme 的 watch 负责 CodeMirror）。
  try {
    await sdk.$on('os/theme', (payload: unknown) => {
      const value = typeof payload === 'string' ? payload
        : (payload as { theme?: string })?.theme;
      if (value === 'light' || value === 'dark') applyTheme(value);
    });
  } catch {
    // 宿主事件总线不可用：维持启动时读取的一次性结果。
  }
}
