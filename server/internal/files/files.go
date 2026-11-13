// Package files 提供带安全校验的文件读写能力。
//
// 安全规则（务必遵守）：
//   - 标准化请求路径，拒绝 ".." 目录穿越；
//   - 只允许访问「已授权目录」内的路径；
//   - 保存前做 mtime 冲突检测，避免覆盖他人改动。
package files

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

var (
	ErrPathTraversal = errors.New("非法路径：拒绝目录穿越")
	ErrNotAuthorized = errors.New("路径不在已授权目录内")
	ErrConflict      = errors.New("文件已被外部修改（mtime 冲突），请重新加载")
	ErrNotFound      = errors.New("文件不存在")
)

// Service 封装文件读写逻辑。
type Service struct {
	// authorizedRoots 是「已授权目录」的绝对路径列表。
	// 首版由开放 API 查询后注入；为空时（未完成授权接入）行为见 IsPathAllowed。
	authorizedRoots []string
}

// NewService 创建文件服务。
func NewService(authorizedRoots []string) *Service {
	return &Service{authorizedRoots: authorizedRoots}
}

// SetAuthorizedRoots 更新已授权目录（授权状态刷新时调用）。
func (s *Service) SetAuthorizedRoots(roots []string) {
	s.authorizedRoots = roots
}

// AuthorizedRoots 返回当前已授权目录列表（供 API 层返回给前端作浏览起点）。
func (s *Service) AuthorizedRoots() []string {
	out := make([]string, len(s.authorizedRoots))
	copy(out, s.authorizedRoots)
	return out
}

// CleanAndValidate 标准化路径并拒绝目录穿越。
// 返回 cleaned 绝对路径。
//
// 兼容两种平台：
//   - 生产（Linux）：/vol1/... 形式的绝对路径；
//   - 本地开发（Windows）：D:\... 形式的绝对路径。
//
// 穿越判定必须在 Clean **之前**做：filepath.Clean 会把 "/a/../../x" 折叠成
// "/x"，Clean 后再找 ".." 永远找不到（旧实现正是如此，于是生产平台上完全
// 依赖 IsPathAllowed 兜底，属于脆弱的巧合）。这里改为逐段检查原始路径中是否
// 存在独立的 ".." 段——同时避免旧实现 `Contains(path, "..")` 误杀合法文件名
// （如 NAS 上常见的 "v1..v2.md"、"归档..zip"）。
func CleanAndValidate(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", ErrPathTraversal
	}
	// 拒绝目录穿越：任何独立成段的 ".." 都视为试图逃逸。
	if hasDotDotSegment(raw) {
		return "", ErrPathTraversal
	}
	cleaned := filepath.Clean(raw)
	// 必须是绝对路径：防止相对路径（如 "etc/passwd"）被解析到应用私有目录。
	if !filepath.IsAbs(cleaned) {
		return "", ErrPathTraversal
	}
	return cleaned, nil
}

