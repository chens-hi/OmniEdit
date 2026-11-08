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
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
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
// 因此不盲目拼前缀，而是先 Clean 再要求结果为绝对路径，同时拒绝任何 ".."。
func CleanAndValidate(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", ErrPathTraversal
	}
	cleaned := filepath.Clean(raw)
	// 拒绝目录穿越：Clean 后仍含 ".." 说明试图逃逸。
	if strings.Contains(cleaned, "..") {
		return "", ErrPathTraversal
	}
	// 必须是绝对路径：防止相对路径（如 "etc/passwd"）被解析到应用私有目录。
	if !filepath.IsAbs(cleaned) {
		return "", ErrPathTraversal
	}
	return cleaned, nil
}

// IsPathAllowed 判断路径是否落在任一已授权目录内。
// 若尚未配置授权目录（authorizedRoots 为空），当前返回 false 以「默认拒绝」，
// 由调用方决定是否在开发模式下放宽。
func (s *Service) IsPathAllowed(cleanedPath string) bool {
	if len(s.authorizedRoots) == 0 {
		return false
	}
	for _, root := range s.authorizedRoots {
		root = filepath.Clean(root)
		if cleanedPath == root || strings.HasPrefix(cleanedPath, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// ReadMeta 文件读取结果元信息。
type ReadMeta struct {
	Path        string `json:"path"`
	DisplayPath string `json:"displayPath,omitempty"`
	Content     string `json:"content"`
	Size        int64  `json:"size"`
	ModTime     string `json:"mtime"` // RFC3339Nano，用于冲突检测
	Writable    bool   `json:"writable"`
	// TooLarge 表示文件超过默认打开阈值，Content 为空，需前端确认后以 allowLarge 重取。
	TooLarge bool `json:"tooLarge,omitempty"`
	// Truncated 表示 Content 已被截断（仅返回了前 MaxPreviewBytes），应作只读预览。
	Truncated bool `json:"truncated,omitempty"`
}

// 大文件保护阈值。
const (
	// MaxOpenBytes 默认可完整打开的文件上限（5 MB）。超过则要求前端确认。
	MaxOpenBytes int64 = 5 << 20
	// MaxPreviewBytes 超大文件「只读预览」时返回的前缀长度（256 KB）。
	MaxPreviewBytes int64 = 256 << 10
)

// ErrTooLarge 表示文件过大且未允许以预览方式打开。
type ErrTooLarge struct {
	Size int64
}

func (e ErrTooLarge) Error() string {
	return fmt.Sprintf("文件过大（%d 字节），需确认后以预览方式打开", e.Size)
}

// ReadOptions 控制 Read 的行为。
type ReadOptions struct {
	// AllowLarge 允许打开超过 MaxOpenBytes 的大文件（只返回截断的只读预览）。
	AllowLarge bool
}

// Read 读取文本文件内容（带大文件保护）。
// 调用方需先完成路径安全与授权校验。
func Read(absPath string, opts ReadOptions) (*ReadMeta, error) {
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

	meta := &ReadMeta{
		Path:     absPath,
		Size:     size,
		ModTime:  info.ModTime().Format(time.RFC3339Nano),
		Writable: writable,
	}

	// 大文件保护：超过阈值且未显式允许时，只返回元信息。
	if size > MaxOpenBytes && !opts.AllowLarge {
		meta.TooLarge = true
		return meta, nil
	}

	// 未超阈值：完整读取。
	if size <= MaxOpenBytes {
		data, err := os.ReadFile(absPath)
		if err != nil {
			return nil, err
		}
		meta.Content = string(data)
		return meta, nil
	}

	// 超阈值但已允许：只读截断预览（前 MaxPreviewBytes），标记 Truncated + 不可写。
	f, err := os.Open(absPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, MaxPreviewBytes)
	n, _ := io.ReadFull(f, buf)
	meta.Content = string(buf[:n])
	meta.Truncated = true
	meta.Writable = false // 截断预览禁止保存，避免覆盖原始大文件
	return meta, nil
}

// WriteRequest 保存请求。
type WriteRequest struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	BaseMTime string `json:"baseMtime,omitempty"` // 客户端读取时的 mtime，用于冲突检测
}

// Write 写入文件，带 mtime 冲突检测。
func Write(req WriteRequest) (newMTime string, err error) {
	info, err := os.Stat(req.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", ErrNotFound
		}
		return "", err
	}

	// 冲突检测：若客户端携带 baseMtime 且与服务端当前 mtime 不一致，则拒绝写入。
	if req.BaseMTime != "" {
		current := info.ModTime().Format(time.RFC3339Nano)
		if current != req.BaseMTime {
			return "", ErrConflict
		}
	}

	if err := os.WriteFile(req.Path, []byte(req.Content), info.Mode().Perm()); err != nil {
		return "", err
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
	searchMaxResults   = 200              // 最多返回命中数
	searchMaxFileSize  = 2 << 20          // 单文件 > 2MB 跳过（避免大文件卡顿）
	searchMaxFileBytes = 200              // 文件名/路径显示截断
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
	Path  string `json:"path"`
	Line  int    `json:"line"`   // 1-based 行号
	Text  string `json:"text"`   // 命中行内容（截断）
}

// SearchResult 搜索结果汇总。
type SearchResult struct {
	Hits    []SearchHit `json:"hits"`
	FilesSearched int   `json:"filesSearched"`
	Truncated bool      `json:"truncated"`
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
