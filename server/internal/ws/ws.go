// Package ws 是一个仅依赖标准库的最小 WebSocket 服务端实现。
//
// 支持本应用所需的能力：握手升级、服务端发送文本帧、接收并丢弃客户端帧
// （处理掩码、ping/pong、close）。不追求完整 RFC 6455 覆盖，只满足
// 「后端向编辑器推送文件变更事件」这一场景，避免引入第三方依赖、保持可交叉编译。
package ws

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

// websocket GUID（RFC 6455 固定值，用于计算 Sec-WebSocket-Accept）。
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

var errNotWebsocket = errors.New("not a websocket upgrade request")

// ErrNotWebsocket 表示请求不是合法的 WebSocket 升级请求（调用方可据此忽略）。
var ErrNotWebsocket = errNotWebsocket

// Upgrade 完成 HTTP -> WebSocket 升级握手。
// 成功后返回可读写的 Conn；失败返回 errNotWebsocket 或其它错误。
func Upgrade(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		return nil, errNotWebsocket
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("response writer does not support hijacking")
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		return nil, err
	}

	accept := computeAccept(key)
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := conn.Write([]byte(resp)); err != nil {
		conn.Close()
		return nil, err
	}
	_ = buf.Flush()

	return &Conn{conn: conn, br: bufio.NewReader(conn), wmu: sync.Mutex{}}, nil
}

// computeAccept 计算 Sec-WebSocket-Accept = base64(sha1(key + GUID))。
func computeAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

// opcode 帧类型。
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// Conn 是升级后的 WebSocket 连接。
type Conn struct {
	conn net.Conn
	br   *bufio.Reader
	wmu  sync.Mutex
}

// WriteText 发送一个文本帧（服务端帧不掩码）。
func (c *Conn) WriteText(payload []byte) error {
	return c.writeFrame(opText, payload)
}

// writeFrame 写出一个完整帧。
func (c *Conn) writeFrame(op byte, payload []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	var header [10]byte
	n := 0
	header[0] = 0x80 | op // FIN=1 + opcode
	length := len(payload)
	switch {
	case length < 126:
		header[1] = byte(length)
		n = 2
	case length <= 0xFFFF:
		header[1] = 126
		binary.BigEndian.PutUint16(header[2:4], uint16(length))
		n = 4
	default:
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:10], uint64(length))
		n = 10
	}
	if _, err := c.conn.Write(header[:n]); err != nil {
		return err
	}
	if length > 0 {
		if _, err := c.conn.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// ReadMessage 阻塞读取下一条客户端消息（自动处理 ping/pong/close/分片）。
// 返回 opcode 与 payload；连接关闭时返回 io.EOF。
func (c *Conn) ReadMessage() (byte, []byte, error) {
	for {
		fin, op, payload, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case opPing:
			_ = c.writeFrame(opPong, payload)
			continue
		case opPong:
			continue
		case opClose:
			_ = c.writeFrame(opClose, nil)
			return opClose, nil, io.EOF
		case opText, opBinary, opContinuation:
			if !fin {
				// 简化处理：忽略跨帧分片（本应用消息都很小，单帧足够）。
				continue
			}
			return op, payload, nil
		default:
			continue
		}
	}
}

// readFrame 读取一个帧（自动去除客户端掩码）。
func (c *Conn) readFrame() (fin bool, op byte, payload []byte, err error) {
	var h [2]byte
	if _, err := io.ReadFull(c.br, h[:]); err != nil {
		return false, 0, nil, err
	}
	fin = h[0]&0x80 != 0
	op = h[0] & 0x0F
	masked := h[1]&0x80 != 0
	length := uint64(h[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(c.br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}
	payload = make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		return false, 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return fin, op, payload, nil
}

// Close 关闭底层连接。
func (c *Conn) Close() error {
	return c.conn.Close()
}
