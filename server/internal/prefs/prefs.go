// Package prefs 提供用户偏好的持久化存储。
//
// 偏好（菜单设置、上次保存目录、会话标签列表）以 JSON blob 形式整体读写，
// 落盘在飞牛应用配置目录（环境变量 TRIM_PKGETC，对应 /vol{n}/@appconf/{appname}/）。
//
// 关键设计：
//   - 按用户隔离：每个 NAS 用户一份 prefs.<uid>.json；无用户身份（本地 dev）
//     回退到全局 prefs.json。
//   - 后端不解析字段：偏好结构由前端定义并整体覆盖写回，后端只做「合法 JSON
//     对象」校验 + 原子落盘，避免前后端字段耦合。
//   - 原子写：先写同目录临时文件再 rename，进程中途被杀也不会留下半截文件。
//   - 并发安全：sync.Mutex 串行化写；读不持锁（rename 在同一目录内是原子的，
//     读到的是旧完整文件或新完整文件，不会读到半截）。
package prefs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// MaxSize 单份偏好的最大字节数（防滥用；正常偏好远小于此）。
const MaxSize = 64 << 10 // 64 KiB

// FileNameGlobal 无用户身份时使用的全局偏好文件名。
const FileNameGlobal = "prefs.json"

// uidSanitizer 清洗 uid，使其可安全作为文件名片段。
// 除字母数字、下划线、连字符外全部替换（含 . 和 /），彻底杜绝路径穿越：
// "..", "../evil", "a/b" 等恶意 uid 都会退化为无害的下划线串。
var uidSanitizer = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// Service 管理偏好文件的读写。
type Service struct {
	dir string
	mu  sync.Mutex
}

// New 创建 Service；dir 为配置目录（如 ${TRIM_PKGETC}）。目录由调用方确保存在
// （main.go 启动时 MkdirAll）；此处不强制，首次写时会再尝试创建。
func New(dir string) *Service {
	return &Service{dir: dir}
}

// Dir 返回配置目录。
func (s *Service) Dir() string { return s.dir }

// fileName 由 uid 推导偏好文件名。uid 为空时使用全局文件名；
// 非法字符（含 . 和 /）被替换为 '_'，防止路径穿越（uid 来自网关 Header，不可全信）。
// 前后缀包裹保证清洗后的名字不会与全局文件名冲突，也不会退化为 "." / ".."。
func fileName(uid string) string {
	if uid == "" {
		return FileNameGlobal
	}
	safe := uidSanitizer.ReplaceAllString(uid, "_")
	return fmt.Sprintf("prefs.%s.json", safe)
}

// Get 读取指定用户的偏好，返回原始 JSON 字节。
// 优先读 prefs.<uid>.json；不存在则回退全局 prefs.json；都不存在或内容为空
// 返回空对象 {}（前端据此用默认值初始化）。文件损坏时同样返回 {}，
// 不让单个坏文件阻塞编辑器启动（损坏文件不自动删除，便于用户排查）。
func (s *Service) Get(uid string) ([]byte, error) {
	name := fileName(uid)
	data, err := os.ReadFile(filepath.Join(s.dir, name))
	if err != nil {
		if os.IsNotExist(err) && uid != "" {
			// 回退全局文件
			data, err = os.ReadFile(filepath.Join(s.dir, FileNameGlobal))
			if err != nil {
				if os.IsNotExist(err) {
					return []byte("{}"), nil
				}
				return nil, err
			}
		} else if os.IsNotExist(err) {
			return []byte("{}"), nil
		} else {
			return nil, err
		}
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return []byte("{}"), nil
	}
	// 内容损坏（非 JSON 对象）时返回空对象，保持与「不存在」一致的宽容语义。
	if !json.Valid([]byte(trimmed)) {
		return []byte("{}"), nil
	}
	return []byte(trimmed), nil
}

// Set 保存指定用户的偏好。raw 必须是合法的 JSON 对象（{} 或 {...}），
// 整体覆盖写回。并发调用串行化；写入原子（临时文件 + rename）。
func (s *Service) Set(uid string, raw []byte) error {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return fmt.Errorf("prefs: 空内容")
	}
	if len(trimmed) > MaxSize {
		return fmt.Errorf("prefs: 内容超过上限 %d 字节", MaxSize)
	}
	// 必须是合法 JSON 且顶层为对象（偏好是键值集合，不接受数组/标量）。
	dec := json.NewDecoder(strings.NewReader(trimmed))
	dec.UseNumber()
	var top any
	if err := dec.Decode(&top); err != nil {
		return fmt.Errorf("prefs: 非法 JSON: %w", err)
	}
	if _, ok := top.(map[string]any); !ok {
		return fmt.Errorf("prefs: 顶层必须是 JSON 对象")
	}
	// 重新序列化，统一格式（缩进 2 空格，便于人工查看）。
	normalized, err := json.MarshalIndent(top, "", "  ")
	if err != nil {
		return fmt.Errorf("prefs: 序列化失败: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return fmt.Errorf("prefs: 创建目录失败: %w", err)
	}
	name := fileName(uid)
	final := filepath.Join(s.dir, name)
	tmp, err := os.CreateTemp(s.dir, name+".tmp-*")
	if err != nil {
		return fmt.Errorf("prefs: 创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName) // 成功 rename 后 Remove 会失败，忽略
	}()
	if _, err := tmp.Write(normalized); err != nil {
		return fmt.Errorf("prefs: 写临时文件失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("prefs: 刷盘失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("prefs: 关闭临时文件失败: %w", err)
	}
	// rename 同目录内原子替换。
	if err := os.Rename(tmpName, final); err != nil {
		return fmt.Errorf("prefs: 原子替换失败: %w", err)
	}
	_ = os.Chmod(final, 0o644)
	return nil
}
