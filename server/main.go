// OmniEdit 后端服务入口。
//
// 监听飞牛统一网关转发的 Unix Socket，对外提供：
//   - 前端静态资源（{prefix}/）
//   - 文件读写 API（{prefix}/api/*）
//
// 由 cmd/main 以下列方式拉起：
//
//	omniedit --socket ${TRIM_APPDEST}/app.sock --static ${TRIM_APPDEST}/dist
package main

import (
	"context"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"omniedit/server/internal/api"
	"omniedit/server/internal/files"
	"omniedit/server/internal/openapi"
	"omniedit/server/internal/prefs"
	"omniedit/server/internal/watcher"
)

func main() {
	var (
		socketPath  = flag.String("socket", "app.sock", "统一网关 Unix Socket 路径")
		staticDir   = flag.String("static", "dist", "前端构建产物目录")
		prefix      = flag.String("prefix", "/app/omniedit", "统一网关前缀（gatewayPrefix）")
		appName     = flag.String("app-name", "omniedit", "应用名（须与 manifest 的 appname 一致）")
		devAllowAll = flag.Bool("dev-allow-all", false, "开发调试：放行无网关身份的请求（生产禁止开启）")
		httpAddr    = flag.String("http", "", "开发调试：额外监听的 HTTP 地址（如 127.0.0.1:8899），便于浏览器直连（生产留空）")
		devRoot     = flag.String("dev-root", "", "开发调试：临时授权的根目录（配合 --dev-allow-all），使文件服务可访问该目录（生产禁止开启）")
		confDir     = flag.String("conf-dir", os.Getenv("TRIM_PKGETC"), "偏好配置目录（生产由 TRIM_PKGETC 注入；开发调试可覆盖，如 ./data）")
	)
	flag.Parse()

	// 标准化前缀：确保以 / 开头、不以 / 结尾。
	gwPrefix := strings.TrimSuffix(*prefix, "/")
	if !strings.HasPrefix(gwPrefix, "/") {
		gwPrefix = "/" + gwPrefix
	}

	log.Printf("OmniEdit 后端启动: socket=%s static=%s prefix=%s", *socketPath, *staticDir, gwPrefix)
	// 运行身份诊断（privilege 文档「运行用户检查」）：真机上确认 root 模式
	// 是否生效——uid/euid 非 0 即说明 run-as=root 未被应用，权限模型需复查。
	log.Printf("[diag] 运行身份: uid=%d euid=%d TRIM_RUN_USERNAME=%q TRIM_USERNAME=%q",
		os.Getuid(), os.Geteuid(), os.Getenv("TRIM_RUN_USERNAME"), os.Getenv("TRIM_USERNAME"))

	// 开放 API 客户端（通过系统 Unix Socket 调用）。
	openClient := openapi.New(*appName)

	// 文件服务：生产由开放 API 查询授权目录后注入（默认拒绝）；
	// 开发调试可通过 --dev-root 注入临时授权根目录，便于本机端到端联调。
	fileSvc := newFileService(openClient)
	if *devRoot != "" {
		if abs, err := filepath.Abs(*devRoot); err == nil {
			fileSvc.SetAuthorizedRoots([]string{abs})
			log.Printf("[dev] 临时授权根目录: %s", abs)
		} else {
			log.Fatalf("[dev] --dev-root 无效: %v", err)
		}
	}

	// 用户偏好存储：落盘 ${TRIM_PKGETC}/prefs.<uid>.json（无 uid 回退 prefs.json）。
	// 生产由 TRIM_PKGETC 注入；开发调试可用 --conf-dir 覆盖，缺省落到 ./data 便于本机联调。
	prefsDir := *confDir
	if prefsDir == "" {
		prefsDir = "./data"
	}
	prefsSvc := prefs.New(prefsDir)
	if err := os.MkdirAll(prefsDir, 0o755); err != nil {
		log.Fatalf("创建偏好配置目录失败: %v", err)
	}
	log.Printf("[prefs] 配置目录: %s", prefsDir)

	// 日志落盘：${prefsDir}/logs/omniedit-YYYY-MM-DD.log
	logFile := setupLogFile(prefsDir)
	if logFile != nil {
		log.SetOutput(io.MultiWriter(os.Stderr, logFile))
		defer logFile.Close()
	}

	h := &api.Handler{
		FileSvc:     fileSvc,
		OpenAPI:     openClient,
		Prefix:      gwPrefix,
		DevAllowAll: *devAllowAll,
		Prefs:       prefsSvc,
	}

	// 文件变更推送：轮询 watcher + WebSocket Hub。
	// 打开文件时注册监控，外部修改后推送给所有连接的客户端。
	fileWatcher := watcher.New(2 * time.Second)
	h.Hub = api.NewHub(fileWatcher)
	defer fileWatcher.Stop()

	mux := buildMux(gwPrefix, *staticDir, h)

	// 监听 Unix Socket（统一网关会把请求转发到这里）。
	// 确保父目录存在，并清理可能残留的 socket 文件。
	if err := os.MkdirAll(filepath.Dir(*socketPath), 0o755); err != nil {
		log.Fatalf("创建 socket 目录失败: %v", err)
	}
	_ = os.Remove(*socketPath)

	ln, err := net.Listen("unix", *socketPath)
	if err != nil {
		log.Fatalf("监听 Unix Socket 失败: %v", err)
	}
	// 让网关/应用用户可访问该 socket。
	_ = os.Chmod(*socketPath, 0o666)

	srv := &http.Server{Handler: mux}

	// 开发调试：额外监听 HTTP 地址，便于浏览器/前端 dev server 直连（生产留空不启用）。
	// 复用同一个 mux（handler），但使用独立的 http.Server 绑定 TCP 端口。
	if *httpAddr != "" {
		devSrv := &http.Server{Addr: *httpAddr, Handler: mux}
		go func() {
			log.Printf("[dev] HTTP 调试监听: http://%s%s/", *httpAddr, gwPrefix)
			if err := devSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("[dev] HTTP 监听失败: %v", err)
			}
		}()
	}

	// 优雅退出：收到信号后关闭服务并清理 socket。
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Println("收到退出信号，正在关闭...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("HTTP 服务异常退出: %v", err)
	}
	_ = os.Remove(*socketPath)
	log.Println("OmniEdit 后端已退出")
}

