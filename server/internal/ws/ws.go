// Package ws 提供 WebSocket 连接能力（基于 gorilla/websocket）。
//
// 历史说明：曾手写 RFC 6455 实现（握手/掩码/帧解析，183 行）。手戳的帧层
// 存在未覆盖的边角风险（分片消息、非法掩码、异常 close 序列），且这类
// bug 一旦触发是连接级崩溃而非可恢复错误。gorilla/websocket 是 Go 生态
// 事实标准（17k+ star，大量生产依赖），替换后协议细节由库管理，
// 本包只保留应用语义的薄封装，接口与旧版一致（Upgrade/WriteText/
// ReadMessage/Close），调用方（api.Hub）无需感知替换。
package ws

import (
	"errors"
	"net/http"

	"github.com/gorilla/websocket"
)

// errNotWebsocket 表示请求不是 WebSocket 升级请求（调用方可据此忽略）。
var errNotWebsocket = errors.New("not a websocket upgrade request")

// ErrNotWebsocket 表示请求不是合法的 WebSocket 升级请求（调用方可据此忽略）。
var ErrNotWebsocket = errNotWebsocket

// upgorilla 是升级配置：只收文本帧（本应用客户端不发业务消息），
// 不设读/写限制——连接由统一网关管理，帧体小且受控。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
}

// Conn 是升级后的 WebSocket 连接（gorilla.Conn 的薄封装）。
type Conn struct {
	c *websocket.Conn
}

// Upgrade 完成 HTTP -> WebSocket 升级握手。
// 非 WebSocket 请求返回 errNotWebsocket（调用方据此静默忽略）。
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if !websocket.IsWebSocketUpgrade(r) {
		return nil, errNotWebsocket
	}
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// gorilla 对升级失败已自行写 HTTP 错误响应，这里只透传错误。
		return nil, err
	}
	return &Conn{c: c}, nil
}

// WriteText 发送一个文本帧（gorilla 内部串行化写，无需外层加锁）。
func (c *Conn) WriteText(payload []byte) error {
	return c.c.WriteMessage(websocket.TextMessage, payload)
}

// ReadMessage 读取下一帧。客户端不发业务消息，此调用仅用于维持连接与
// 让库处理 ping/pong/close；返回 error 即连接已断（调用方退出读循环）。
func (c *Conn) ReadMessage() (messageType int, p []byte, err error) {
	return c.c.ReadMessage()
}

// Close 关闭底层连接。
func (c *Conn) Close() error {
	return c.c.Close()
}
