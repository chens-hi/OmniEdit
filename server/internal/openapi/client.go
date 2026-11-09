// Package openapi 封装飞牛 fnOS「开放 API」的后端调用。
//
// 所有后端 API 统一通过 Unix Socket 调用：
//
//	POST /api/v1/trimapp
//	Unix Socket: /var/run/trim_open_gateway_apiscope.socket
//	Authorization: Bearer <token>
//
// token 由系统在调用应用脚本时注入环境变量 TRIM_API_TOKEN，
// 每次调用都应从当前进程环境变量读取，不要持久化或暴露给前端。
//
// 请求体: { reqId, req, appName, data }
// 响应体: { reqId, code, msg, data }   code==0 表示成功
package openapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

// 默认开放 API 网关 Socket 路径。
const DefaultSocketPath = "/var/run/trim_open_gateway_apiscope.socket"

// Client 是开放 API 的后端客户端。
type Client struct {
	httpClient *http.Client
	appName    string
	socketPath string
}

// New 创建开放 API 客户端。
// appName: 应用唯一标识（须与 manifest 的 appname 一致）。
func New(appName string) *Client {
	return NewWithSocket(appName, DefaultSocketPath)
}

// NewWithSocket 创建指定 Socket 路径的客户端（测试注入假网关用）。
func NewWithSocket(appName, socketPath string) *Client {
	c := &Client{
		appName:    appName,
		socketPath: socketPath,
	}
	c.httpClient = &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", c.socketPath)
			},
		},
	}
	return c
}

// token 从进程环境变量读取系统注入的 TRIM_API_TOKEN。
func token() (string, error) {
	t := os.Getenv("TRIM_API_TOKEN")
	if t == "" {
		return "", errors.New("TRIM_API_TOKEN 未设置：开放 API 仅可在应用脚本进程内调用")
	}
	return t, nil
}

// request 发起一次开放 API 调用。
func (c *Client) request(ctx context.Context, req string, data map[string]any, out any) error {
	tk, err := token()
	if err != nil {
		return err
	}

	body := map[string]any{
		"reqId":   strconv.FormatInt(time.Now().UnixNano(), 10),
		"req":     req,
		"appName": c.appName,
		"data":    data,
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("序列化请求失败: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost/api/v1/trimapp", bytes.NewReader(buf))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+tk)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("调用开放 API 失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("开放 API HTTP 状态码: %d", resp.StatusCode)
	}

	var envelope struct {
		Code int             `json:"code"`
		Msg  string          `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return fmt.Errorf("解析开放 API 响应失败: %w", err)
	}
	if envelope.Code != 0 {
		return fmt.Errorf("开放 API 业务错误 code=%d msg=%s", envelope.Code, envelope.Msg)
	}
	if out != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, out); err != nil {
			return fmt.Errorf("解析开放 API data 失败: %w", err)
		}
	}
	return nil
}

// ListUserAccessPaths 查询当前用户已授权给应用的**目录**列表。
// 官方 API（/api/authorization/user-access/）：
//
//	req:  trim.file.getUserAccessibleFolders
//	data: { uid: number }
//	响应: data: { paths: [...] }
//
// 注意：只返回目录授权；文件授权（pickUserFile/authorizeUserFile 选中的
// 文件）不在此列表中，以选择器返回值为准。
// （当前权限模型为 root 直读，此方法未被调用；保留备将来回退授权模式。）
func (c *Client) ListUserAccessPaths(ctx context.Context, uid string) ([]string, error) {
	uidNum, err := strconv.ParseInt(uid, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("uid 非数字: %q", uid)
	}
	var out json.RawMessage
	if err := c.request(ctx, "trim.file.getUserAccessibleFolders", map[string]any{"uid": uidNum}, &out); err != nil {
		return nil, err
	}
	return parsePaths(out)
}

// parsePaths 从授权列表响应中容错提取路径数组。
// 支持形态：["/a"] / {"paths":[...]} / {"data":[...]} / {"list":[...]} /
// {"items":[{"path":...}]} 等常见包装。
// 识别失败时记录原始响应（debug 校准字段用），返回错误由调用方拒绝。
func parsePaths(raw json.RawMessage) ([]string, error) {
	// 扁平字符串数组
	var arr []string
	if err := json.Unmarshal(raw, &arr); err == nil {
		return arr, nil
	}
	// 对象包装
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		log.Printf("[openapi] userAccess 响应非对象: %s", string(raw))
		return nil, fmt.Errorf("授权路径响应无法解析: %s", string(raw))
	}
	for _, k := range []string{"paths", "data", "list", "items", "files", "dirs", "result"} {
		v, ok := m[k]
		if !ok {
			continue
		}
		// 再降一层：数组
		var s []string
		if err := json.Unmarshal(v, &s); err == nil {
			return s, nil
		}
		// 对象数组：[{"path": "..."}]
		var objs []map[string]any
		if err := json.Unmarshal(v, &objs); err == nil {
			out := make([]string, 0, len(objs))
			for _, o := range objs {
				for _, key := range []string{"path", "value", "name", "dir"} {
					if sv, ok := o[key].(string); ok && sv != "" {
						out = append(out, sv)
						break
					}
				}
			}
			if len(out) > 0 {
				return out, nil
			}
		}
	}
	// 关键校准点：真机首跑若走到这里，日志里的原始 JSON 就是字段形状。
	log.Printf("[openapi] userAccess 响应字段无法识别（原样记录待校准）: %s", string(raw))
	return nil, fmt.Errorf("授权路径响应缺少可识别字段: %s", string(raw))
}

// ConvertPath 把内部路径（/vol1/...）转换成适合展示给用户的语义化路径。
// 官方 API（/api/authorization/path-convert/）：
//
//	req:  trim.file.convertPath
//	data: { path: string | string[], language: "zh-CN" }（language 必填）
//	响应: data: { status: 0, result: [{ path, semanticPath }] }
func (c *Client) ConvertPath(ctx context.Context, path string) (string, error) {
	lang := "zh-CN"
	if l := os.Getenv("TRIM_LANGUAGE"); l != "" {
		lang = l
	}
	var out struct {
		Status int `json:"status"`
		Result []struct {
			Path         string `json:"path"`
			SemanticPath string `json:"semanticPath"`
		} `json:"result"`
	}
	data := map[string]any{"path": path, "language": lang}
	if err := c.request(ctx, "trim.file.convertPath", data, &out); err != nil {
		return path, err
	}
	if out.Status != 0 || len(out.Result) == 0 {
		return path, fmt.Errorf("convertPath status=%d", out.Status)
	}
	return out.Result[0].SemanticPath, nil
}

// GetPlatformConfig 读取系统语言和系统版本。
// req: trim.system.getPlatformConfig
func (c *Client) GetPlatformConfig(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.request(ctx, "trim.system.getPlatformConfig", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}
