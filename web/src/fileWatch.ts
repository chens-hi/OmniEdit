import { useEditorStore } from './store';
import { t } from './i18n';

/**
 * 文件变更推送客户端。
 *
 * 连接后端 /api/ws，收到 file-changed 事件时按当前标签状态处理：
 *   - 未打开该文件：忽略（后台监控，不影响）；
 *   - 已打开且无未保存修改：自动从磁盘重新加载；
 *   - 已打开但有未保存修改：弹确认，让用户选择重载或保留自己的修改。
 *
 * 断线后自动重连（指数退避上限 10s），避免 NAS 短暂重启后推送失效。
 */

let socket: WebSocket | null = null;
let retry = 0;
let closedByUser = false;

const MAX_RETRY_DELAY = 10_000;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 与统一网关前缀保持一致；本地调试走 Vite 代理的 ws。
  return `${proto}//${window.location.host}/app/omniedit/api/ws`;
}

async function handleChange(path: string, mtime: string) {
  const store = useEditorStore();
  const tab = store.tabs.find(tb => tb.path === path);
  if (!tab) return; // 未打开：忽略

  if (!tab.dirty) {
    // 无未保存修改：静默重新加载。
    const ok = await store.reloadFile(path);
    if (ok && path === store.activePath) {
      store.status = `${t('reloaded')}: ${tab.name}`;
    }
    return;
  }

  // 有未保存修改：让用户决定。
  const reload = window.confirm(`${tab.name} ${t('externalChangePrompt')}`);
  if (reload) {
    await store.reloadFile(path);
  }
  // 选择保留则不做任何事，保留用户内存中的修改。
  void mtime;
}

function connect() {
  if (closedByUser) return;
  try {
    socket = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    retry = 0; // 连接成功，重置退避。
  };

  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string);
      if (msg?.type === 'file-changed' && typeof msg.path === 'string') {
        void handleChange(msg.path, msg.mtime);
      }
    } catch {
      // 忽略无法解析的消息。
    }
  };

  socket.onclose = () => {
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose 会紧随触发重连，这里无需额外处理。
  };
}

function scheduleReconnect() {
  if (closedByUser) return;
  const delay = Math.min(1000 * 2 ** retry, MAX_RETRY_DELAY);
  retry += 1;
  setTimeout(connect, delay);
}

/** 启动文件变更监听（在 App 挂载时调用一次）。 */
export function startFileWatch(): void {
  closedByUser = false;
  connect();
}

/** 停止文件变更监听（App 卸载时调用，可选）。 */
export function stopFileWatch(): void {
  closedByUser = true;
  socket?.close();
  socket = null;
}
