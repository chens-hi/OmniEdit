package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"omniedit/server/internal/files"
	"omniedit/server/internal/openapi"
	"omniedit/server/internal/watcher"
)

func newOpenapiClient() *openapi.Client { return openapi.New("omniedit-test") }

// watcherEvent 是 watcher.Event 的别名（简化 recorder 引用）。
type watcherEvent = watcher.Event

// newDevTestHandler：DevAllowAll 模式（本地 dev），无 ACL。
// Windows 本地测试统一走这里（fileOwnerInfo 无 Unix 属主语义）。
func newDevTestHandler(t *testing.T, roots []string) (*Handler, *watcher.Watcher) {
	t.Helper()
	w := watcher.New(50 * time.Millisecond)
	h := &Handler{
		FileSvc:     files.NewService(roots),
		OpenAPI:     newOpenapiClient(),
		Prefix:      "/app/omniedit",
		DevAllowAll: true,
		Hub:         NewHub(w),
	}
	return h, w
}

// recorder 收集 Hub 广播到的变更事件，用于断言「不该发生的事件」。
type recorder struct {
	mu  sync.Mutex
	got []watcherEvent
}

func (r *recorder) events() []watcherEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]watcherEvent(nil), r.got...)
}

func (r *recorder) attach(h *Handler) {
	h.Hub.SetObserver(func(ev watcherEvent) {
		r.mu.Lock()
		r.got = append(r.got, ev)
		r.mu.Unlock()
	})
}

// readMT 调用 read 接口并返回其 mtime（read 同时会注册 watcher 基线）。
func readMT(t *testing.T, h *Handler, path string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	req := withUID(httptest.NewRequest(http.MethodGet, "/api/file/read?path="+path, nil), "1000")
	h.ReadFile(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("read 应 200，实际 %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		File struct {
			MTime string `json:"mtime"`
		} `json:"file"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp.File.MTime
}

// writeOK 调用 write 接口，返回 HTTP 状态码（带网关身份 Header）。
func writeOK(t *testing.T, h *Handler, path, content, baseMtime string) int {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"path": path, "content": content, "baseMtime": baseMtime})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := withUID(httptest.NewRequest(http.MethodPost, "/api/file/write", newReader(payload)), "1000")
	h.WriteFile(rec, req)
	return rec.Code
}

// withUID 设置模拟统一网关的 X-Trim-Userid Header。
func withUID(req *http.Request, uid string) *http.Request {
	req.Header.Set("X-Trim-Userid", uid)
	return req
}

// newReader 构造请求体 reader。
func newReader(b []byte) *strings.Reader { return strings.NewReader(string(b)) }
