package prefs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// newTestService 在临时目录创建 Service，测试结束后自动清理。
func newTestService(t *testing.T) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	return New(dir), dir
}

func TestGetMissingReturnsEmptyObject(t *testing.T) {
	svc, _ := newTestService(t)
	got, err := svc.Get("1000")
	if err != nil {
		t.Fatalf("Get 不应报错: %v", err)
	}
	if strings.TrimSpace(string(got)) != "{}" {
		t.Fatalf("缺失文件应返回 {}，实际 %q", got)
	}
}

func TestGetGlobalFallback(t *testing.T) {
	svc, dir := newTestService(t)
	// 只写全局文件
	if err := os.WriteFile(filepath.Join(dir, FileNameGlobal), []byte(`{"fontSize":16}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// 无该用户文件时应回退到全局
	got, err := svc.Get("1000")
	if err != nil {
		t.Fatalf("Get 不应报错: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(got, &m); err != nil {
		t.Fatalf("返回非法 JSON: %v", err)
	}
	if m["fontSize"].(float64) != 16 {
		t.Fatalf("应回退全局 fontSize=16，实际 %v", m["fontSize"])
	}
}

func TestSetAndRoundTrip(t *testing.T) {
	svc, dir := newTestService(t)
	if err := svc.Set("1000", []byte(`{"fontSize":18,"session":{"tabs":["/vol1/a.md"]}}`)); err != nil {
		t.Fatalf("Set 失败: %v", err)
	}
	// 文件应落在 prefs.1000.json
	path := filepath.Join(dir, "prefs.1000.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("prefs.1000.json 应存在: %v", err)
	}
	got, err := svc.Get("1000")
	if err != nil {
		t.Fatalf("Get 失败: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(got, &m); err != nil {
		t.Fatalf("非法 JSON: %v", err)
	}
	if m["fontSize"].(float64) != 18 {
		t.Fatalf("fontSize 应为 18，实际 %v", m["fontSize"])
	}
}

func TestSetRejectsNonObject(t *testing.T) {
	svc, _ := newTestService(t)
	for _, bad := range []string{`[]`, `"str"`, `123`, `null`, ``, `not json`} {
		if err := svc.Set("1000", []byte(bad)); err == nil {
			t.Errorf("非法内容 %q 应被拒绝", bad)
		}
	}
}

func TestSetRejectsTooLarge(t *testing.T) {
	svc, _ := newTestService(t)
	big := make([]byte, MaxSize+1)
	for i := range big {
		big[i] = 'a'
	}
	payload := []byte(fmt.Sprintf(`{"data":"%s"}`, big))
	if err := svc.Set("1000", payload); err == nil {
		t.Error("超大内容应被拒绝")
	}
}

func TestSetCorruptFileFallsBackToEmpty(t *testing.T) {
	svc, dir := newTestService(t)
	// 手工写坏文件
	if err := os.WriteFile(filepath.Join(dir, "prefs.1000.json"), []byte(`{oops`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Get("1000")
	if err != nil {
		t.Fatalf("Get 不应报错: %v", err)
	}
	if strings.TrimSpace(string(got)) != "{}" {
		t.Fatalf("损坏文件应返回 {}，实际 %q", got)
	}
}

func TestUIDSanitized(t *testing.T) {
	svc, dir := newTestService(t)
	// 恶意 uid 含路径穿越字符，应被清洗，不能逃出配置目录
	if err := svc.Set("../../evil", []byte(`{"x":1}`)); err != nil {
		t.Fatalf("Set 失败: %v", err)
	}
	// 确认没有在配置目录外生成文件
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), "..") {
			t.Fatalf("文件名不应含 ..: %s", e.Name())
		}
	}
	// 应有 prefs._._.evil.json（清洗后）或类似安全名
	found := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "prefs.") && strings.HasSuffix(e.Name(), ".json") && e.Name() != FileNameGlobal {
			found = true
		}
	}
	if !found {
		t.Fatalf("应有清洗后的 prefs 文件，实际: %v", entries)
	}
}

func TestConcurrentSet(t *testing.T) {
	svc, _ := newTestService(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			payload := fmt.Sprintf(`{"n":%d}`, n)
			if err := svc.Set("1000", []byte(payload)); err != nil {
				t.Errorf("并发 Set 失败: %v", err)
			}
		}(i)
	}
	wg.Wait()
	got, err := svc.Get("1000")
	if err != nil {
		t.Fatalf("Get 失败: %v", err)
	}
	if !json.Valid(got) {
		t.Fatalf("并发写后文件应仍合法: %q", got)
	}
}
