// Package api 提供 OmniEdit 的 HTTP API（挂载在统一网关前缀下）。
package api

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"omniedit/server/internal/watcher"
	"omniedit/server/internal/ws"
)

// Hub 管理所有 WebSocket 连接，并把 watcher 的文件变更事件**按用户**广播。
//
// 多用户 NAS 上，A 打开/外部改动了哪些文件属于 A 的信息；旧实现广播给
// 所有连接，等于向全员泄漏路径。现在连接建立时绑定网关身份 UID，
// 事件只发给"打开过该文件"的那个用户集合。
type Hub struct {
	mu       sync.Mutex
	conns    map[*ws.Conn]string        // 连接 -> uid（建连时从网关 Header 绑定）
	watches  map[string]map[string]bool // path -> 打开过它的 uid 集合
	watcher  *watcher.Watcher
	observer func(watcher.Event)
}

// NewHub 创建 Hub 并启动底层 watcher 轮询。
func NewHub(w *watcher.Watcher) *Hub {
	h := &Hub{
		conns:   make(map[*ws.Conn]string),
		watches: make(map[string]map[string]bool),
		watcher: w,
	}
	w.Start()
	go h.broadcastLoop()
	return h
}

// addConn 注册连接并绑定其网关身份 uid。
func (h *Hub) addConn(c *ws.Conn, uid string) {
	h.mu.Lock()
	h.conns[c] = uid
	h.mu.Unlock()
}

// removeConn 注销连接。
func (h *Hub) removeConn(c *ws.Conn) {
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
}

// count 返回当前连接数。
func (h *Hub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

// Watch 让 watcher 监控某文件（打开文件时调用），并把 uid 记入该文件的
// 接收者集合。重复调用无害（刷新基线正是保存后的期望行为）。
func (h *Hub) Watch(path, uid string) {
	h.mu.Lock()
	set, ok := h.watches[path]
	if !ok {
		set = make(map[string]bool)
		h.watches[path] = set
	}
	set[uid] = true
	h.mu.Unlock()
	h.watcher.Watch(path)
}

// Unwatch 移除 uid 对该文件的订阅；最后一个订阅者离开时停止监控。
func (h *Hub) Unwatch(path, uid string) {
	h.mu.Lock()
	set, ok := h.watches[path]
	empty := false
	if ok {
		delete(set, uid)
		empty = len(set) == 0
		if empty {
			delete(h.watches, path)
		}
	}
	h.mu.Unlock()
	if empty {
		h.watcher.Unwatch(path)
	}
}

// SetObserver 注册一个事件回调（仅测试用：断言 handler 与 watcher 的协作，
// 例如「保存后必须重设基线」）。生产代码不调用，回调为空即跳过。
func (h *Hub) SetObserver(fn func(watcher.Event)) {
	h.mu.Lock()
	h.observer = fn
	h.mu.Unlock()
}

// WatchingFor 报告某文件是否正被某用户订阅（供测试与诊断）。
func (h *Hub) WatchingFor(path, uid string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	set, ok := h.watches[path]
	return ok && set[uid]
}

// broadcastLoop 从 watcher 事件通道读取变更，按用户广播给客户端。
func (h *Hub) broadcastLoop() {
	for ev := range h.watcher.Events() {
		h.mu.Lock()
		obs := h.observer
		h.mu.Unlock()
		if obs != nil {
			obs(ev)
		}
		data, err := json.Marshal(map[string]any{
			"type":   "file-changed",
			"path":   ev.Path,
			"mtime":  ev.MTime,
			"reason": ev.Reason,
		})
		if err != nil {
			continue
		}
		h.broadcast(ev.Path, data)
	}
}

// broadcast 把事件只发给订阅了该 path 的 uid 对应的连接。
// 发送失败的连接被关闭并注销。
func (h *Hub) broadcast(path string, payload []byte) {
	h.mu.Lock()
	set := h.watches[path]
	var targets []*ws.Conn
	if len(set) > 0 {
		for c, uid := range h.conns {
			if set[uid] {
				targets = append(targets, c)
			}
		}
	}
	h.mu.Unlock()

	for _, c := range targets {
		if err := c.WriteText(payload); err != nil {
			h.removeConn(c)
			_ = c.Close()
		}
	}
}

// WSHandler GET /api/ws —— 升级为 WebSocket，保持连接并消费客户端心跳。
// 连接身份以网关 Header 为准（绑定 uid），绝不信任客户端消息内的身份。
func (h *Handler) WSHandler(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireGatewayUser(r)
	if !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}
	if h.Hub == nil {
		errJSON(w, http.StatusServiceUnavailable, "文件变更推送未启用")
		return
	}
	conn, err := ws.Upgrade(w, r)
	if err != nil {
		if err == ws.ErrNotWebsocket {
			// 非 WebSocket 请求：显式 400（gorilla 升级失败时自行写响应，
			// 但「根本不是升级请求」在包内提前返回，必须在这里补响应）。
			errJSON(w, http.StatusBadRequest, "需要 WebSocket 升级请求")
			return
		}
		// 其它升级失败：gorilla 已写 HTTP 错误响应，只记日志。
		log.Printf("websocket 升级失败: %v", err)
		return
	}
	h.Hub.addConn(conn, user.UID)
	defer func() {
		h.Hub.removeConn(conn)
		_ = conn.Close()
	}()

	// 读取循环：本应用客户端不发业务消息，只处理 ping/pong/close（ReadMessage 内处理）。
	// 阻塞在 ReadMessage 上以维持连接；客户端断开时返回 io.EOF。
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
