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
	if s.IsPathAllowed(string(filepath.Separator) + filepath.Join("etc", "passwd")) {
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
	_, err := Read(filepath.Join(os.TempDir(), "omniedit_no_such_file_xyz"))
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

// TestWrite_CreatesNewFile 「另存为」场景：目标不存在时创建而非报 ErrNotFound。
func TestWrite_CreatesNewFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "new", "note.yml") // 父目录不存在也应失败但不 panic
	if _, err := Write(WriteRequest{Path: p, Content: "a: 1"}); err == nil {
		t.Error("父目录不存在时创建应失败（不静默建目录）")
	}

	target := filepath.Join(dir, "untitled.txt")
	mtime, err := Write(WriteRequest{Path: target, Content: "hello"})
	if err != nil {
		t.Fatalf("创建新文件应成功，实际 %v", err)
	}
	if mtime == "" {
		t.Error("应返回新文件 mtime")
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "hello" {
		t.Errorf("内容不符: %q err=%v", data, err)
	}

	// 已存在后再次无 baseMtime 写入 → 正常覆盖（无冲突检测信息）。
	if _, err := Write(WriteRequest{Path: target, Content: "world"}); err != nil {
		t.Errorf("覆盖写应成功，实际 %v", err)
	}
	// 目标是目录 → 拒绝。
	if _, err := Write(WriteRequest{Path: dir, Content: "x"}); err == nil {
		t.Error("目标为目录时应报错")
	}
}

// --- 以下为安全修复的回归测试 ---