// hasDotDotSegment 判断路径中是否存在独立的 ".." 段。
// 同时按 '/' 与 '\' 拆分：请求参数可能来自另一平台的写法（如 Linux NAS 上
// 传入 Windows 风格路径，或反之），不能只认当前平台的分隔符。
func hasDotDotSegment(p string) bool {
	normalized := strings.ReplaceAll(p, "\\", "/")
	for _, seg := range strings.Split(normalized, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// IsPathAllowed 判断路径是否落在任一已授权目录内（Service 自带的全局 roots，
// 仅用于开发模式/测试）。生产环境按用户授权请用 PathWithinRoots。
func (s *Service) IsPathAllowed(cleanedPath string) bool {
	if len(s.authorizedRoots) == 0 {
		return false
	}
	return PathWithinRoots(s.authorizedRoots, cleanedPath)
}

// PathWithinRoots 判断 cleanedPath 是否落在给定授权目录集合内。
// 授权是「按用户」的，roots 由 API 层从开放 API 取得后传入；为空默认拒绝。
//
// 关键：比较前先用 EvalSymlinks 解析出**真实路径**。否则字面前缀匹配可被符号
// 链接绕过——用户在授权目录内放一个指向 /etc 或 C:\Users 的软链接，请求
// "<授权目录>/link" 就能读写授权范围之外的任意文件，整套授权模型形同虚设。
// 授权根目录自身同样解析（NAS 上 /volX 常是指向真实存储的链接）。
func PathWithinRoots(roots []string, cleanedPath string) bool {
	if len(roots) == 0 {
		return false
	}
	realPath, err := resolveReal(cleanedPath)
	if err != nil {
		// 无法确认真实路径（链接环、权限异常等）：保守拒绝。
		return false
	}
	for _, root := range roots {
		realRoot, err := resolveReal(filepath.Clean(root))
		if err != nil {
			continue
		}
		if withinTree(realPath, realRoot) {
			return true
		}
	}
	return false
}

// withinTree 判断 realPath 是否等于 realRoot 或位于其子树内。
//
// 注意区分平台语义：
//   - Linux（NAS 生产）路径大小写敏感，必须逐字节比较，否则 "/vol1/Data" 会被
//     误判为 "/vol1/data" 的子路径，反而造成越权。
//   - Windows（本地开发）路径大小写不敏感，比较前统一为小写。
//   - realRoot 为分隔符结尾（如 "/"）时不再追加，避免拼出 "//" 这类永不匹配的前缀。
func withinTree(realPath, realRoot string) bool {
	sep := string(filepath.Separator)
	if runtime.GOOS == "windows" {
		// Windows 路径大小写不敏感。
		realPath = strings.ToLower(realPath)
		realRoot = strings.ToLower(realRoot)
	}
	if realPath == realRoot {
		return true
	}
	if !strings.HasSuffix(realRoot, sep) {
		realRoot += sep
	}
	return strings.HasPrefix(realPath, realRoot)
}

// resolveReal 解析路径中的全部符号链接，返回真实绝对路径。
//
//   - 路径存在：直接 EvalSymlinks。
//   - 路径不存在（例如尚未创建的目标文件）：解析其父目录后拼回 base name，
//     这样"在授权目录内新建文件"仍然可用，同时仍能识别父目录被链接到外部的情况。
//   - 父目录也不存在或解析失败：回退为原路径（后续文件操作本身会失败），
//     由调用方按错误处理。
func resolveReal(p string) (string, error) {
	real, err := filepath.EvalSymlinks(p)
	if err == nil {
		return real, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	dir := filepath.Dir(p)
	if dir == p {
		// 已到根（如 "/"），没有更深的父级可解析。
		return p, nil
	}
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return p, nil
		}
		return "", err
	}
	return filepath.Join(realDir, filepath.Base(p)), nil
}

// ReadMeta 文件读取结果元信息。
type ReadMeta struct {
	Path        string `json:"path"`
	DisplayPath string `json:"displayPath,omitempty"`
	Content     string `json:"content"`
	Size        int64  `json:"size"`
	ModTime     string `json:"mtime"` // RFC3339Nano，用于冲突检测
	Writable    bool   `json:"writable"`
	// Encoding 内容编码："utf-8"（含 ASCII）或 "utf-8-bom"。
	// 非 UTF-8 文件读取直接报错（ErrNotUTF8），不返回乱码。
	Encoding string `json:"encoding,omitempty"`
	// LineEnding 行尾风格："lf" | "crlf" | "mixed" | ""（空文件/单行无换行）。
	// 保存时按此回写，保持文件原有风格不被静默改写。
	LineEnding string `json:"lineEnding,omitempty"`
}

// 大文件保护阈值。
const (
	// MaxOpenBytes 可打开的文件上限（10 MB）。超过直接拒绝（ErrFileTooLarge），
	// 无确认/截断预览路径——前端性能优化后 10MB 内可流畅编辑，更大的文件
	// JSON 传输通道先成为瓶颈，明确提示比模糊处理更干净。
	MaxOpenBytes int64 = 10 << 20
)

// ErrFileTooLarge 表示文件超过打开上限，无法处理。
type ErrFileTooLarge struct {
	Size  int64
	Limit int64
}

func (e ErrFileTooLarge) Error() string {
	// 只陈述事实（多大、上限多少），不加「无法打开」这类结论——
	// 结论由前端按场景措辞（打开/预览/搜索语气不同），避免文案被后端焊死。
	return fmt.Sprintf("文件过大：%.1f MB，上限 %.0f MB",
		float64(e.Size)/(1<<20), float64(e.Limit)/(1<<20))
}

// ErrNotUTF8 表示文件不是有效的 UTF-8 编码（如 GBK/GB18030、Latin-1 等）。
// 编辑器不做静默转码（避免有损往返），由前端给出明确提示。
type ErrNotUTF8 struct {
	Path string
}

func (e ErrNotUTF8) Error() string {
	return "文件不是 UTF-8 编码（当前仅支持 UTF-8/ASCII，GBK 等编码将在后续版本支持）: " + e.Path
}

// ErrBinary 表示文件是二进制内容（含 NUL 字节或不可打印字节比例过高），
// 拒绝按文本打开。与扩展名无关——无后缀文件也能正确识别，
// 避免把图片/可执行文件当文本读出一堆乱码。
type ErrBinary struct {
	Path string
	// Reason 具体判定依据，便于用户理解（如"含 NUL 字节"、"不可打印字符占比 42%"）。
	Reason string
}

func (e ErrBinary) Error() string {
	return "文件是二进制内容，无法作为文本编辑（" + e.Reason + "）: " + e.Path
}

// utf8BOM 是 UTF-8 字节序标记。
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// binaryProbeBytes 二进制检测的采样字节数。只看前 8KB——
// 足够覆盖所有主流二进制格式的文件头，且对 10MB 文件也几乎零成本。
const binaryProbeBytes = 8192

// 二进制判定阈值：不可打印字符占比超过此值即判为二进制。
// 纯文本（含中文 UTF-8/GBK）通常 < 1%；正常的控制字符只有 \t \n \r。
const binaryControlRatio = 0.10

// looksBinary 判断一段字节是否为二进制内容。
//
// 判定规则（任一成立即判二进制）：
//  1. 含 NUL 字节（0x00）——文本文件不会有，是最强的二进制信号；
//  2. 采样窗口内「不可打印字符」占比 > 10%。
//     可打印 = tab / LF / CR / 以及 >= 0x20 的字节（注意：UTF-8 多字节
//     序列的每个字节都 >= 0x80，因此中文不会误判）。
//
// 这套规则与扩展名完全无关，因此无后缀文件、错后缀文件都能正确识别。
func looksBinary(data []byte) (bool, string) {
	if len(data) == 0 {
		return false, "" // 空文件按文本处理
	}
	probe := data
	if len(probe) > binaryProbeBytes {
		probe = probe[:binaryProbeBytes]
	}
	control := 0
	for _, b := range probe {
		switch {
		case b == 0x00:
			return true, "含 NUL 字节"
		case b == 0x09 || b == 0x0A || b == 0x0D:
			// tab / LF / CR：正常的文本控制字符
		case b >= 0x20:
			// 可打印 ASCII 或 UTF-8 多字节序列的一部分
		default:
			// 其余 C0 控制字符（0x01-0x08, 0x0B, 0x0C, 0x0E-0x1F）
			control++
		}
	}
	if ratio := float64(control) / float64(len(probe)); ratio > binaryControlRatio {
		return true, fmt.Sprintf("不可打印字符占比 %.0f%%", ratio*100)
	}
	return false, ""
}

// decodeText 把文件字节解码为文本：
//   - 先做二进制检测（与扩展名无关）：命中则返回 ErrBinary；
//   - 识别并剥离 UTF-8 BOM（meta.Encoding = "utf-8-bom"）；
//   - 严格校验 UTF-8 合法性（utf8.Valid）；
//   - 非 UTF-8 时尝试 GB18030（Windows「ANSI」在简体中文环境的实际代码页，
//     GBK 的超集；对纯 ASCII 文件等同 UTF-8，不会误判）——转成 UTF-8 返回并
//     标记 meta.Encoding = "gb18030"，保存时由 Write 转回原编码写盘；
//   - GB18030 也解不了（如 Big5/Shift-JIS/其它二进制）返回 ErrNotUTF8，
//     绝不静默乱码。
func decodeText(data []byte, meta *ReadMeta) error {
	// 二进制检测必须在编码判断之前：GB18030 几乎能解码任何字节流，
	// 若先走编码分支，图片/可执行文件会被"成功"解码成乱码文本。
	if isBin, reason := looksBinary(data); isBin {
		return ErrBinary{Path: meta.Path, Reason: reason}
	}
	if len(data) >= 3 && string(data[:3]) == string(utf8BOM) {
		meta.Encoding = "utf-8-bom"
		data = data[3:]
	} else if utf8.Valid(data) {
		meta.Encoding = "utf-8"
	} else {
		// ANSI（Windows 代码页）尝试：GB18030 覆盖 GBK/GB2312。
		// 中文简体环境 NAS 上的 ANSI 文件几乎都源于此。
		decoded, ok := decodeGB18030(data)
		if !ok {
			return ErrNotUTF8{Path: meta.Path}
		}
		meta.Encoding = "gb18030"
		meta.Content = decoded
		meta.LineEnding = detectLineEnding(decoded)
		return nil
	}
	meta.Content = string(data)
	meta.LineEnding = detectLineEnding(meta.Content)
	return nil
}

// decodeGB18030 尝试按 GB18030 解码。解码失败（字节序列非法）返回 ok=false。
// 注意：GB18030 几乎能解码任何字节流，严格性有限——但对「合法 UTF-8 已被
// 排除」的字节流，解出的中文几乎总是用户期望的 ANSI 内容；且保存时转回
// 同一编码，往返无损。
func decodeGB18030(data []byte) (string, bool) {
	dec := simplifiedchinese.GB18030.NewDecoder()
	out, err := dec.Bytes(data)
	if err != nil {
		return "", false
	}
	return string(out), true
}

// encodeGB18030 把 UTF-8 文本编码回 GB18030 字节（保存 ANSI 文件时用）。
func encodeGB18030(s string) ([]byte, error) {
	enc := simplifiedchinese.GB18030.NewEncoder()
	return enc.Bytes([]byte(s))
}

// detectLineEnding 识别行尾风格，保存时用于保持原文件风格。
func detectLineEnding(s string) string {
	var crlf, lf int
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			if i > 0 && s[i-1] == '\r' {
				crlf++
			} else {
				lf++
			}
		}
	}
	switch {
	case crlf > 0 && lf > 0:
		return "mixed"
	case crlf > 0:
		return "crlf"
	case lf > 0:
		return "lf"
	default:
		return ""
	}
}

