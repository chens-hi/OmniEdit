import { TrimApp } from '@trimjs/web-app';

/**
 * 后端 API 客户端（记事本形态：仅文件读写与授权刷新，无目录/搜索接口）。
 *
 * 应用通过飞牛统一网关挂载在 /app/omniedit 下，前端与后端同域，
 * 因此直接使用相对路径调用即可（网关会转发并附带用户身份 Header）。
 * 开发环境由 Vite proxy 转发到本地 Go 服务。
 */
const BASE = '/app/omniedit';

/** fnOS 官方 JS SDK 实例（授权、目录选择、主题/语言跟随宿主）。 */
export const sdk = new TrimApp();

export interface FileMeta {
  path: string;
  displayPath?: string;
  content: string;
  size: number;
  mtime: string;
  writable: boolean;
  /** 内容编码："utf-8" | "utf-8-bom" | "gb18030"（ANSI）。保存时回传保持。 */
  encoding?: string;
  /** 行尾风格："lf" | "crlf" | "mixed" | ""。 */
  lineEnding?: string;
  /** 文件超过默认打开阈值，content 为空，需确认后以 allowLarge 重取。 */
  tooLarge?: boolean;
  /** content 已被截断，应作只读预览。 */
  truncated?: boolean;
}

/** API 错误：附带 HTTP 状态码，供上层区分 403（未授权，可发起宿主授权）等。 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) {
    throw new ApiError(data?.error ?? `请求失败（HTTP ${resp.status}）`, resp.status);
  }
  return data as T;
}

/** 读取文本文件内容。allowLarge=true 时超大文件返回截断的只读预览。 */
export function readFile(path: string, allowLarge = false): Promise<{ file: FileMeta }> {
  const flag = allowLarge ? '&allowLarge=1' : '';
  return request(`${BASE}/api/file/read?path=${encodeURIComponent(path)}${flag}`);
}

/**
 * 保存文本文件内容（携带 baseMtime 做冲突检测；baseMtime 为空且文件
 * 不存在时后端创建新文件——「另存为」。hasBom/encoding 保持原文件
 * 编码与 BOM 状态：gb18030 文件由后端转回 ANSI 写盘）。
 */
export function writeFile(
  path: string,
  content: string,
  baseMtime?: string,
  hasBom?: boolean,
  encoding?: string,
): Promise<{ mtime: string }> {
  return request(`${BASE}/api/file/write`, {
    method: 'POST',
    body: JSON.stringify({ path, content, baseMtime, hasBom, encoding }),
  });
}

/** 关闭标签时通知后端释放该文件的 mtime 监控（尽力而为）。 */
export function unwatchFile(path: string): Promise<{ ok: boolean }> {
  return request(`${BASE}/api/file/unwatch`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
}

/** 健康检查。 */
export function health(): Promise<{ ok: boolean }> {
  return request(`${BASE}/api/health`);
}

/**
 * 从 URL 查询参数中提取 fnOS 传入的文件路径。
 * 用户通过文件管理器右键「OmniEdit」打开文件时，
 * fnOS 会在入口 URL 后追加 ?path=/vol1/.../example.txt。
 */
export function pathFromLocation(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('path');
}
