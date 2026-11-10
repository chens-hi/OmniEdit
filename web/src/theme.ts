import { ref } from 'vue';
import { sdk } from './api';

export type Theme = 'dark' | 'light';

/** 主题模式：auto=跟随宿主系统；light/dark=用户强制指定。 */
export type ThemeMode = 'auto' | 'light' | 'dark';

/** 当前主题（响应式），默认暗色。 */
export const theme = ref<Theme>('dark');

/** 宿主系统主题（os/theme 事件 / 启动读取）。 */
let hostTheme: Theme = 'dark';
/** 用户模式覆盖（默认 auto 跟随宿主），由 store.setThemeMode 驱动。 */
let override: ThemeMode = 'auto';

function resolveTheme(): Theme {
  return override === 'auto' ? hostTheme : override;
}

function applyResolved() {
  applyTheme(resolveTheme());
}

/**
 * 设置主题模式覆盖（auto=跟随宿主）。store 持久化用户选择后调用；
 * auto 模式下宿主切换主题时实时跟随，light/dark 则忽略宿主事件。
 */
export function setThemeOverride(mode: ThemeMode): void {
  override = mode;
  applyResolved();
}

/** 把主题写到 <html data-theme>，驱动 CSS 变量切换。 */
function applyTheme(t: Theme) {
  theme.value = t;
  document.documentElement.setAttribute('data-theme', t);
}

/**
 * 从宿主读取平台配置并应用主题，同时监听宿主主题实时切换。
 * 独立浏览器（isStandaloneWeb）下没有宿主，保持默认暗色。
 * 用户覆盖模式（override !== 'auto'）时以覆盖为准。
 *
 * 事件名来自官方 JS SDK 文档（@trimjs/web-app README · Host Events）：
 * `os/theme` 回调参数即主题字符串。监听失败静默降级为"仅启动读取一次"。
 */
export async function initTheme(): Promise<void> {
  try {
    if (sdk.isStandaloneWeb) {
      // 独立浏览器：无宿主主题，保持默认暗色（override 仍可覆盖）。
      hostTheme = 'dark';
      applyResolved();
      return;
    }
    const config = await sdk.getPlatformConfig();
    hostTheme = config?.theme === 'light' ? 'light' : 'dark';
    applyResolved();
  } catch {
    // 读取失败（如非宿主环境）保持默认暗色，不阻塞编辑器。
    hostTheme = 'dark';
    applyResolved();
    return;
  }
  // 实时跟随：宿主深/浅色切换时热更新（auto 模式下；App.vue 对 theme 的 watch 负责 CodeMirror）。
  try {
    await sdk.$on('os/theme', (payload: unknown) => {
      const value = typeof payload === 'string' ? payload
        : (payload as { theme?: string })?.theme;
      if (value === 'light' || value === 'dark') {
        hostTheme = value;
        applyResolved();
      }
    });
  } catch {
    // 宿主事件总线不可用：维持启动时读取的一次性结果。
  }
}
