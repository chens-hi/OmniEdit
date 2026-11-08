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

// Hub 管理所有 WebSocket 连接，并把 watcher 的文件变更事件广播给客户端。
type Hub struct {
	mu      sync.Mutex
	conns   map[*ws.Conn]struct{}
	watcher *watcher.Watcher
}

// NewHub 创建 Hub 并启动底层 watcher 轮询。
func NewHub(w *watcher.Watcher) *Hub {
	h := &Hub{conns: make(map[*ws.Conn]struct{}), watcher: w}
	w.Start()
	go h.broadcastLoop()
	return h
}

// addConn 注册连接，并对其发送当前已监控文件的快照（可选）。
func (h *Hub) addConn(c *ws.Conn) {
	h.mu.Lock()
	h.conns[c] = struct{}{}
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

// Watch 让 watcher 监控某文件（打开文件时调用），以当前 mtime 为基线。
func (h *Hub) Watch(path string) {
	h.watcher.Watch(path)
}

// Unwatch 取消监控某文件（关闭标签时调用）。
func (h *Hub) Unwatch(path string) {
	h.watcher.Unwatch(path)
}

// broadcastLoop 从 watcher 事件通道读取变更，广播给所有连接。
func (h *Hub) broadcastLoop() {
	for ev := range h.watcher.Events() {
		data, err := json.Marshal(map[string]any{
			"type":  "file-changed",
			"path":  ev.Path,
			"mtime": ev.MTime,
			"reason": ev.Reason,
		})
		if err != nil {
			continue
		}
		h.broadcast(data)
	}
}

// broadcast 向所有连接发送一条文本帧；发送失败的连接被关闭并注销。
func (h *Hub) broadcast(payload []byte) {
	h.mu.Lock()
	conns := make([]*ws.Conn, 0, len(h.conns))
	for c := range h.conns {
		conns = append(conns, c)
	}
	h.mu.Unlock()

	for _, c := range conns {
		if err := c.WriteText(payload); err != nil {
			h.removeConn(c)
			_ = c.Close()
		}
	}
}

// WSHandler GET /api/ws —— 升级为 WebSocket，保持连接并消费客户端心跳。
// 客户端身份校验与其它接口一致（要求经过统一网关 / 开发放行）。
func (h *Handler) WSHandler(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireGatewayUser(r); !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}
	if h.Hub == nil {
		errJSON(w, http.StatusServiceUnavailable, "文件变更推送未启用")
		return
	}
	conn, err := ws.Upgrade(w, r)
	if err != nil {
		if err != ws.ErrNotWebsocket {
			log.Printf("websocket 升级失败: %v", err)
		}
		return
	}
	h.Hub.addConn(conn)
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
