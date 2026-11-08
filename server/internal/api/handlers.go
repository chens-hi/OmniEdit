// Package api 提供 OmniEdit 的 HTTP API（挂载在统一网关前缀下）。
//
// 路由（完整对外路径为 {gatewayPrefix}/api/...，见 server.go）：
//
//	GET  /api/health          健康检查
//	GET  /api/dir/roots       已授权根目录列表
//	GET  /api/dir/list        列出某目录直接子项（?path=...）
//	GET  /api/search          授权目录内搜索文件内容（?path=...&q=...）
//	GET  /api/file/read       读取文本文件（?path=...）
//	POST /api/file/write      保存文本文件（JSON body）
//
// 安全：每个文件接口都要求经过统一网关（存在网关用户身份 Header），
// 并对路径做穿越校验 + 授权目录校验，写接口额外校验用户写权限。
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
)

// Handler 聚合依赖。
type Handler struct {
	FileSvc  *files.Service
	OpenAPI  *openapi.Client
	Prefix   string
	// Hub 管理文件变更推送的 WebSocket 连接（可为 nil，此时 WS 接口不可用）。
	Hub *Hub
	// DevAllowAll 仅用于本地开发调试（无网关/无授权环境下放行）。
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

// requireGatewayUser 确保请求经过统一网关并携带可信用户身份。
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

// Health 健康检查。
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "app": "omniedit"})
}

// ListRoots GET /api/dir/roots
// ListRoots GET /api/dir/roots
// 返回当前已授权的根目录列表，供前端目录树作为浏览起点。
// 生产环境：由开放 API 查询用户/共享授权路径；
// 开发环境：由 --dev-root 注入。
func (h *Handler) ListRoots(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireGatewayUser(r); !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}
	roots := h.FileSvc.AuthorizedRoots()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "roots": roots})
}

// ListDir GET /api/dir/list?path=...
// 列出授权目录内某目录的直接子项。
func (h *Handler) ListDir(w http.ResponseWriter, r *http.Request) {
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
	if !h.FileSvc.IsPathAllowed(absPath) {
		errJSON(w, http.StatusForbidden, files.ErrNotAuthorized.Error())
		return
	}

	entries, err := files.ListDir(absPath)
	if err != nil {
		status := http.StatusInternalServerError
		if err == files.ErrNotFound {
			status = http.StatusNotFound
		}
		errJSON(w, status, err.Error())
		return
	}

	// 展示用路径转换（尽力而为）。
	displayPath := absPath
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if dp, err := h.OpenAPI.ConvertPath(ctx, absPath); err == nil {
		displayPath = dp
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": absPath, "displayPath": displayPath, "entries": entries})
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
	if !h.FileSvc.IsPathAllowed(absPath) {
		errJSON(w, http.StatusForbidden, files.ErrNotAuthorized.Error())
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

	// 注册文件监控：外部修改后通过 WebSocket 推送给客户端。
	if h.Hub != nil && !meta.TooLarge {
		h.Hub.Watch(absPath)
	}
	_ = user // 用户身份可用于后续按用户过滤，此处保留引用。

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "file": meta})
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
	if !h.FileSvc.IsPathAllowed(absPath) {
		errJSON(w, http.StatusForbidden, files.ErrNotAuthorized.Error())
		return
	}

	// 用户级写权限校验（应用用户 ACL ≠ 当前用户权限）。
	// 开发调试模式（--dev-allow-all）跳过：本地无开放 API socket，无法校验，
	// 由授权目录（--dev-root）+ 路径校验兜底；生产环境必须执行此校验。
	if !h.DevAllowAll {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		allowed, err := h.OpenAPI.CheckUserAcl(ctx, user.UID, absPath, "write")
		if err != nil {
			// 查询失败时保守处理：默认拒绝，避免越权写入。
			log.Printf("userAcl 校验失败，默认拒绝: %v", err)
			errJSON(w, http.StatusForbidden, "无法校验写权限，已拒绝保存")
			return
		}
		if !allowed {
			errJSON(w, http.StatusForbidden, "当前用户对该路径无写权限")
			return
		}
	}

	req.Path = absPath
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mtime": newMTime})
}

// Search GET /api/search?path=...&q=...
// 在授权目录（或其子目录）内搜索文件内容。
// 出于安全考虑，搜索起点必须落在已授权目录内。
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireGatewayUser(r); !ok {
		errJSON(w, http.StatusUnauthorized, "未授权：缺少网关用户身份")
		return
	}

	rawPath := r.URL.Query().Get("path")
	query := r.URL.Query().Get("q")
	if strings.TrimSpace(query) == "" {
		errJSON(w, http.StatusBadRequest, "搜索关键词不能为空")
		return
	}

	absPath, err := files.CleanAndValidate(rawPath)
	if err != nil {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if !h.FileSvc.IsPathAllowed(absPath) {
		errJSON(w, http.StatusForbidden, files.ErrNotAuthorized.Error())
		return
	}

	result, err := files.SearchInDir(absPath, query)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}