// newFileService 创建文件服务。
// 首版以「默认拒绝」初始化（未配置授权目录），M1 阶段接入开放 API 的
// 授权目录查询后，通过 SetAuthorizedRoots 动态注入可访问目录。
func newFileService(_ *openapi.Client) *files.Service {
	return files.NewService(nil)
}

// buildMux 装配路由。
func buildMux(prefix, staticDir string, h *api.Handler) http.Handler {
	mux := http.NewServeMux()

	// API 路由：{prefix}/api/*
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("/api/health", h.Health)
	apiMux.HandleFunc("/api/ws", h.WSHandler)
	apiMux.HandleFunc("/api/file/read", h.ReadFile)
	apiMux.HandleFunc("/api/file/raw", h.RawFile)
	apiMux.HandleFunc("/api/file/write", h.WriteFile)
	apiMux.HandleFunc("/api/file/unwatch", h.Unwatch)
	apiMux.HandleFunc("/api/prefs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			h.GetPrefs(w, r)
		case http.MethodPut, http.MethodPost:
			h.PutPrefs(w, r)
		default:
			w.Header().Set("Allow", "GET, PUT")
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusMethodNotAllowed)
			_, _ = w.Write([]byte(`{"ok":false,"error":"方法不允许"}`))
		}
	})
	mux.Handle(prefix+"/api/", http.StripPrefix(prefix, apiMux))

	// 静态资源 + SPA 回退：{prefix}/
	mux.Handle(prefix+"/", spaHandler(prefix, staticDir))

	// 根路径重定向到应用前缀（便于本地直接访问）。
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, prefix+"/", http.StatusFound)
			return
		}
		http.NotFound(w, r)
	})

	return logRequests(mux)
}

// noCacheHeader 让浏览器不缓存 index.html。
// 原因：index.html 引用带内容指纹的 assets（index-<hash>.js）。assets 可长缓存，
// 但 index.html 本身若被 iframe 缓存，发版后浏览器仍引用旧指纹——用户升级后
// 表现为"修好的 bug 还在"（v0.1.6→0.1.7 实测踩坑）。
func noCacheHeader(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
}

// spaHandler 对未命中的非资源请求回退到 index.html（前端路由）。
func spaHandler(prefix, staticDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, prefix)
		if rel == "" || rel == "/" {
			noCacheHeader(w)
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}
		full := filepath.Join(staticDir, filepath.Clean("/"+rel))
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			// 直接按本地路径提供文件。不能用 fs.ServeHTTP(w, r)——它基于原始
			// URL 路径（含统一网关前缀 /app/omniedit）查找，会把前缀拼进本地
			// 路径导致 404。http.ServeFile 按 full 精确提供，并正确处理
			// Content-Type / 缓存头 / Range。
			// 带指纹的 assets 内容不变即文件名不变，让 ServeFile 走默认
			// 协商缓存（ETag/Last-Modified）即可，无需显式 Cache-Control。
			http.ServeFile(w, r, full)
			return
		}
		// 其余回退到 index.html，交由前端路由处理（同样 no-cache）。
		noCacheHeader(w)
		http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
	})
}

// logRequests 简单请求日志。
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		log.Printf("%s %s", r.Method, r.URL.Path)
	})
}

// logMaxAge 日志文件保留天数，超过自动清理。
const logMaxAge = 7 * 24 * time.Hour

// setupLogFile 在 logBase/logs/ 下创建当天的日志文件（追加模式），
// 并清理超过 logMaxAge 的旧日志。返回打开的文件（调用方负责 defer Close）；
// 目录创建或文件打开失败时返回 nil（日志仅输出 stderr，不阻塞启动）。
func setupLogFile(logBase string) *os.File {
	logDir := filepath.Join(logBase, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		log.Printf("[log] 创建日志目录失败: %v", err)
		return nil
	}

	// 清理过期日志：遍历目录，删除文件名匹配 omniedit-*.log 且修改时间超限的文件。
	entries, err := os.ReadDir(logDir)
	if err == nil {
		cutoff := time.Now().Add(-logMaxAge)
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") {
				continue
			}
			info, err := e.Info()
			if err != nil || info.ModTime().After(cutoff) {
				continue
			}
			if err := os.Remove(filepath.Join(logDir, e.Name())); err == nil {
				log.Printf("[log] 清理过期日志: %s", e.Name())
			}
		}
	}

	// 打开当天日志文件（追加模式，不存在则创建）
	name := "omniedit-" + time.Now().Format("2006-01-02") + ".log"
	f, err := os.OpenFile(filepath.Join(logDir, name),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Printf("[log] 打开日志文件失败: %v", err)
		return nil
	}
	return f
}
