import { useEditorStore } from './store';

/**
 * 文件变更推送客户端。
 *
 * 连接后端 /api/ws，收到 file-changed 事件时按当前标签状态处理：
 *   - 未打开该文件：忽略（后台监控，不影响）；
 *   - 已打开但**不是活动页签**：只打标记（tab.externalChanged=true），
 *     不弹任何确认框、不自动重载——用户不在看它，弹窗会打断当前工作；
 *     等切到该页签时再询问（见 store 的 externalChanged 处理）；
 *   - 已打开且是活动页签：立刻询问「重新加载 / 保持当前」，
 *     无论本地有没有未保存修改都询问（磁盘内容变了，该由用户决定）。
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
  // 忽略自己保存触发的回声：后端推送的 mtime 与本地刚写回的一致，
  // 说明这是本客户端的写入而非真外部修改。
  if (mtime && tab.mtime && mtime === tab.mtime) return;

  // 记下磁盘当前 mtime：用户若选「保持当前」，保存时要用它做 baseMtime
  // 才能覆盖写入（否则一直撞冲突）。
  if (mtime) tab.diskMtime = mtime;
  tab.externalChanged = true;

  if (tab.id !== store.activeId) {
    // 非活动页签：只打标记，不打扰。切到该页时由 App 触发询问。
    return;
  }

  // 活动页签：立刻询问（有无未保存修改都问，磁盘变了交给用户决定）。
  await store.promptExternalChange(tab.id);
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
