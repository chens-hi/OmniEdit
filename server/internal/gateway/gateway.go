// Package gateway 解析飞牛统一网关转发过来的可信用户身份 Header。
//
// 统一网关在校验 NAS 用户会话后，会通过以下 Header 把用户上下文转发给应用：
//
//	X-Trim-Userid   当前用户 UID
//	X-Trim-Isadmin  当前用户是否为管理员 ("true"/"false")
//	X-Trim-Username 当前用户名
//
// 安全规则：这些值可作为「网关提供的可信身份上下文」，但应用仍需执行自己的业务鉴权。
// 绝不要信任客户端请求体/查询参数中传入的 userId。
package gateway

import "net/http"

// User 表示由统一网关转发的当前登录用户身份。
type User struct {
	UID      string
	Username string
	IsAdmin  bool
}

// FromRequest 从请求 Header 提取网关用户身份。
// 若请求未经过统一网关（缺少 X-Trim-Userid），返回 ok=false，
// 调用方应拒绝该请求（避免未鉴权访问）。
func FromRequest(r *http.Request) (User, bool) {
	uid := r.Header.Get("X-Trim-Userid")
	if uid == "" {
		return User{}, false
	}
	return User{
		UID:      uid,
		Username: r.Header.Get("X-Trim-Username"),
		IsAdmin:  r.Header.Get("X-Trim-Isadmin") == "true",
	}, true
}