// TestRead_Encoding 覆盖编码识别：BOM 剥离、合法 UTF-8、非 UTF-8 拒绝。
func TestRead_Encoding(t *testing.T) {
	dir := t.TempDir()

	// BOM 文件：剥离 BOM 并标记 utf-8-bom。
	bomPath := filepath.Join(dir, "bom.txt")
	if err := os.WriteFile(bomPath, append([]byte{0xEF, 0xBB, 0xBF}, []byte("hello")...), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err := Read(bomPath)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Encoding != "utf-8-bom" || meta.Content != "hello" {
		t.Errorf("BOM 文件: encoding=%q content=%q", meta.Encoding, meta.Content)
	}

	// 普通 UTF-8（含中文）。
	cnPath := filepath.Join(dir, "cn.txt")
	if err := os.WriteFile(cnPath, []byte("中文内容\n第二行"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err = Read(cnPath)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Encoding != "utf-8" || !strings.Contains(meta.Content, "中文") {
		t.Errorf("UTF-8 文件: encoding=%q content=%q", meta.Encoding, meta.Content)
	}
	if meta.LineEnding != "lf" {
		t.Errorf("行尾应识别为 lf，实际 %q", meta.LineEnding)
	}

	// GBK 编码（"中文" 的 GBK 字节）→ GB18030 解码支持，返回中文而非乱码。
	gbkPath := filepath.Join(dir, "gbk.txt")
	gbkBytes := []byte{0xD6, 0xD0, 0xCE, 0xC4} // "中文" GBK
	if err := os.WriteFile(gbkPath, gbkBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err = Read(gbkPath)
	if err != nil {
		t.Fatalf("GBK 文件应正常解码，实际 %v", err)
	}
	if meta.Encoding != "gb18030" || meta.Content != "中文" {
		t.Errorf("GBK 文件: encoding=%q content=%q", meta.Encoding, meta.Content)
	}

	// CRLF 识别。
	crlfPath := filepath.Join(dir, "crlf.txt")
	if err := os.WriteFile(crlfPath, []byte("a\r\nb\r\nc"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err = Read(crlfPath)
	if err != nil {
		t.Fatal(err)
	}
	if meta.LineEnding != "crlf" {
		t.Errorf("CRLF 文件行尾应识别为 crlf，实际 %q", meta.LineEnding)
	}
}

// TestWrite_PreservesBOM 保存时按 HasBOM 回写 BOM，默认（无 BOM 文件/新文件）不带。
func TestWrite_PreservesBOM(t *testing.T) {
	dir := t.TempDir()

	// 带 BOM 保存 → 文件含 BOM。
	withBom := filepath.Join(dir, "bom.txt")
	if _, err := Write(WriteRequest{Path: withBom, Content: "x", HasBOM: true}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(withBom)
	if len(data) != 4 || data[0] != 0xEF || data[1] != 0xBB || data[2] != 0xBF || data[3] != 'x' {
		t.Errorf("应写回 BOM，实际 %v", data)
	}

	// 不带 BOM 保存 → 无 BOM。
	noBom := filepath.Join(dir, "nobom.txt")
	if _, err := Write(WriteRequest{Path: noBom, Content: "x"}); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(noBom)
	if len(data) != 1 || data[0] != 'x' {
		t.Errorf("不应带 BOM，实际 %v", data)
	}
}

// TestCleanAndValidate_AcceptsDoubleDotInFilename 确保合法文件名不被误杀。
// 旧实现用 strings.Contains(path, "..") 判穿越，会把 "v1..v2.md"、"归档..zip"
// 这类 NAS 上常见的命名一并 400 拒掉。
func TestCleanAndValidate_AcceptsDoubleDotInFilename(t *testing.T) {
	for _, name := range []string{"v1..v2.md", "归档..zip", "a...txt", "..hidden.log", "x....y"} {
		if hasDotDotSegment(name) {
			t.Errorf("文件名 %q 不应被判为目录穿越", name)
		}
		// 放到当前平台的绝对目录下走完整校验（Windows 用 D:\、Linux 用 /）。
		abs, err := filepath.Abs(name)
		if err != nil {
			t.Fatal(err)
		}
		rooted := filepath.Join(filepath.Dir(abs), name)
		if got, err := CleanAndValidate(rooted); err != nil {
			t.Errorf("%q 应通过校验，实际 %v", rooted, err)
		} else if filepath.Base(got) != name {
			t.Errorf("got=%q 期望 base=%q", got, name)
		}
	}
}

// TestCleanAndValidate_RejectsDotDotSegment 独立成段的 ".." 必须仍然被拒。
func TestCleanAndValidate_RejectsDotDotSegment(t *testing.T) {
	for _, in := range []string{
		"/vol1/data/../../etc/passwd",
		"/vol1/data/..",
		"..",
		`D:\data\..\..\windows`,
		"/vol1/data/../etc/shadow",
	} {
		if !hasDotDotSegment(in) {
			t.Errorf("%q 应被识别为目录穿越", in)
		}
	}
}

// mustSymlink 创建软链接；平台或权限不支持时跳过测试。
func mustSymlink(t *testing.T, old, new string) {
	t.Helper()
	if err := os.Symlink(old, new); err != nil {
		t.Skipf("当前环境不支持创建符号链接（%v），跳过", err)
	}
}

// TestIsPathAllowed_RejectsSymlinkEscape 封堵 P0：授权目录内放一个指向外部的
// 软链接后，旧实现（字面前缀匹配）会放行 <root>/link 从而读写任意文件。
func TestIsPathAllowed_RejectsSymlinkEscape(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{root, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("top"), 0o644); err != nil {
		t.Fatal(err)
	}

	mustSymlink(t, outside, filepath.Join(root, "escape"))

	s := NewService([]string{root})
	if s.IsPathAllowed(filepath.Join(root, "escape", "secret.txt")) {
		t.Error("经由软链接逃逸到授权目录外，应被拒绝")
	}
	if s.IsPathAllowed(filepath.Join(root, "escape")) {
		t.Error("指向外部的软链接本身也应被拒绝")
	}
	// 目录内正常路径仍应放行（回归保护）。
	if err := os.WriteFile(filepath.Join(root, "ok.txt"), []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !s.IsPathAllowed(filepath.Join(root, "ok.txt")) {
		t.Error("授权目录内的普通文件应被放行")
	}
}

// TestIsPathAllowed_AcceptsSymlinkInsideRoot 确保修复没有一刀切：
// 授权目录**内部**的软链接（真实目标仍在授权范围内）应继续可用，
// 这既是 NAS 上常见的目录整理方式，也是「新建文件」不被误伤的前提。
func TestIsPathAllowed_AcceptsSymlinkInsideRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, filepath.Join(root, "sub"), filepath.Join(root, "link"))

	s := NewService([]string{root})
	if !s.IsPathAllowed(filepath.Join(root, "link", "a.txt")) {
		t.Error("授权目录内部软链接的子路径应被放行")
	}

	// 尚未存在的新建目标文件（父目录真实在授权内）也应放行，保证「另存为」可用。
	if !s.IsPathAllowed(filepath.Join(root, "d", "new.txt")) {
		t.Error("授权目录内不存在的新文件应被放行")
	}
	// 授权外的不存在路径仍应拒绝。
	if s.IsPathAllowed(filepath.Join(base, "elsewhere", "x.txt")) {
		t.Error("授权目录外不存在的路径应被拒绝")
	}
}

// TestSearchInDir_SkipsSymlinks 封堵同源漏洞：DirEntry.IsDir() 基于 lstat，
// 指向目录的软链会被当「文件」整份读入，从而搜出授权外的内容。
func TestSearchInDir_SkipsSymlinks(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{root, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	needle := "TOPSECRETKEYWORD"
	if err := os.WriteFile(filepath.Join(outside, "leak.txt"), []byte(needle), 0o644); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, outside, filepath.Join(root, "linkdir"))

	res, err := SearchInDir(root, needle)
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range res.Hits {
		if strings.Contains(h.Path, "linkdir") {
			t.Errorf("搜索不应跟随软链接，实际命中 %q", h.Path)
		}
	}
	if len(res.Hits) != 0 {
		t.Errorf("授权外内容不应被搜出，实际 %d 条命中", len(res.Hits))
	}
}

// TestRead_GB18030_RoundTrip ANSI（GB18030/GBK）文件：读取转 UTF-8、保存转回，
// 文件在磁盘上保持原编码不变（往返无损）。
func TestRead_GB18030_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	// "中文测试" 的 GBK 字节序列。
	gbk := []byte{0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4}
	p := filepath.Join(dir, "ansi.txt")
	if err := os.WriteFile(p, gbk, 0o644); err != nil {
		t.Fatal(err)
	}

	meta, err := Read(p)
	if err != nil {
		t.Fatalf("GB18030 文件应能读取，实际 %v", err)
	}
	if meta.Encoding != "gb18030" {
		t.Errorf("encoding 应为 gb18030，实际 %q", meta.Encoding)
	}
	if meta.Content != "中文测试" {
		t.Errorf("解码结果不符: %q", meta.Content)
	}

	// 保存：带 encoding=gb18030 → 磁盘字节必须与原 GBK 完全一致（往返无损）。
	if _, err := Write(WriteRequest{Path: p, Content: meta.Content, Encoding: "gb18030"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(gbk) {
		t.Errorf("保存后磁盘字节应与原 GBK 一致:\n want %v\n got  %v", gbk, data)
	}

	// 再次读取：仍是 gb18030、内容一致。
	meta2, err := Read(p)
	if err != nil || meta2.Encoding != "gb18030" || meta2.Content != "中文测试" {
		t.Errorf("二次读取不符: encoding=%q content=%q err=%v", meta2.Encoding, meta2.Content, err)
	}
}
