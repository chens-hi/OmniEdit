import { TrimApp } from '@trimjs/web-app';

/**
 * 后端 API 客户端。
 *
 * 应用通过飞牛统一网关挂载在 /app/omniedit 下，前端与后端同域，
 * 因此直接使用相对路径调用即可（网关会转发并附带用户身份 Header）。
 * 开发环境由 Vite proxy 转发到本地 Go 服务。
 */
const BASE = '/app/omniedit';

/** fnOS 官方 JS SDK 实例（授权、文件选择、主题/语言跟随宿主）。 */
export const sdk = new TrimApp();

export interface FileMeta {
  path: string;
  displayPath?: string;
  content: string;
  size: number;
  mtime: string;
  writable: boolean;
  /** 文件超过默认打开阈值，content 为空，需确认后以 allowLarge 重取。 */
  tooLarge?: boolean;
  /** content 已被截断，应作只读预览。 */
  truncated?: boolean;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.ok === false) {
    throw new Error(data?.error ?? `请求失败（HTTP ${resp.status}）`);
  }
  return data as T;
}

/** 读取文本文件内容。allowLarge=true 时超大文件返回截断的只读预览。 */
export function readFile(path: string, allowLarge = false): Promise<{ file: FileMeta }> {
  const flag = allowLarge ? '&allowLarge=1' : '';
  return request(`${BASE}/api/file/read?path=${encodeURIComponent(path)}${flag}`);
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

/** 列出授权目录内某目录的直接子项。 */
export function listDir(path: string): Promise<{ path: string; displayPath: string; entries: DirEntry[] }> {
  return request(`${BASE}/api/dir/list?path=${encodeURIComponent(path)}`);
}

/** 获取已授权根目录列表（目录树浏览起点）。 */
export function listRoots(): Promise<{ roots: string[] }> {
  return request(`${BASE}/api/dir/roots`);
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  filesSearched: number;
  truncated: boolean;
}

/** 在授权目录内搜索文件内容。 */
export function search(path: string, q: string): Promise<{ result: SearchResult }> {
  return request(`${BASE}/api/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`);
}

/** 保存文本文件内容（携带 baseMtime 做冲突检测）。 */
export function writeFile(
  path: string,
  content: string,
  baseMtime?: string,
): Promise<{ mtime: string }> {
  return request(`${BASE}/api/file/write`, {
    method: 'POST',
    body: JSON.stringify({ path, content, baseMtime }),
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
