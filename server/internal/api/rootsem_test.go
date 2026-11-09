package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// --- root 直读语义（对齐同类编辑器；权限层已移除） ---

// TestRootSemantic_AnyFileReadable root 模式核心回归：任意属主/权限的文件
// 都可读——包括曾经的踩坑场景 600（无 x 位）文件（fnOS ACL 误判的根源）。
func TestRootSemantic_AnyFileReadable(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "dockers", "HomeAssistant")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "docker-compose.yml")
	if err := os.WriteFile(p, []byte("services:\n  ha:\n    image: homeassistant\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(p, 0o600) // 确保精确 600（无 x 位）

	h, _ := newDevTestHandler(t, nil) // 生产同语义：无边界

	rec := httptest.NewRecorder()
	req := withUID(httptest.NewRequest(http.MethodGet, "/api/file/read?path="+p, nil), "1000")
	h.ReadFile(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("600 文件应可读（root 直读），实际 %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		File struct {
			Content string `json:"content"`
		} `json:"file"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.File.Content == "" {
		t.Error("内容不应为空")
	}
}

// TestRootSemantic_TraversalStillBlocked 权限层移除后，穿越防护必须保留。
func TestRootSemantic_TraversalStillBlocked(t *testing.T) {
	base := t.TempDir()
	// 用原始字符串拼接（filepath.Join 会清理 ..，测不到校验逻辑）
	p := base + `/../escape.txt`
	if err := os.WriteFile(filepath.Join(base, "escape.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	h, _ := newDevTestHandler(t, nil)

	rec := httptest.NewRecorder()
	req := withUID(httptest.NewRequest(http.MethodGet, "/api/file/read?path="+p, nil), "1000")
	h.ReadFile(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("穿越路径应 400，实际 %d body=%s", rec.Code, rec.Body.String())
	}

	// 变形穿越（路径段中间）
	p2 := base + `/sub/../../etc/passwd`
	rec = httptest.NewRecorder()
	req = withUID(httptest.NewRequest(http.MethodGet, "/api/file/read?path="+p2, nil), "1000")
	h.ReadFile(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("段中 .. 应 400，实际 %d", rec.Code)
	}
}

// TestRootSemantic_WriteAndConflict 写入/冲突/另存为行为保留。
func TestRootSemantic_WriteAndConflict(t *testing.T) {
	base := t.TempDir()
	p := filepath.Join(base, "a.txt")
	if err := os.WriteFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	h, _ := newDevTestHandler(t, nil)

	// 正常写。
	mtime := readMT(t, h, p)
	if code := writeOK(t, h, p, "v2", mtime); code != http.StatusOK {
		t.Fatalf("正常写应 200，实际 %d", code)
	}
	// 冲突 409。
	if code := writeOK(t, h, p, "v3", "1970-01-01T00:00:00Z"); code != http.StatusConflict {
		t.Errorf("伪造 baseMtime 应 409，实际 %d", code)
	}
	// 另存为（不存在 → 创建）。
	np := filepath.Join(base, "new", "..", "created.txt") // 父存在，路径含无害 ..
	np = filepath.Join(base, "created.txt")
	if code := writeOK(t, h, np, "hello", ""); code != http.StatusOK {
		t.Errorf("另存应 200，实际 %d", code)
	}
	data, _ := os.ReadFile(np)
	if string(data) != "hello" {
		t.Errorf("另存内容不符: %q", data)
	}
	// 600 文件也可写（属主 w 位）。
	sp := filepath.Join(base, "secret.yml")
	_ = os.WriteFile(sp, []byte("k: 1"), 0o600)
	if code := writeOK(t, h, sp, "k: 2", ""); code != http.StatusOK {
		t.Errorf("600 文件写应 200，实际 %d", code)
	}
}
