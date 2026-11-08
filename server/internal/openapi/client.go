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
	c := &Client{
		appName:    appName,
		socketPath: DefaultSocketPath,
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

// CheckUserAcl 检查指定用户对某路径是否具备给定权限。
// req: trim.file.userAcl
// data 入参/出参字段需以官方文档为准（首版按占位实现，待实测校正）。
func (c *Client) CheckUserAcl(ctx context.Context, uid, path, perm string) (bool, error) {
	var out struct {
		Allowed bool `json:"allowed"`
	}
	data := map[string]any{
		"userId": uid,
		"path":   path,
		"perm":   perm, // e.g. read | write | delete
	}
	if err := c.request(ctx, "trim.file.userAcl", data, &out); err != nil {
		return false, err
	}
	return out.Allowed, nil
}

// ListUserAccessPaths 查询当前用户已授权给应用的目录/文件列表。
// req: trim.file.userAccess
func (c *Client) ListUserAccessPaths(ctx context.Context, uid string) ([]string, error) {
	var out struct {
		Paths []string `json:"paths"`
	}
	data := map[string]any{"userId": uid}
	if err := c.request(ctx, "trim.file.userAccess", data, &out); err != nil {
		return nil, err
	}
	return out.Paths, nil
}

// ConvertPath 把内部路径（/vol1/...）转换成适合展示给用户的路径。
// req: trim.file.path
func (c *Client) ConvertPath(ctx context.Context, path string) (string, error) {
	var out struct {
		DisplayPath string `json:"displayPath"`
	}
	data := map[string]any{"path": path}
	if err := c.request(ctx, "trim.file.path", data, &out); err != nil {
		return path, err
	}
	return out.DisplayPath, nil
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
