import { TrimApp } from '@trimjs/web-app';

/**
 * 后端 API 客户端（记事本形态：仅文件读写与授权刷新，无目录/搜索接口）。
 *
 * 应用通过飞牛统一网关挂载在 /app/omniedit 下，前端与后端同域，
 * 因此直接使用相对路径调用即可（网关会转发并附带用户身份 Header）。
 * 开发环境由 Vite proxy 转发到本地 Go 服务。
 */
const BASE = '/app/omniedit';
/** 应用网关前缀（预览资源重写等处复用）。 */
export const APP_BASE = BASE;

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
}

/** API 错误：附带 HTTP 状态码，供上层区分 403（未授权，可发起宿主授权）等。 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** 请求超时（ms）：后端卡住时避免 UI 永远等待。 */
const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      ...init,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.ok === false) {
      throw new ApiError(data?.error ?? `请求失败（HTTP ${resp.status}）`, resp.status);
    }
    return data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // AbortError → 转成可读消息，不让上层拿到原始 DOMException
    throw new ApiError('请求超时，请检查网络连接', 0);
  } finally {
    clearTimeout(timer);
  }
}

/** 读取文本文件内容。超过打开上限（10MB）后端直接返回 413 错误。 */
export function readFile(path: string): Promise<{ file: FileMeta }> {
  return request(`${BASE}/api/file/read?path=${encodeURIComponent(path)}`);
}

/**
 * 轻量文件信息（不读内容）：只返回大小与 mtime。
 * 用于打开前的前置校验（编辑上限可调后，先知道大小再决定是否拉全文）。
 */
export function statFile(path: string): Promise<{ size: number; mtime: string }> {
  return request(`${BASE}/api/file/stat?path=${encodeURIComponent(path)}`);
}

/** raw 读取通道的元数据（从 X-File-Meta 响应头 base64 还原）。 */
interface RawMeta {
  size: number;
  mtime: string;
  encoding: string;
  lineEnding: string;
  hasBom: boolean;
  writable: boolean;
}

/**
 * raw 打开通道：GET /api/file/read-raw 返回纯文本正文，
 * 元数据在 X-File-Meta 响应头（base64 JSON）。
 *
 * 与 readFile 的区别：跳过 Go json.Marshal 的字符串转义与前端
 * resp.json() 解析，10MB 文件少两次 O(n) 编解码（打开路径约省 200ms）。
 * 内容判定完全一致（同一个 files.Read）：二进制/UTF-16/超大文件同样拒绝。
 *
 * 完整性校验：比对响应头 X-Content-Length 与实际读取字符数，
 * 不一致说明传输被截断，抛错而不建页签（防静默数据损坏）。
 */
export async function readFileRaw(path: string): Promise<{ file: FileMeta }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${BASE}/api/file/read-raw?path=${encodeURIComponent(path)}`, {
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError('请求超时，请检查网络连接', 0);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new ApiError(err?.error ?? `请求失败（HTTP ${resp.status}）`, resp.status);
  }

  const text = await resp.text();

  // 完整性校验：后端在 X-Content-Length 写入字符数（UTF-16 code unit 数）。
  // Go 侧 w.Write([]byte(content)) 的字节数是 UTF-8 字节数，与 JS string 的
  // length（UTF-16 code unit）不同——中文字符 3 字节 vs 1 code unit。
  // 因此这里让后端直接回传 UTF-8 字节数，前端用 TextEncoder 编码后比对。
  const declared = resp.headers.get('X-Content-Bytes');
  if (declared !== null) {
    const actual = new TextEncoder().encode(text).length;
    if (Number(declared) !== actual) {
      throw new ApiError(`传输不完整（期望 ${declared} 字节，实际 ${actual} 字节）`, 0);
    }
  }

  // 还原元数据
  const metaB64 = resp.headers.get('X-File-Meta') ?? '';
  let meta: RawMeta = { size: 0, mtime: '', encoding: 'utf-8', lineEnding: '', hasBom: false, writable: true };
  if (metaB64) {
    try {
      const bin = atob(metaB64);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      meta = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // 元数据解析失败不致命：按默认值继续（正文已完整）。
    }
  }

  return {
    file: {
      path,
      content: text,
      size: meta.size,
      mtime: meta.mtime,
      writable: meta.writable,
      encoding: meta.encoding,
      lineEnding: meta.lineEnding,
    },
  };
}

/**
 * raw 保存通道：POST /api/file/write-raw，请求体即文件内容原文。
 * mtime 冲突检测 / BOM 保持 / GB18030 转回 / 原子写全部与 writeFile 一致
 * （同一个 files.WriteRaw）。新 mtime 从 X-New-Mtime 响应头取。
 *
 * 与 writeFile 的区别：跳过前端 JSON.stringify + 后端 json.Decode 的
 * 字符串转义/还原，10MB 文件保存路径少两次 O(n) 编解码（约省 200ms）。
 */
export async function writeFileRaw(
  path: string,
  content: string,
  baseMtime?: string,
  hasBom?: boolean,
  encoding?: string,
): Promise<{ mtime: string }> {
  const q = new URLSearchParams({ path });
  if (baseMtime) q.set('mtime', baseMtime);
  if (hasBom) q.set('bom', '1');
  if (encoding && encoding !== 'utf-8' && encoding !== 'utf-8-bom') q.set('enc', encoding);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${BASE}/api/file/write-raw?${q.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError('请求超时，请检查网络连接', 0);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new ApiError(err?.error ?? `请求失败（HTTP ${resp.status}）`, resp.status);
  }
  const mtime = resp.headers.get('X-New-Mtime');
  if (!mtime) throw new ApiError('保存响应缺少 mtime', 0);
  return { mtime };
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

/**
 * 读取当前用户偏好（菜单设置 / 上次保存目录 / 会话标签）。
 * 返回原始 JSON 对象；缺失时后端返回 {}（前端据默认值初始化）。
 * 失败抛 ApiError，由调用方降级到 localStorage/默认值。
 */
export async function getPrefs(): Promise<Record<string, unknown>> {
  const data = await request<Record<string, unknown>>(`${BASE}/api/prefs`);
  return data ?? {};
}

/**
 * 保存当前用户偏好（整体覆盖写回）。body 即偏好 JSON 对象。
 * fire-and-forget 调用即可；失败由调用方决定是否提示。
 */
export function putPrefs(prefs: Record<string, unknown>): Promise<{ ok: boolean }> {
  return request(`${BASE}/api/prefs`, {
    method: 'PUT',
    body: JSON.stringify(prefs),
  });
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
