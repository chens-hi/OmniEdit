import { sdk } from './api';
import { t } from './i18n';

/**
 * fnOS 宿主交互（另存为的目录选择）。
 *
 * pickUserFile 拉起宿主目录选择器供「另存为」选择保存位置。
 * 注：权限模型为 root 直读（v0.2.0），选择器不再承载授权语义，纯 UI 用途。
 * 独立浏览器（本地 dev，isStandaloneWeb=true）降级为 prompt 输入，
 * 保证全流程可在本机走通（配合 --dev-root / --dev-allow-all）。
 */

/** 从宿主响应中提取字符串数组（官方 AppBridgeResponse<T>：{code,msg,data}）。 */
function extractPaths(res: unknown): string[] {
  if (!res) return [];
  const r = res as { code?: number; msg?: string; data?: unknown };
  if (typeof r.code === 'number' && r.code !== 0) {
    console.warn('[hostAuth] 宿主返回业务错误:', r.code, r.msg);
    return [];
  }
  const data = r.data ?? res;
  if (Array.isArray(data)) return data.filter((x): x is string => typeof x === 'string');
  return [];
}

/**
 * 拉起宿主目录选择器，返回所选目录；用户取消返回 null。
 * 仅「另存为」选位置的 UI 用途（root 直读模型下无授权语义）。
 * 文件名输入由 SaveAsDialog 组件承担。
 */
export async function pickDirectory(initial?: string): Promise<string | null> {
  if (sdk.isStandaloneWeb) {
    // 独立浏览器（本地 dev）：prompt 降级。
    const d = window.prompt(t('promptDir'), initial ?? '');
    return d || null;
  }
  try {
    const res = await sdk.pickUserFile({
      directory: true, // 目录选择（保存目标必然是目录）
      creatable: true, // 宿主支持时允许在选择器中新建文件夹
      title: t('pickDirTitle'),
      okText: t('pickDirOk'),
      sidebarGroup: ['myFiles', 'otherShare', 'favorites'],
    });
    const paths = extractPaths(res);
    return paths.length ? paths[0] : null;
  } catch {
    return null; // 宿主异常：视为取消。
  }
}
