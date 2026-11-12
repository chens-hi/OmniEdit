// Package api 提供 OmniEdit 的 HTTP API（挂载在统一网关前缀下）。
//
// 路由（完整对外路径为 {gatewayPrefix}/api/...，见 main.go buildMux）：
//
//	GET  /api/health          健康检查
//	GET  /api/ws              WebSocket：文件变更推送（事件路由用）
//	GET  /api/file/read       读取文本文件（?path=...）
//	GET  /api/file/raw        二进制原样输出（?path=...，HTML/MD 预览的相对资源用）
//	POST /api/file/write      保存文本文件（不存在则创建，支持另存为）
//	POST /api/file/unwatch    关闭标签时释放文件监控
//
// 权限模型（对齐同类 fnOS 编辑器，如万能编辑器；真机决策）：
//   - 后端以 root 运行（config/privilege run-as=root），文件能读即返回；
//   - **不做用户级权限检查**——fnOS 文件管理器对普通用户本不隔离用户目录
//     （除管理员），应用层重复建设无意义；
//   - 保留的防线：路径穿越校验（独立 ".." 段 + EvalSymlinks）、mtime 冲突
//     检测（409）、大文件保护、WS 事件路由（连接绑定 uid 仅用于把
//     file-changed 推给打开该文件的会话，非权限语义）。
package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"omniedit/server/internal/files"
	"omniedit/server/internal/gateway"
	"omniedit/server/internal/openapi"
	"omniedit/server/internal/prefs"
)

// Handler 聚合依赖。
type Handler struct {
	FileSvc *files.Service
	OpenAPI *openapi.Client
	Prefix  string
	// Hub 管理文件变更推送的 WebSocket 连接（可为 nil，此时 WS 接口不可用）。
	Hub *Hub
	// Prefs 用户偏好存储（可为 nil，此时 prefs 接口返回 503）。
	Prefs *prefs.Service
	// DevAllowAll 仅用于本地开发调试（无网关环境下放行）。
	// 生产（NAS）环境必须为 false。
	DevAllowAll bool
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": msg})
}

// requireGatewayUser 确保请求经过统一网关并携带用户身份。
// 身份仅用于 WS 事件路由与日志；文件访问不做用户级权限检查（见包注释）。
func (h *Handler) requireGatewayUser(r *http.Request) (gateway.User, bool) {
	u, ok := gateway.FromRequest(r)
	if ok {
		return u, true
	}
	if h.DevAllowAll {
		return gateway.User{UID: "0", Username: "dev", IsAdmin: true}, true
	}
	return gateway.User{}, false
}

// devRootGuard 本地开发防手滑边界：--dev-root 配置时生效（生产为空 = 全盘）。
// 仅 DevAllowAll 下有意义；保护开发者本机不误删系统文件。
func (h *Handler) devRootGuard(absPath string) error {
	if !h.DevAllowAll {
		return nil
	}
	if roots := h.FileSvc.AuthorizedRoots(); len(roots) > 0 && !files.PathWithinRoots(roots, absPath) {
		return files.ErrNotAuthorized
	}
	return nil
}

// Health 健康检查。
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "app": "omniedit"})
}

// ReadFile GET /api/file/read?path=...
func (h *Handler) ReadFile(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireGatewayUser(r)
	if !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}

	rawPath := r.URL.Query().Get("path")
	allowLarge := r.URL.Query().Get("allowLarge") == "1"
	absPath, err := files.CleanAndValidate(rawPath)
	if err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.devRootGuard(absPath); err != nil {
		errJSON(w, http.StatusForbidden, err.Error())
		return
	}

	meta, err := files.Read(absPath, files.ReadOptions{AllowLarge: allowLarge})
	if err != nil {
		status := http.StatusInternalServerError
		if err == files.ErrNotFound {
			status = http.StatusNotFound
		}
		errJSON(w, status, err.Error())
		return
	}

	// 展示用路径转换（尽力而为，失败则回退原始路径）。
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if dp, err := h.OpenAPI.ConvertPath(ctx, absPath); err == nil {
		meta.DisplayPath = dp
	} else {
		meta.DisplayPath = absPath
	}

	// 注册文件监控：外部修改后通过 WebSocket 推送给该用户的客户端。
	if h.Hub != nil && !meta.TooLarge {
		h.Hub.Watch(absPath, user.UID)
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "file": meta})
}

