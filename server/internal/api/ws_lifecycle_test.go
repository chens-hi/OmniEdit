package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"omniedit/server/internal/watcher"
)

// newWSTestServer 起一个挂载了 WSHandler 的 DevAllowAll 测试服务。
func newWSTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	h := &Handler{
		DevAllowAll: true,
		Prefix:      "/app/omniedit",
		Hub:         NewHub(watcher.New(2 * time.Second)),
	}
	m := http.NewServeMux()
	m.HandleFunc("/app/omniedit/api/ws", h.WSHandler)
	srv := httptest.NewServer(m)
	t.Cleanup(srv.Close)
	return srv
}

// TestWS_UpgradeAndPush 验证 gorilla 替换后的核心语义：
// 升级成功、连接可维持、客户端主动关闭被正常处理。
func TestWS_UpgradeAndClose(t *testing.T) {
	srv := newWSTestServer(t)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/app/omniedit/api/ws"

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("升级失败: %v (resp=%v)", err, resp)
	}

	// 发一帧（服务端读循环会读走并丢弃）
	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatalf("发送失败: %v", err)
	}

	// 客户端主动正常关闭
	if err := conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, "bye")); err != nil {
		t.Fatalf("关闭帧发送失败: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	conn.Close()
}

// TestWS_RejectsNonWebsocket 非 WebSocket 请求不应返回 200。
func TestWS_RejectsNonWebsocket(t *testing.T) {
	srv := newWSTestServer(t)
	resp, err := srv.Client().Get(srv.URL + "/app/omniedit/api/ws")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Errorf("非 WebSocket 请求不应返回 200，实际 %d", resp.StatusCode)
	}
}
