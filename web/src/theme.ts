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
 * 从宿主读取平台配置并应用主题/语言。
 * 独立浏览器（isStandaloneWeb）下没有宿主，保持默认暗色。
 *
 * 注意：官方 SDK 的 `getPlatformConfig()` 返回当前 theme，
 * 但"主题实时变化"的事件名在 SDK 中未明确公开（$on 需要具体事件名）。
 * 因此首版只在启动时读取一次；实时跟随待拿到官方事件名后补充。
 */
export async function initTheme(): Promise<void> {
  try {
    if (sdk.isStandaloneWeb) {
      // 独立浏览器：无宿主主题，保持默认。
      applyTheme('dark');
      return;
    }
    const config = await sdk.getPlatformConfig();
    const t: Theme = config?.theme === 'light' ? 'light' : 'dark';
    applyTheme(t);
  } catch {
    // 读取失败（如非宿主环境）保持默认暗色，不阻塞编辑器。
    applyTheme('dark');
  }
}
