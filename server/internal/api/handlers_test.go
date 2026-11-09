package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// --- 开发模式（--dev-root 边界仅本地防手滑；生产为 nil = 全盘） ---

func TestDevMode_DevRootBoundaryOptional(t *testing.T) {
	// dev-root 配置时仍生效（本地开发防手滑删系统文件）。
	dir := t.TempDir()
	inner := filepath.Join(dir, "inner")
	if err := os.MkdirAll(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(outside, []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	h, _ := newDevTestHandler(t, []string{inner})

	rec := httptest.NewRecorder()
	req := withUID(httptest.NewRequest(http.MethodGet, "/api/file/read?path="+outside, nil), "1000")
	h.ReadFile(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("dev-root 配置时边界应生效，实际 %d", rec.Code)
	}
}

// --- watcher 行为（与运行模式无关，沿用 DevAllowAll 场景） ---

// TestWriteFile_ResetsWatcherBaseline 保存成功必须以新 mtime 重设基线，
// 否则用户自己的保存会触发「外部修改」弹窗。
func TestWriteFile_ResetsWatcherBaseline(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	h, _ := newDevTestHandler(t, []string{dir})
	var rec recorder
	rec.attach(h)

	mtime := readMT(t, h, p)
	if code := writeOK(t, h, p, "v2", mtime); code != http.StatusOK {
		t.Fatalf("write 应 200，实际 %d", code)
	}
	time.Sleep(400 * time.Millisecond)
	if evs := rec.events(); len(evs) != 0 {
		t.Errorf("保存自身改动不应触发 file-changed，实际 %+v", evs)
	}
}

// TestWriteFile_DetectsRealExternalChange 反向保护：真实外部改动必须仍被检出。
func TestWriteFile_DetectsRealExternalChange(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "b.txt")
	if err := os.WriteFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	h, _ := newDevTestHandler(t, []string{dir})
	var rec recorder
	rec.attach(h)

	readMT(t, h, p)
	time.Sleep(10 * time.Millisecond)
	if err := os.WriteFile(p, []byte("changed-by-other"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		if evs := rec.events(); len(evs) > 0 {
			if evs[0].Reason != "modified" {
				t.Errorf("期望 reason=modified，实际 %q", evs[0].Reason)
			}
			return
		}
	}
	t.Error("外部修改应被 watcher 检出并广播，实际无任何事件")
}

// TestUnwatch_ReleasesWatcherEntry 关闭标签后监控条目被释放。
func TestUnwatch_ReleasesWatcherEntry(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.txt")
	if err := os.WriteFile(p, []byte("v"), 0o644); err != nil {
		t.Fatal(err)
	}
	h, w := newDevTestHandler(t, []string{dir})

	readMT(t, h, p)
	if !w.Watching(p) {
		t.Fatal("read 后应处于监控中")
	}
	rec := httptest.NewRecorder()
	payload, _ := json.Marshal(map[string]any{"path": p})
	uReq := withUID(httptest.NewRequest(http.MethodPost, "/api/file/unwatch", newReader(payload)), "1000")
	h.Unwatch(rec, uReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("unwatch 应 200，实际 %d", rec.Code)
	}
	if w.Watching(p) {
		t.Error("unwatch 后应释放该文件的监控条目")
	}
}
