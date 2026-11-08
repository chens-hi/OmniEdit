<div align="center">

# OmniEdit 架构设计 / Architecture

**飞牛原生 · 全格式文件编辑器 · 技术架构 v0.1**

</div>

> 本文是 OmniEdit 的技术架构设计文档，基于飞牛官方「飞牛应用开放平台」公开规范编写。
> 关键机制均来自官方文档（developer.fnnas.com），凡属推断或需实测确认的部分，均已在文中明确标注。

---

## 目录 / TOC

1. [总体架构](#1-总体架构)
2. [前端技术栈选型](#2-前端技术栈选型)
3. [后端服务选型](#3-后端服务选型)
4. [与 fnOS 开放平台的集成](#4-与-fnos-开放平台的集成)
5. [应用包结构](#5-应用包结构)
6. [核心数据流](#6-核心数据流)
7. [安全模型](#7-安全模型)
8. [打包与分发](#8-打包与分发)
9. [里程碑规划](#9-里程碑规划)
10. [风险与待确认项](#10-风险与待确认项)

---

## 1. 总体架构

OmniEdit 是一个 **fnOS 原生应用**，本质上是「**运行在 NAS 上的常驻后端服务 + 运行在飞牛桌面（iframe）里的 Web 前端**」。应用通过 fnOS 的**统一网关**对外暴露，复用 NAS 登录态，前端与后端同域通信。

```
┌──────────────────────────────────────────────────────────────┐
│                        飞牛 fnOS 宿主                          │
│                                                                │
│  ┌────────────────┐         ┌──────────────────────────────┐  │
│  │  飞牛桌面窗口   │  iframe │   OmniEdit 前端 (SPA)         │  │
│  │  (应用卡片/    │────────▶│   Vue 3 + CodeMirror 6        │  │
│  │   右键打开文件)│         │   + TrimApp JS SDK            │  │
│  └────────────────┘         └───────────────┬──────────────┘  │
│                                             │ HTTP / WebSocket │
│                                    同域相对路径                │
│                                             ▼                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │              统一网关  /app/omniedit                       │ │
│  │   · 校验 NAS 用户会话（登录态）                            │ │
│  │   · 转发用户身份 Header：                                  │ │
│  │     X-Trim-Userid / X-Trim-Isadmin / X-Trim-Username      │ │
│  │   · 转发到应用 Unix Socket                                 │ │
│  └───────────────────────────────┬──────────────────────────┘ │
│                                  │ Unix Socket (app.sock)      │
│                                  ▼                             │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │            OmniEdit 后端服务 (Go, 常驻进程)                │ │
│  │   · 静态资源服务（前端构建产物）                            │ │
│  │   · 文件读写 API（/app/omniedit/api/*）                     │ │
│  │   · WebSocket 推送（/api/ws）：轮询已打开文件 mtime，       │ │
│  │     外部变更后推送 file-changed 事件给前端                  │ │
│  │   · 监听 ${TRIM_APPDEST}/app.sock                          │ │
│  │   · 调用开放 API（走 apiscope Unix Socket + Token）         │ │
│  └───────────────┬────────────────────────────┬─────────────┘ │
│                  │                            │               │
│                  ▼                            ▼               │
│        ┌──────────────────┐        ┌────────────────────────┐ │
│        │  NAS 文件系统     │        │ fnOS 开放 API 网关      │ │
│        │  /vol*/...       │        │ /var/run/              │ │
│        │  (授权目录内读写) │        │ trim_open_gateway_     │ │
│        │  ▲ 轮询 mtime    │        │ apiscope.socket        │ │
│        └──────────────────┘        │ (授权查询/ACL/路径转换) │ │
│                                    └────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 设计原则

| 原则 | 落实方式 |
|------|----------|
| **原生 Native** | 走 fnOS 应用包规范（manifest + 生命周期脚本 + 统一网关 + JS SDK），非 Docker 套壳、非独立端口服务 |
| **轻量 Lightweight** | Go 单二进制后端（低内存、快启动）+ CodeMirror 6（按需加载语言包），适配 NAS 硬件 |
| **本地优先 Local-first** | 文件只在 NAS 上读写，除系统开放 API 外无任何外联 |
| **安全边界清晰** | 严格遵循 fnOS 授权模型：应用先获授权目录，再按当前用户 ACL 决定读写 |

---

## 2. 前端技术栈选型

> 用户决策：前端由我定。以下是选型结论与理由。

| 维度 | 选型 | 理由 |
|------|------|------|
| 框架 | **Vue 3 + Vite + TypeScript** | 生态成熟、体积小、启动快；`<script setup>` 上手快，适合编辑器这类强交互应用 |
| 编辑器内核 | **CodeMirror 6** | 模块化按需加载、对大文件友好、内存占用低于 Monaco；Markdown/JSON/C#/Go/HTML 高亮与补全均有官方或社区包 |
| fnOS 集成 | **@trimjs/web-app**（官方 JS SDK） | 打开授权/文件选择器、读取主题与语言、监听主题切换 |
| 状态管理 | **Pinia** | 轻量，管理多标签、编辑器实例、授权路径等状态 |
| 样式 | **原生 CSS + CSS 变量** | 用 CSS 变量对接 fnOS 主题（浅色/深色），减少依赖 |

### 为什么是 CodeMirror 6 而不是 Monaco

| 对比项 | CodeMirror 6 ✅ | Monaco Editor |
|--------|-----------------|---------------|
| 体积 | 核心极小，语言包按需 | 较大（含完整 VS Code 内核能力） |
| 启动速度 | 快 | 较慢 |
| 大文件 | 优化好 | 占用高 |
| NAS 低配适配 | ✅ 更合适 | 一般 |
| C#/Go 高亮 | 社区包（`@codemirror/lang-cpp`/`@codemirror/lang-go` 等） | 内置 |

OmniEdit 定位是「轻量、快启动、适配 NAS 硬件」，CodeMirror 6 更契合。Monaco 的强项（重构、IntelliSense）对 NAS 场景非刚需。

### 首版支持的文件类型（纯文本/代码/标记）

| 类型 | 扩展名 | 处理方式 |
|------|--------|----------|
| 纯文本 | `txt` `log` `conf` `ini` `env` `yml` `yaml` `toml` | 纯文本编辑 |
| JSON | `json` `jsonc` | 高亮 + 格式化 + 校验 |
| Markdown | `md` `markdown` | 编辑 + 分屏预览 |
| HTML | `html` `htm` `svg` `xml` | 高亮 +（可选）预览 |
| C# | `cs` | 语法高亮 |
| Go | `go` | 语法高亮 |
| 其它代码 | `js` `ts` `css` `py` `sh` `sql` 等 | 语法高亮 |

> Office（docx/xlsx/pptx）**首版不做**，见 [里程碑](#9-里程碑规划) 与 [风险](#10-风险与待确认项)。

---

## 3. 后端服务选型

| 维度 | 选型 | 理由 |
|------|------|------|
| 语言 | **Go** | 编译为**单个静态二进制**，无运行时依赖，内存占用低、启动快，契合 NAS 资源约束 |
| Web 框架 | **标准库 `net/http`**（或轻量路由如 `chi`） | 需求简单（静态文件 + 少量 API），避免重依赖 |
| Unix Socket | `net.Listen("unix", ...)` | 监听统一网关要求的 `app.sock` |
| 开放 API 调用 | `http.Client` + `DialContext` 指定 Unix Socket | 通过 `/var/run/trim_open_gateway_apiscope.socket` 调用 |
| 构建 | 交叉编译 `GOOS=linux`，`GOARCH=amd64`/`arm64` | 覆盖 fnOS 的 x86 / ARM 设备 |

### 后端职责

1. **静态资源服务**：托管前端构建产物（`ui/dist`），挂载在网关前缀 `/app/omniedit` 下。
2. **文件 API**：`/app/omniedit/api/*`
   - 读取文件内容（文本/代码）
   - 保存文件内容（含冲突检测）
   - 列目录（配合授权路径）
   - 格式化（JSON 等，前端可做，复杂格式后续下沉后端）
3. **身份与权限**：
   - 从网关 Header（`X-Trim-Userid` 等）获取可信用户身份。
   - 调用开放 API 校验授权路径、检查当前用户对该路径的 ACL。
4. **开放 API 客户端**：封装「授权查询 / 文件 ACL / 路径转换 / 平台配置」调用。

> 备选方案：Node.js（`install_dep_apps=nodejs_v22`，官方有运行时包）。但 Go 单二进制在「轻量、快启动、低占用」上更优，且不依赖 NAS 上安装额外运行时。**此为选型决策，可复议。**

---

## 4. 与 fnOS 开放平台的集成

OmniEdit 是一款**文件编辑器**，深度依赖 fnOS 的「授权与文件」能力。

### 4.1 Manifest 关键配置

```ini
appname=omniedit
version=0.1.0
display_name=OmniEdit
desc=飞牛原生全格式文件编辑器
source=thirdparty
platform=all
os_min_version=1.2.0
micro_app=true            # 必需：启用 JS SDK（微应用环境）
desktop_uidir=ui
desktop_applaunchname=omniedit.main
ctl_stop=true             # 有常驻后端服务，允许用户启停
checkport=false           # 走统一网关，无独立固定端口
# disable_authorization_path=false   # 应用设置页显示授权目录（按需）
```

### 4.2 统一网关入口（`ui/config`）

```json
{
  ".url": {
    "omniedit.main": {
      "title": "OmniEdit",
      "icon": "images/icon_{0}.png",
      "type": "iframe",
      "protocol": "",
      "gatewayPrefix": "/app/omniedit",
      "gatewaySocket": "app.sock",
      "url": "/app/omniedit",
      "allUsers": true
    },
    "omniedit.editor": {
      "title": "OmniEdit 编辑",
      "icon": "images/editor_{0}.png",
      "type": "iframe",
      "protocol": "",
      "gatewayPrefix": "/app/omniedit",
      "gatewaySocket": "app.sock",
      "url": "/app/omniedit",
      "allUsers": true,
      "fileTypes": ["txt","md","json","html","htm","xml","svg","cs","go","yml","yaml","toml","ini","conf","log","js","ts","css","py","sh","sql"],
      "noDisplay": true
    }
  }
}
```

- `omniedit.main`：桌面图标，打开编辑器主界面。
- `omniedit.editor`：**文件打开方式**，注册在文件管理器右键菜单，`noDisplay=true` 不显示桌面图标。用户打开文件时，fnOS 会在 URL 追加 `path` 查询参数。

### 4.3 开放 API Scope 声明（`config/resource`）

```json
{
  "api-scope": [
    "trim.file.userAccess",
    "trim.file.sharedAccess",
    "trim.file.userAcl",
    "trim.file.path",
    "trim.system.getPlatformConfig"
  ]
}
```

| Scope | 用途 |
|-------|------|
| `trim.file.userAccess` | 当前用户选择并授权自己的目录/文件 |
| `trim.file.sharedAccess` | 管理员为应用授权共享目录（可选，用于固定工作目录） |
| `trim.file.userAcl` | 检查当前用户对某路径是否可读/可写 |
| `trim.file.path` | 把 `/vol1/...` 转成用户可读路径用于展示 |
| `trim.system.getPlatformConfig` | 读取系统语言/版本，做 i18n |

> 只声明实际用到的 Scope。

### 4.4 后端调用开放 API

```
POST /api/v1/trimapp
Unix Socket: /var/run/trim_open_gateway_apiscope.socket
Authorization: Bearer ${TRIM_API_TOKEN}   # 系统注入到 cmd/main 进程环境变量
```

- `TRIM_API_TOKEN` 每次从进程环境变量读取，**不持久化、不暴露给前端**。
- 请求体：`{ reqId, req, appName, data }`；响应：`{ reqId, code, msg, data }`，`code===0` 为成功。

### 4.5 主题 / 语言跟随宿主

- 前端通过 JS SDK 读取平台配置、监听主题/语言变化（`$on` 仅 Web 宿主环境可用）。
- 用 CSS 变量映射 fnOS 浅色/深色主题，保证观感原生。

---

## 5. 应用包结构

```
OmniEdit/
├── manifest                    # 应用元数据（无扩展名）
├── ui/                         # 桌面 UI 目录（desktop_uidir=ui）
│   ├── config                  # 入口定义（桌面图标 + 文件打开方式）
│   └── images/
│       ├── icon_64.png
│       └── icon_256.png
├── app/                        # 应用运行文件（target 指向这里）
│   ├── omniedit                # Go 编译产物（单二进制后端）
│   └── dist/                   # 前端构建产物（Vite build 输出）
│       ├── index.html
│       └── assets/
├── config/
│   ├── privilege               # 应用权限声明
│   └── resource                # api-scope 等资源声明
├── cmd/                        # 生命周期脚本
│   ├── install_init
│   ├── install_callback
│   ├── main                    # start/stop/status：拉起 Go 服务
│   ├── upgrade_init
│   ├── upgrade_callback
│   ├── uninstall_init
│   ├── uninstall_callback
│   ├── config_init
│   └── config_callback
├── wizard/                     # 安装/配置向导表单（可选：端口、授权目录）
│   ├── install/
│   └── config/
├── web/                        # 前端源码（开发期，打包时构建进 app/dist）
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── server/                     # 后端源码（Go）
│   ├── main.go
│   ├── internal/
│   └── go.mod
├── docs/
│   └── ARCHITECTURE.md         # 本文档
└── README.md
```

### 关键目录与环境变量

- `target` → `/vol{n}/@appcenter/{appname}`：已安装运行文件（**Go 二进制与前端产物放这里**）。
- `var` → `@appdata`：需持久化的运行数据（如最近打开、用户偏好）。
- `etc` → `@appconf`：配置。
- 生命周期脚本内一律使用 `TRIM_APPDEST` / `TRIM_PKGETC` / `TRIM_PKGVAR` 等环境变量，**不硬编码路径**。

### `cmd/main` 示例逻辑

```bash
#!/bin/bash
export PATH=...   # 如需运行时
case "$1" in
  start)
    # 在后台启动 Go 服务，监听 ${TRIM_APPDEST}/app.sock
    "${TRIM_APPDEST}/omniedit" --socket "${TRIM_APPDEST}/app.sock" \
                               --static "${TRIM_APPDEST}/dist" &
    exit 0 ;;
  stop)
    # 优雅停止服务
    exit 0 ;;
  status)
    # 运行中 exit 0；未运行 exit 3
    exit 0 ;;
  *) exit 1 ;;
esac
```

---

## 6. 核心数据流

### 6.1 打开并编辑一个文件（文件管理器右键 → OmniEdit）

```
1. 用户在文件管理器右键 .md → 选择 OmniEdit
2. fnOS 打开 iframe：/app/omniedit?path=/vol1/.../note.md
3. 前端解析 path，调用后端 API：GET /app/omniedit/api/file/read?path=...
4. 后端：
   a. 标准化 path，拒绝目录穿越（..）
   b. 校验 path 在已授权目录内（开放 API：授权查询）
   c. 校验当前用户对该 path 可读（开放 API：trim.file.userAcl）
   d. 读取文件内容，返回 { content, encoding, size, mtime }
5. 前端根据扩展名选择 CodeMirror 语言模式，渲染编辑器
6. 用户编辑 → 点击保存
7. 前端：PUT /app/omniedit/api/file/write  { path, content, baseMtime }
8. 后端：
   a. 再次校验授权 + 用户可写 ACL
   b. 冲突检测（mtime 不一致则拒绝，返回 409）
   c. 写入文件，返回新 mtime
```

### 6.2 授权目录获取（首次使用）

```
1. 前端检测无授权目录
2. 通过 JS SDK：
   - 宿主内（isStandaloneWeb=false）：sdk.pickUserFile({ directory:true })
   - 独立浏览器（isStandaloneWeb=true）：sdk.openAppAuth('pickUserFile', {...})
3. 用户选择并确认 → 返回本次授权结果
4. 后端同步授权状态（开放 API 查询授权路径）
5. 前端刷新可访问目录树
```

> 授权建议结合统一网关，保证应用页面与授权回调页同域，回调可用 `postMessage` 安全通知原页面。

---

## 7. 安全模型

| 层面 | 措施 |
|------|------|
| **访问入口** | 仅通过统一网关暴露，复用 NAS 登录态，无独立公网端口 |
| **身份可信** | 用户身份只信网关 Header（`X-Trim-*`），**不信任客户端传入的 userId** |
| **路径安全** | 标准化路径、拒绝 `..` 穿越、只在授权目录内读写、拒绝暴露密钥/配置/私有日志 |
| **用户权限** | 应用用户 ACL ≠ 当前用户权限；读写前用 `trim.file.userAcl` 校验当前用户权限 |
| **Token** | `TRIM_API_TOKEN` 只在后端进程内读取，不落盘、不进前端、不持久化 |
| **业务鉴权** | 网关只校验登录，业务权限（谁能改哪个文件）由应用自己执行 |
| **WebSocket** | 建立时绑定 `X-Trim-Userid`，不信任消息体内 userId |

---

## 8. 打包与分发

| 工具 | 用途 |
|------|------|
| **fnpack** | 创建项目、将应用打包为 `.fpk` |
| **appcenter-cli** | 在 fnOS 设备上安装本地 `.fpk`、管理测试 |

### 开发流程

```
1. web/      → pnpm build  → 产出 app/dist
2. server/   → 交叉编译 linux/amd64 + linux/arm64 → app/omniedit
             （或按 platform=all 打包，用启动脚本选架构二进制）
3. fnpack    → 打包为 OmniEdit_x86_arm.fpk
4. appcenter-cli / 应用中心 → 安装到 fnOS 测试机
5. 桌面打开 OmniEdit，或文件管理器右键文件 → OmniEdit
```

> `platform=all` 仅当包内不含特定架构二进制时使用。OmniEdit 含 Go 编译产物，需分别构建 x86 / ARM 包，或在包内同时放入两份二进制、由 `cmd/main` 按当前架构选择（具体打包策略待用 fnpack 实测确认）。

---

## 9. 里程碑规划

### M0 · 工程骨架
- [x] 初始化 `web/`（Vue3+Vite+TS+CodeMirror6）、`server/`（Go）、`manifest`、`ui/config`、`cmd/*`
- [x] Go 服务监听 Unix Socket + 托管静态产物跑通
- [x] 本地 HTTP 调试模式（`--http` + `--dev-root`），无需 NAS 即可端到端联调
- [ ] fnpack 打包 → appcenter-cli 装到测试机 → 桌面图标能打开空白编辑器（**需真实 NAS**）

### M1 · 可编辑保存（MVP）
- [ ] 授权目录获取（JS SDK）（**需真实 NAS 联调**；本地用 `--dev-root` 模拟）
- [x] 文件读取 / 保存 API + 冲突检测（mtime 409）
- [x] 目录列表 API（`/api/dir/list`）+ 授权根目录 API（`/api/dir/roots`）
- [x] 纯文本 + JSON + Markdown + HTML + XML + Go + C# 高亮
- [x] 多标签页（Pinia store 管理状态）

### M2 · 体验完善
- [x] Markdown 分屏预览（marked + DOMPurify 防 XSS）
- [x] 目录树浏览（授权目录内，递归懒加载）
- [x] 全局搜索（授权目录内搜文件内容，跳过二进制/大文件/依赖目录）
- [x] 主题跟随宿主（启动读 `getPlatformConfig().theme`，CSS 变量 + CodeMirror 热切换）
- [x] 语言跟随宿主（i18n，启动读 `getPlatformConfig().language`，内置 zh/en 文案）
- [x] 大文件优化（>5MB 默认拒绝返回内容，确认后以只读截断预览打开，禁编辑/保存）
- [ ] 主题实时变化监听（待官方公开主题变化事件名，当前仅启动读取一次）

### M3 · 进阶
- [ ] Office 预览/编辑（引入 OnlyOffice/Collabora 或自研轻量解析，**决策见风险项**）
- [x] 文件监听 + WebSocket 推送外部变更（轮询 mtime + 标准库 WS；外部改动自动刷新/弹确认）
- [ ] 上架应用中心

---

## 10. 风险与待确认项

| # | 项 | 说明 | 处理 |
|---|-----|------|------|
| 1 | **Go 运行时依赖** | 官方「运行时环境」页只列了 Python/Node.js/Java 作为可打包运行时，未提及 Go。但 Go 是**编译型**，产物为静态二进制，理论上无需 NAS 安装运行时。 | **部分去风险**：本地已验证 `CGO_ENABLED=0` 交叉编译 linux/amd64+arm64 通过、纯标准库零依赖。仍待实测：静态 Go 二进制在 fnOS 真机上可直接运行；若不行，回退到 Node.js 后端。 |
| 2 | **文件打开方式与授权的衔接** | 右键打开文件时 fnOS 追加 `path`，但该 path 未必在应用已授权目录内。应用用户 ACL 与当前用户 ACL 的授予时机需明确。 | **待真机联调**：需验证「右键打开文件」是否自动授予应用用户 ACL，或需引导用户补授权。本地用 `--dev-root` 模拟授权，无法覆盖此场景。 |
| 3 | **统一网关静态资源路径** | 前端构建产物的 base 路径需匹配 `/app/omniedit`，避免资源 404。 | **已验证并修复**：Vite `base:'/app/omniedit/'`；本地 HTTP 调试暴露并修复了 `spaHandler` 用 `FileServer`（按含前缀 URL 查找）导致的 404/错误 Content-Type bug，改用 `http.ServeFile` 按本地路径精确提供，全部 chunk 已验证 200 + `text/javascript`。 |
| 4 | **多架构打包** | `platform=all` 与含架构二进制的关系。 | 用 fnpack 实测打包策略（**需真机/fnpaack CLI**）。 |
| 5 | **Office 编辑（M3）** | 工作量与资源占用极大。 | 首版明确不做；M3 再评估 OnlyOffice 集成 vs 轻量自研。 |
| 6 | **fnpack / appcenter-cli 具体命令** | CLI 细节未在本地展开。 | 构建/打包脚本（`server/build.ps1`）已就绪，`-Pack` 调用 fnpack；实际打包安装**需真机 + 官方 CLI**。 |
| 7 | **主题实时变化监听** | JS SDK `$on` 需具体事件名，压缩代码中未公开 `themeChange` 事件名。 | 当前仅启动时读一次 `getPlatformConfig().theme`；实时跟随待拿到官方事件名后补充。 |

---

## 参考文档

- 飞牛应用开放平台 · 开发文档：https://developer.fnnas.com/docs/guide/
- 应用框架 / Manifest / 应用入口 / 统一网关 / 运行时环境：https://developer.fnnas.com/docs/core-concepts/*
- 开放 API（调用方式 / 授权与文件）：https://developer.fnnas.com/api/*
- 前端 JS SDK：`@trimjs/web-app`（https://www.npmjs.com/package/@trimjs/web-app）

---

<div align="center">

**OmniEdit** · 飞牛原生 · 全格式文件编辑器 · 架构 v0.1

</div>