// Read 读取文本文件内容（带大文件保护）。
// 调用方需先完成路径安全与授权校验。
// 文件超过 MaxOpenBytes 时直接返回 ErrFileTooLarge（无确认/截断预览路径）。
func Read(absPath string) (*ReadMeta, error) {
	info, err := os.Stat(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("目标是目录而非文件: %s", absPath)
	}

	size := info.Size()
	// 判断是否可写（应用用户视角的粗判；用户级 ACL 由 API 层用开放 API 校验）。
	writable := info.Mode().Perm()&0o200 != 0

	// 大文件保护：超过上限直接拒绝，明确提示。
	if size > MaxOpenBytes {
		return nil, ErrFileTooLarge{Size: size, Limit: MaxOpenBytes}
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, err
	}

	meta := &ReadMeta{
		Path:     absPath,
		Size:     size,
		ModTime:  info.ModTime().Format(time.RFC3339Nano),
		Writable: writable,
	}
	if err := decodeText(data, meta); err != nil {
		return nil, err
	}
	return meta, nil
}

// WriteRequest 保存请求。
type WriteRequest struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	BaseMTime string `json:"baseMtime,omitempty"` // 客户端读取时的 mtime，用于冲突检测
	// HasBOM 原文件带 UTF-8 BOM 时为 true，写回时保持（避免 BOM 静默丢失）。
	HasBOM bool `json:"hasBom,omitempty"`
	// Encoding 原文件编码（read 返回的 meta.encoding）。gb18030 文件保存时
	// 转回 GB18030 写盘——文件在 NAS 上保持 ANSI 编码不变，仅编辑器内存
	// 中是 UTF-8。空/"utf-8"/"utf-8-bom" 按 UTF-8 处理。
	Encoding string `json:"encoding,omitempty"`
}

