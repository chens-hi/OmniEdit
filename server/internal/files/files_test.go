package files

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanAndValidate_RejectsEmpty(t *testing.T) {
	for _, in := range []string{"", "   ", "\t"} {
		if _, err := CleanAndValidate(in); !errors.Is(err, ErrPathTraversal) {
			t.Errorf("CleanAndValidate(%q) 期望 ErrPathTraversal，实际 %v", in, err)
		}
	}
}

func TestCleanAndValidate_RejectsTraversal(t *testing.T) {
	for _, in := range []string{
		"../../etc/passwd",
		"/a/../../etc/passwd",
		"/a/b/../../../x",
		"..\\..\\windows",
	} {
		if _, err := CleanAndValidate(in); err == nil {
			t.Errorf("CleanAndValidate(%q) 期望报错，实际 nil", in)
		}
	}
}

func TestCleanAndValidate_RejectsRelative(t *testing.T) {
	// 相对路径（非绝对）应被拒绝，防止解析到应用私有目录。
	for _, in := range []string{"etc/passwd", "somefile.txt", "./local.txt"} {
		if _, err := CleanAndValidate(in); err == nil {
			t.Errorf("CleanAndValidate(%q) 期望拒绝相对路径，实际 nil", in)
		}
	}
}

func TestCleanAndValidate_AcceptsAbsolute(t *testing.T) {
	// filepath.IsAbs 是平台相关的：`/vol1/...` 在 Linux（NAS 生产环境）是绝对路径，
	// 在 Windows（本地开发）不是。因此分别按当前平台断言，确保校验逻辑平台一致。
	linuxPath := "/vol1/Users/admin/a.txt"
	got, err := CleanAndValidate(linuxPath)
	if filepath.IsAbs(linuxPath) {
		// 当前平台认为它是绝对路径（Linux）→ 应通过。
		if err != nil {
			t.Errorf("Linux 绝对路径应通过，实际 %v", err)
		}
		if !strings.HasSuffix(got, "a.txt") {
			t.Errorf("结果异常: %q", got)
		}
	} else {
		// 当前平台认为它不是绝对路径（Windows）→ 应被拒绝。
		if err == nil {
			t.Errorf("Windows 下 /vol1/... 非绝对路径，应被拒绝，实际 got=%q", got)
		}
	}

	// Windows 绝对路径（本地开发）始终应通过。
	if winPath := `D:\Workspaces\OmniEdit\a.txt`; filepath.IsAbs(winPath) {
		if got, err := CleanAndValidate(winPath); err != nil {
			t.Errorf("Windows 绝对路径应通过，实际 %v", err)
		} else if !filepath.IsAbs(got) {
			t.Errorf("结果应为绝对路径: %q", got)
		}
	}
}

func TestIsPathAllowed_DefaultDeny(t *testing.T) {
	s := NewService(nil) // 无授权目录
	if s.IsPathAllowed("/vol1/anything") {
		t.Error("无授权目录时应默认拒绝")
	}
}

func TestIsPathAllowed_RootAndSub(t *testing.T) {
	root := string(filepath.Separator) + filepath.Join("vol1", "data")
	s := NewService([]string{root})

	if !s.IsPathAllowed(root) {
		t.Error("授权根目录本身应允许")
	}
	if !s.IsPathAllowed(filepath.Join(root, "sub", "file.txt")) {
		t.Error("授权目录内的子路径应允许")
	}
	// 兄弟目录（前缀相同但不是路径边界）应拒绝。
	sibling := string(filepath.Separator) + filepath.Join("vol1", "database")
	if s.IsPathAllowed(sibling) {
		t.Error("授权目录的兄弟目录应拒绝")
	}
	// 授权目录外应拒绝。
	if s.IsPathAllowed(string(filepath.Separator)+filepath.Join("etc", "passwd")) {
		t.Error("授权目录外的路径应拒绝")
	}
}

func TestIsPathAllowed_MultipleRoots(t *testing.T) {
	r1 := string(filepath.Separator) + filepath.Join("vol1", "docs")
	r2 := string(filepath.Separator) + filepath.Join("vol2", "media")
	s := NewService([]string{r1, r2})
	if !s.IsPathAllowed(filepath.Join(r2, "a.mp4")) {
		t.Error("第二个授权目录内应允许")
	}
}

func TestAuthorizedRoots_ReturnsCopy(t *testing.T) {
	s := NewService([]string{"/a"})
	got := s.AuthorizedRoots()
	got[0] = "/modified"
	if s.AuthorizedRoots()[0] != "/a" {
		t.Error("AuthorizedRoots 应返回副本，外部修改不应影响内部状态")
	}
}

func TestRead_FileNotFound(t *testing.T) {
	_, err := Read(filepath.Join(os.TempDir(), "omniedit_no_such_file_xyz"), ReadOptions{})
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("期望 ErrNotFound，实际 %v", err)
	}
}

func TestWrite_Conflict(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.txt")
	if err := os.WriteFile(p, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(p)
	mtime := info.ModTime().Format("2006-01-02T15:04:05.999999999Z07:00")

	// 正确 mtime：写入成功。
	if _, err := Write(WriteRequest{Path: p, Content: "v2", BaseMTime: mtime}); err != nil {
		t.Fatalf("匹配 mtime 写入应成功，实际 %v", err)
	}
	// 旧 mtime：应返回 ErrConflict。
	if _, err := Write(WriteRequest{Path: p, Content: "v3", BaseMTime: mtime}); !errors.Is(err, ErrConflict) {
		t.Errorf("旧 mtime 应返回 ErrConflict，实际 %v", err)
	}
}