// RawFile GET /api/file/raw?path=... —— 原样流式输出文件字节（按扩展名给
// Content-Type），供 HTML/Markdown 预览中相对路径资源（图片/样式等）解析。
// 权限模型与 /api/file/read 完全一致：网关身份 + 穿越校验 + devRootGuard；
// 与文本读取相比不新增能力（read 本就能把任意文件字节装进 JSON 返回），
// 仅输出形态为二进制流。ServeFile 自带 Range/HEAD 支持，大文件不占内存。
func (h *Handler) RawFile(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireGatewayUser(r); !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}
	rawPath := r.URL.Query().Get("path")
	absPath, err := files.CleanAndValidate(rawPath)
	if err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.devRootGuard(absPath); err != nil {
		errJSON(w, http.StatusForbidden, err.Error())
		return
	}
	// 预览资源允许短缓存（同一路径内容变更频率低；冲突检测不走这里）。
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.ServeFile(w, r, absPath)
}

// WriteFile POST /api/file/write
func (h *Handler) WriteFile(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireGatewayUser(r)
	if !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}

	var req files.WriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "请求体解析失败")
		return
	}

	absPath, err := files.CleanAndValidate(req.Path)
	if err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.devRootGuard(absPath); err != nil {
		errJSON(w, http.StatusForbidden, err.Error())
		return
	}

	newMTime, err := files.Write(req)
	if err != nil {
		status := http.StatusInternalServerError
		switch err {
		case files.ErrConflict:
			status = http.StatusConflict
		case files.ErrNotFound:
			status = http.StatusNotFound
		}
		errJSON(w, status, err.Error())
		return
	}
	_ = user // 仅用于 WS 路由；写权限不做用户级检查（见包注释）

	// 保存属于「自己的改动」，必须以新 mtime 重设 watcher 基线。
	// 否则下一轮轮询会把这次写入误判为外部修改，广播 file-changed，
	// 前端在用户继续编辑（dirty）时弹出「已被外部修改，是否重新加载？」。
	if h.Hub != nil {
		h.Hub.Watch(absPath, user.UID)
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mtime": newMTime})
}

// Unwatch POST /api/file/unwatch
// 关闭标签时释放 watcher 对该文件的监控。
// ReadFile 会为每个打开的文件注册 mtime 基线；若从不注销，watcher 的 map
// 会随会话时长单调增长（慢性内存泄漏）。
func (h *Handler) Unwatch(w http.ResponseWriter, r *http.Request) {
	user, ok := h.requireGatewayUser(r)
	if !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "请求体解析失败")
		return
	}
	absPath, err := files.CleanAndValidate(req.Path)
	if err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}

	// 仅释放「该用户自己打开过」的监控；unwatch 无副作用风险。
	if h.Hub != nil {
		h.Hub.Unwatch(absPath, user.UID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// logRequestDenied 记录被拒绝的请求（保留日志格式兼容历史排障习惯）。
var _ = log.Printf

// GetPrefs GET /api/prefs
// 返回当前网关用户的偏好 JSON。后端不解析字段（偏好结构由前端定义），
// 只回传原始 JSON 对象；缺失时返回 {}（前端据默认值初始化）。
func (h *Handler) GetPrefs(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireGatewayUser(r); !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}
	if h.Prefs == nil {
		errJSON(w, http.StatusServiceUnavailable, "偏好存储未启用")
		return
	}
	uid := gatewayUIDOrDev(r, h)
	data, err := h.Prefs.Get(uid)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 直接回传原始 JSON（已是合法对象），不再二次封装。
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// PutPrefs PUT /api/prefs
// 保存当前网关用户的偏好。请求体为偏好 JSON 对象，整体覆盖写回；
// 后端校验「合法 JSON 对象」后原子落盘，不解析具体字段。
func (h *Handler) PutPrefs(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireGatewayUser(r); !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}
	if h.Prefs == nil {
		errJSON(w, http.StatusServiceUnavailable, "偏好存储未启用")
		return
	}
	uid := gatewayUIDOrDev(r, h)
	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		errJSON(w, http.StatusBadRequest, "请求体解析失败：需合法 JSON")
		return
	}
	if err := h.Prefs.Set(uid, raw); err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "超过上限") || strings.Contains(err.Error(), "非法") || strings.Contains(err.Error(), "对象") {
			status = http.StatusBadRequest
		}
		errJSON(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// gatewayUIDOrDev 取网关用户 uid；dev 模式无网关身份时兜底 "0"。
func gatewayUIDOrDev(r *http.Request, h *Handler) string {
	if u, ok := gateway.FromRequest(r); ok {
		return u.UID
	}
	if h.DevAllowAll {
		return "0"
	}
	return ""
}