// Write 写入文件：目标不存在时创建（「另存为」场景），存在时带 mtime 冲突检测。
//
// 安全边界由调用方（API 层）负责：授权目录 + symlink 校验、用户写 ACL。
// 创建使用 0644；冲突检测仅对已存在文件生效（新文件无从冲突）。
func Write(req WriteRequest) (newMTime string, err error) {
	mode := os.FileMode(0o644)
	creating := false
	info, err := os.Stat(req.Path)
	if err != nil {
		if !os.IsNotExist(err) {
			return "", err
		}
		creating = true
	} else {
		if info.IsDir() {
			return "", fmt.Errorf("目标是目录而非文件: %s", req.Path)
		}
		mode = info.Mode().Perm()
		// 冲突检测：若客户端携带 baseMtime 且与服务端当前 mtime 不一致，则拒绝写入。
		if req.BaseMTime != "" {
			current := info.ModTime().Format(time.RFC3339Nano)
			if current != req.BaseMTime {
				return "", ErrConflict
			}
		}
	}

	// 编码与校验：内容必须为合法 UTF-8（前端不做转码，此处是最后防线）。
	if !utf8.ValidString(req.Content) {
		return "", fmt.Errorf("保存内容含非法 UTF-8 序列，已拒绝写入: %s", req.Path)
	}
	// 目标编码写盘：gb18030 文件转回 ANSI 编码（保持 NAS 上的原编码不变）；
	// UTF-8 文件按 BOM 原则「不加不删」。
	var out []byte
	switch req.Encoding {
	case "gb18030":
		encoded, err := encodeGB18030(req.Content)
		if err != nil {
			return "", fmt.Errorf("转回 GB18030 编码失败: %w", err)
		}
		out = encoded
	default:
		out = []byte(req.Content)
		if req.HasBOM {
			out = append(utf8BOM, out...)
		}
	}

	// 原子写：统一走临时文件 + rename，确保写入中途崩溃不会留下半截损坏文件。
	// 与 prefs.go 的原子写策略一致。临时文件建在同目录（rename 同文件系统内原子）。
	tmp, err := os.CreateTemp(filepath.Dir(req.Path), ".omniedit-tmp-*")
	if err != nil {
		return "", fmt.Errorf("创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return "", fmt.Errorf("写入临时文件失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return "", err
	}
	// 已存在文件保留原权限；新建文件用 0644。
	if !creating {
		if err := os.Chmod(tmpName, mode); err != nil {
			os.Remove(tmpName)
			return "", err
		}
	}
	if err := os.Rename(tmpName, req.Path); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("原子替换失败: %w", err)
	}
	newInfo, err := os.Stat(req.Path)
	if err != nil {
		return "", err
	}
	return newInfo.ModTime().Format(time.RFC3339Nano), nil
}

