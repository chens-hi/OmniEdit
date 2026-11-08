# OmniEdit 构建与调试指南

本文说明如何在本地构建 OmniEdit，并打包为可安装到飞牛 fnOS 的 `.fpk` 应用。

> 架构与设计决策见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 前置依赖

| 工具 | 用途 | 说明 |
|------|------|------|
| **Go** ≥ 1.22 | 编译后端 | https://go.dev |
| **Node.js** + **pnpm** | 构建前端 | 推荐通过 corepack 启用 pnpm |
| **fnpack** | 打包 `.fpk` | 飞牛官方 CLI，见 https://developer.fnnas.com/docs/cli/fnpack/ |
| **appcenter-cli** | 安装到 NAS 测试 | 见 https://developer.fnnas.com/docs/cli/appcentercli/ |

---

## 运行单元测试

后端安全核心（路径穿越防护、授权目录校验、大文件阈值、搜索过滤、WebSocket 握手算法）有单元测试，**无需 NAS 即可本地验证**：

```powershell
cd server
go test ./...              # 运行全部测试
go test ./internal/files/ -v   # 详细输出
go test ./internal/files/ ./internal/ws/ -cover   # 查看覆盖率
```

覆盖重点：
- `files` 包：路径穿越/相对路径/授权目录边界、大文件阈值与只读截断、搜索跳过二进制与隐藏/依赖目录、mtime 冲突检测。
- `ws` 包：`computeAccept` 握手算法（用 RFC 6455 规范示例向量校验）。

---

## 目录速览

```
OmniEdit/
├── manifest          # 应用元数据
├── ui/               # 桌面入口 config + 图标
├── config/           # privilege / resource（api-scope）
├── cmd/              # 生命周期脚本（main 负责启停服务）
├── app/              # 构建产物输出（Go 二进制 + 前端 dist）
├── web/              # 前端源码（Vue3 + CodeMirror 6）
├── server/           # 后端源码（Go）
│   └── build.ps1     # 构建脚本
└── docs/
```

---

## 快速构建（当前平台 / 本地调试）

在 `server/` 下执行：

```powershell
pwsh ./build.ps1
```

脚本会：
1. 在 `web/` 执行 `pnpm build`，产物输出到 `app/dist`；
2. 编译 Go 后端到 `app/omniedit`（Windows 下为 `omniedit.exe`，仅本地调试用）。

---

## 交叉编译（发布用 / 覆盖 x86 + ARM）

```powershell
pwsh ./build.ps1 -AllArch
```

生成：
- `app/omniedit-amd64`
- `app/omniedit-arm64`

> 注意：飞牛设备为 Linux。发布包内需包含 **Linux** 二进制，不要用 Windows 调试产物。
> 具体打包策略（单二进制 vs 按架构分文件 + 启动脚本选择）待用 fnpack 实测确定，
> 详见 ARCHITECTURE.md 第 10 节风险项。

---

## 本地端到端调试（不装 NAS）

后端通过 **Unix Socket** 与飞牛统一网关通信。本地没有网关时，用两个开发参数即可跑通完整读写链路：

```powershell
# 1. 构建前端 + 后端
pwsh ./server/build.ps1

# 2. 启动后端（HTTP 调试模式）
cd server
go run . `
  --socket /tmp/omniedit.sock `
  --static ../app/dist `
  --http 127.0.0.1:8899 `
  --dev-allow-all `
  --dev-root D:\path\to\some\folder
```

| 参数 | 作用 |
|------|------|
| `--http 127.0.0.1:8899` | 额外监听 TCP 端口，浏览器/前端 dev server 直连（生产留空） |
| `--dev-allow-all` | 放行无网关身份的请求，并跳过用户级 ACL 校验（生产禁止） |
| `--dev-root <dir>` | 临时授权根目录，文件服务只允许访问该目录内文件（生产禁止） |

**仅限本地开发，生产环境禁止开启这三个参数。** 生产环境授权目录由开放 API 查询后注入，用户级 ACL 必须校验。

验证链路（以授权目录内某个文件为例）：

```powershell
# 读取
Invoke-WebRequest "http://127.0.0.1:8899/app/omniedit/api/file/read?path=<文件绝对路径>"
# 保存（带 baseMtime 做冲突检测，外部改动过会返回 409）
Invoke-WebRequest "http://127.0.0.1:8899/app/omniedit/api/file/write" -Method Post -Body '{"path":"<文件>","content":"...","baseMtime":"<读到的 mtime>"}' -ContentType "application/json"
```

前端开发热更：

```powershell
cd web
pnpm dev
```

Vite 已配置把 `/app/omniedit/api` 代理到本地后端（默认 `http://127.0.0.1:8899`，
可用环境变量 `OMNIEDIT_DEV_BACKEND` 覆盖）。

---

## 前端代码分割 / Code Splitting

为契合「轻量、快启动」设计目标（NAS 低配硬件首屏更快），Vite 通过 `manualChunks`
把体积大、更新少的核心依赖拆成独立 chunk：

| chunk | 内容 | 作用 |
|-------|------|------|
| `codemirror` | CodeMirror 6 内核 + 语言包 | 编辑器核心，改动少、缓存命中高 |
| `vue` | Vue 3 + Pinia | 框架运行时 |
| `markdown` | marked + DOMPurify | Markdown 预览 |
| `fnos-sdk` | @trimjs/web-app | fnOS 开放能力 SDK |
| `vendor` | 其余 node_modules | 通用第三方 |
| `index` | 应用自身代码 | 改动最频繁，体积最小 |

效果：应用代码从单文件 ~965KB 降到 ~15KB，其余依赖独立缓存——改业务代码时
vendor chunk 命中缓存，不必重新下载。

> 后端 `spaHandler` 对存在的静态文件用 `http.ServeFile` **按本地路径精确提供**。
> 不能用 `http.FileServer.ServeHTTP`——它基于原始 URL 路径（含网关前缀
> `/app/omniedit`）查找，会把前缀拼进本地路径导致 404 / 错误 Content-Type。

---

## 打包为 .fpk

```powershell
pwsh ./server/build.ps1 -AllArch -Pack
```

`-Pack` 会在构建后调用 `fnpack` 生成 `.fpk` 包。

安装到测试机：

```powershell
appcenter-cli install ./OmniEdit.fpk
```

---

## 在 NAS 上验证

1. 应用中心打开 **OmniEdit** → 应显示空白编辑器（M0 骨架）。
2. 文件管理器右键 `.md` / `.json` 等文件 → 选择 OmniEdit → 应能打开并编辑保存。
3. 检查后端日志：`${TRIM_PKGVAR}/omniedit.log`。

> 当前为 **M0 骨架**：授权目录获取、用户 ACL 校验等开放 API 联调需在真实 NAS 环境完成，
> 见 ARCHITECTURE.md 第 9 节里程碑。

---

## 常见问题

**Q: 前端资源 404？**
A: Vite `base` 必须是 `/app/omniedit/`（与 `ui/config` 的 `gatewayPrefix` 一致）。

**Q: 后端起不来、socket 连不上？**
A: 确认 `cmd/main` 用 `${TRIM_APPDEST}` 定位二进制与 socket，且 `app.sock` 权限为 `0666`。

**Q: go build 在 Linux 报错？**
A: 确认 `CGO_ENABLED=0` 且针对 `linux/amd64` 或 `linux/arm64` 交叉编译。
