package gateway

import (
	"net/http"
	"testing"
)

func reqWithHeaders(headers map[string]string) *http.Request {
	r, _ := http.NewRequest(http.MethodGet, "/app/omniedit/", nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestFromRequest_ValidAdmin(t *testing.T) {
	r := reqWithHeaders(map[string]string{
		"X-Trim-Userid":   "1000",
		"X-Trim-Isadmin":  "true",
		"X-Trim-Username": "admin",
	})
	u, ok := FromRequest(r)
	if !ok {
		t.Fatal("带合法网关 Header 的请求应返回 ok=true")
	}
	if u.UID != "1000" {
		t.Errorf("UID = %q，期望 %q", u.UID, "1000")
	}
	if !u.IsAdmin {
		t.Error("IsAdmin 应为 true")
	}
	if u.Username != "admin" {
		t.Errorf("Username = %q，期望 %q", u.Username, "admin")
	}
}

func TestFromRequest_NonAdmin(t *testing.T) {
	r := reqWithHeaders(map[string]string{
		"X-Trim-Userid":   "1001",
		"X-Trim-Isadmin":  "false",
		"X-Trim-Username": "user",
	})
	u, ok := FromRequest(r)
	if !ok {
		t.Fatal("带合法网关 Header 的请求应返回 ok=true")
	}
	if u.IsAdmin {
		t.Error("Isadmin=false 时 IsAdmin 应为 false")
	}
}

func TestFromRequest_MissingUID(t *testing.T) {
	// 缺少 X-Trim-Userid（如未经统一网关）应返回 ok=false，避免未鉴权访问。
	r := reqWithHeaders(map[string]string{
		"X-Trim-Username": "someone",
	})
	if _, ok := FromRequest(r); ok {
		t.Error("缺少 X-Trim-Userid 应返回 ok=false")
	}
}

func TestFromRequest_NoHeaders(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	if _, ok := FromRequest(r); ok {
		t.Error("无网关 Header 应返回 ok=false")
	}
}

func TestFromRequest_EmptyUID(t *testing.T) {
	// X-Trim-Userid 为空串等同于缺失，应拒绝。
	r := reqWithHeaders(map[string]string{
		"X-Trim-Userid": "",
	})
	if _, ok := FromRequest(r); ok {
		t.Error("X-Trim-Userid 为空应返回 ok=false")
	}
}