// Entry 目录中的一项。
type Entry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size,omitempty"`
}

// ListDir 列出目录下的直接子项（子目录 + 文件）。
// 只允许访问已授权目录内的路径（由 API 层先做 IsPathAllowed 校验）。
// 跳过无法读取的项，避免单个权限异常导致整体失败。
func ListDir(dirPath string) ([]Entry, error) {
	info, err := os.Stat(dirPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("目标是文件而非目录: %s", dirPath)
	}

	osEntries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}

	entries := make([]Entry, 0, len(osEntries))
	for _, e := range osEntries {
		name := e.Name()
		// 隐藏目录穿越风险：只取 base name 作为展示名，路径由 dirPath 拼接。
		full := filepath.Join(dirPath, name)
		isDir := e.IsDir()
		var size int64
		if !isDir {
			if fi, err := e.Info(); err == nil {
				size = fi.Size()
			}
		}
		entries = append(entries, Entry{
			Name:  name,
			Path:  full,
			IsDir: isDir,
			Size:  size,
		})
	}
	return entries, nil
}

// 搜索时的默认限制。
const (
	searchMaxResults   = 200     // 最多返回命中数
	searchMaxFileSize  = 2 << 20 // 单文件 > 2MB 跳过（避免大文件卡顿）
	searchMaxFileBytes = 200     // 文件名/路径显示截断
)

