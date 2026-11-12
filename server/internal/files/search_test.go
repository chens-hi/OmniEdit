package files

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeFile 在 dir 下创建指定大小的文件，返回路径。
func makeFile(t *testing.T, dir, name string, size int) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, makeBytes(size), 0o644); err != nil {
		t.Fatalf("创建测试文件失败: %v", err)
	}
	return p
}

// makeBytes 生成 size 字节的文本内容（不含 NUL，保证被判为文本）。
func makeBytes(size int) []byte {
	line := strings.Repeat("a", 99) + "\n"
	b := []byte{}
	for len(b) < size {
		b = append(b, line...)
	}
	return b[:size]
}

func TestRead_TooLarge_Reject(t *testing.T) {
	dir := t.TempDir()
	// 创建一个超过 MaxOpenBytes 的文件。
	big := makeFile(t, dir, "big.log", int(MaxOpenBytes)+1024)

	meta, err := Read(big)
	if err == nil {
		t.Fatal("超大文件应直接返回 ErrFileTooLarge")
	}
	var tooLarge ErrFileTooLarge
	if !errors.As(err, &tooLarge) {
		t.Fatalf("错误应为 ErrFileTooLarge，实际 %T: %v", err, err)
	}
	if tooLarge.Size <= MaxOpenBytes {
		t.Errorf("ErrFileTooLarge.Size 应反映真实大小，实际 %d", tooLarge.Size)
	}
	if tooLarge.Limit != MaxOpenBytes {
		t.Errorf("ErrFileTooLarge.Limit 应为 MaxOpenBytes=%d，实际 %d", MaxOpenBytes, tooLarge.Limit)
	}
	if meta != nil {
		t.Error("超限 Read 不应返回 meta")
	}
}

func TestRead_NormalFile_FullContent(t *testing.T) {
	dir := t.TempDir()
	small := makeFile(t, dir, "small.txt", 1024)

	meta, err := Read(small)
	if err != nil {
		t.Fatalf("Read 失败: %v", err)
	}
	if int64(len(meta.Content)) != 1024 {
		t.Errorf("小文件应返回完整内容，实际 %d 字节", len(meta.Content))
	}
	if !meta.Writable {
		t.Error("普通文件应可写")
	}
}

func TestSearch_SkipsBinaryAndHiddenDirs(t *testing.T) {
	dir := t.TempDir()

	// 命中文件。
	if err := os.WriteFile(filepath.Join(dir, "hit.txt"), []byte("hello target world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 二进制文件（含 NUL）应被跳过，即使含关键词。
	if err := os.WriteFile(filepath.Join(dir, "bin.dat"), []byte("target\x00target"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 隐藏目录内命中应被跳过。
	hidden := filepath.Join(dir, ".git")
	if err := os.MkdirAll(hidden, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hidden, "x.txt"), []byte("target hidden\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// node_modules 内命中应被跳过。
	nm := filepath.Join(dir, "node_modules", "pkg")
	if err := os.MkdirAll(nm, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nm, "y.txt"), []byte("target nm\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := SearchInDir(dir, "target")
	if err != nil {
		t.Fatalf("SearchInDir 失败: %v", err)
	}
	if len(res.Hits) != 1 {
		t.Errorf("期望仅 1 处命中（跳过二进制/隐藏/node_modules），实际 %d", len(res.Hits))
		for _, h := range res.Hits {
			t.Logf("  命中: %s:%d", h.Path, h.Line)
		}
	}
	if res.Truncated {
		t.Error("少量结果不应被截断")
	}
}

func TestSearch_CaseInsensitive(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("Hello World\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := SearchInDir(dir, "hello world")
	if err != nil {
		t.Fatalf("SearchInDir 失败: %v", err)
	}
	if len(res.Hits) != 1 {
		t.Errorf("大小写不敏感搜索期望 1 命中，实际 %d", len(res.Hits))
	}
}

func TestSearch_EmptyQuery(t *testing.T) {
	dir := t.TempDir()
	res, err := SearchInDir(dir, "   ")
	if err != nil {
		t.Fatalf("空关键词不应报错: %v", err)
	}
	if len(res.Hits) != 0 {
		t.Error("空关键词应返回空结果")
	}
}

func TestSearch_TruncatesAtMaxResults(t *testing.T) {
	dir := t.TempDir()
	// 生成大量命中行。
	var sb strings.Builder
	for i := 0; i < searchMaxResults+50; i++ {
		sb.WriteString("needle\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "many.txt"), []byte(sb.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := SearchInDir(dir, "needle")
	if err != nil {
		t.Fatalf("SearchInDir 失败: %v", err)
	}
	if len(res.Hits) != searchMaxResults {
		t.Errorf("结果应截断到 %d，实际 %d", searchMaxResults, len(res.Hits))
	}
	if !res.Truncated {
		t.Error("达到上限应标记 Truncated=true")
	}
}