// isBinarySnippet 粗判前若干字节是否像二进制（含 NUL 或大量不可打印字符）。
func isBinarySnippet(b []byte) bool {
	n := len(b)
	if n > 512 {
		n = 512
	}
	if n == 0 {
		return false
	}
	for i := 0; i < n; i++ {
		if b[i] == 0 {
			return true
		}
	}
	return false
}

// SearchHit 一次内容命中。
type SearchHit struct {
	Path string `json:"path"`
	Line int    `json:"line"` // 1-based 行号
	Text string `json:"text"` // 命中行内容（截断）
}

// SearchResult 搜索结果汇总。
type SearchResult struct {
	Hits          []SearchHit `json:"hits"`
	FilesSearched int         `json:"filesSearched"`
	Truncated     bool        `json:"truncated"`
}

// SearchInDir 在 dirPath 内递归搜索包含 query 的文本文件。
// 只搜索已授权目录内的路径（由 API 层先做 IsPathAllowed 校验）。
// 跳过二进制、超大文件与常见依赖/版本控制目录。
func SearchInDir(dirPath, query string) (*SearchResult, error) {
	if strings.TrimSpace(query) == "" {
		return &SearchResult{Hits: []SearchHit{}}, nil
	}

	res := &SearchResult{Hits: []SearchHit{}}
	lowerQuery := strings.ToLower(query)

	var walk func(dir string) error
	walk = func(dir string) error {
		if res.Truncated {
			return nil
		}
		osEntries, err := os.ReadDir(dir)
		if err != nil {
			return nil // 单个目录读失败不中断整体搜索
		}
		for _, e := range osEntries {
			if res.Truncated {
				return nil
			}
			name := e.Name()
			full := filepath.Join(dir, name)

			// 跳过符号链接：DirEntry.IsDir() 基于 lstat，指向目录的软链会被当成
			// 「文件」整份读入，从而把授权目录外的内容搜出来。搜索不跟随软链
			// （与 rg/grep 默认行为一致），软链目标应由用户显式授权。
			if e.Type()&os.ModeSymlink != 0 {
				continue
			}

			// 跳过常见依赖 / 版本控制 / 隐藏目录。
			if e.IsDir() {
				if isSkipDir(name) {
					continue
				}
				if err := walk(full); err != nil {
					return err
				}
				continue
			}

			// 文件：跳过超大文件。
			info, err := e.Info()
			if err != nil || info.Size() > searchMaxFileSize {
				continue
			}

			data, err := os.ReadFile(full)
			if err != nil {
				continue
			}
			if isBinarySnippet(data) {
				continue
			}

			res.FilesSearched++
			// 逐行匹配（大小写不敏感）。
			lines := strings.Split(string(data), "\n")
			for i, line := range lines {
				if strings.Contains(strings.ToLower(line), lowerQuery) {
					res.Hits = append(res.Hits, SearchHit{
						Path: full,
						Line: i + 1,
						Text: truncate(line, searchMaxFileBytes),
					})
					if len(res.Hits) >= searchMaxResults {
						res.Truncated = true
						return nil
					}
				}
			}
		}
		return nil
	}

	if err := walk(dirPath); err != nil {
		return nil, err
	}
	return res, nil
}

// isSkipDir 判断是否为搜索时应跳过的目录。
func isSkipDir(name string) bool {
	switch name {
	case "node_modules", ".git", ".svn", "dist", "build", "vendor",
		"__pycache__", ".venv", "venv", "target", ".idea", ".vscode":
		return true
	}
	return strings.HasPrefix(name, ".")
}

// truncate 按字符截断字符串并加省略号。
func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return strings.TrimRight(s, "\r")
	}
	return strings.TrimRight(string(r[:max]), "\r") + "…"
}
