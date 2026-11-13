<div align="center">

# OmniEdit

**飞牛原生 · 全格式文件编辑器**

*A native, all-format file editor for fnOS.*

[![Platform](https://img.shields.io/badge/Platform-fnOS-blue)]()
[![Version](https://img.shields.io/badge/Version-0.6.33-green)]()

</div>

---

## 简介 / Introduction

**OmniEdit** 是一款面向飞牛 fnOS 的原生文件编辑器，目标是**一个工具覆盖 NAS 上的所有文件编辑场景**——纯文本、代码、配置、Markdown、富文本，无需在多个应用之间来回切换。

**OmniEdit** is a native file editor built for fnOS. The goal is simple: **one tool for every file-editing task on your NAS** — plain text, code, config, Markdown, rich text — without juggling multiple apps.

---

## 设计目标 / Design Goals

| 目标 | 说明 |
|------|------|
| **原生 Native** | 深度适配 fnOS，遵循系统设计规范，非网页套壳 |
| **全格式 All-format** | 一个编辑器处理尽可能多的文件类型 |
| **轻量 Lightweight** | 快速启动，低资源占用，适配 NAS 硬件 |
| **本地优先 Local-first** | 文件留在你的 NAS 上，数据不出内网 |

| Goal | Description |
|------|-------------|
| **Native** | Deeply integrated with fnOS, follows system design, not a web wrapper |
| **All-format** | One editor for as many file types as possible |
| **Lightweight** | Fast startup, low footprint, fits NAS hardware |
| **Local-first** | Files stay on your NAS, data never leaves your network |

---

## 特性 / Features

### 编辑核心 / Editor Core

- [x] 纯文本编辑 / Plain text editing
- [x] 多标签页 / Multi-tab
- [x] 语法高亮（42 语言族，覆盖 120+ 扩展名）/ Syntax highlighting for 42 language families
- [x] 代码折叠 / Code folding
- [x] 查找与替换 / Find & replace
- [x] 自动换行 / Word wrap
- [x] 缩进风格（空格 2/4/8 或 Tab）/ Indent style
- [x] 内置等宽字体（JetBrains Mono）/ Built-in monospace font

### 文件与保存 / File & Save

- [x] 大文件支持（打开上限 10MB，流畅编辑）/ Large file support (up to 10MB)
- [x] 文件写入原子化（临时文件 + rename，防损坏）/ Atomic file writes
- [x] mtime 冲突检测 / Save conflict detection
- [x] 编码识别（UTF-8 / UTF-8 BOM / GB18030）/ Encoding detection
- [x] 行尾风格识别（LF / CRLF / Mixed）/ Line ending detection
- [x] 另存为（宿主选目录/文件名）/ Save As via host picker
- [x] 右键打开未授权文件 → 自动请求宿主授权 / Auto authorization on 403

### 预览 / Preview

- [x] Markdown 实时预览 / Markdown live preview
- [x] HTML 实时预览 / HTML live preview
- [x] 相对路径图片/资源重写 / Relative resource URL rewriting
- [x] 预览区语法高亮跟随主题 / Preview theme follows editor

### 会话与外部变更 / Session & External Changes

- [x] 会话自动恢复（下次启动还原所有页签）/ Session restore
- [x] 启动快速恢复（活动页签优先加载）/ Fast boot with active-tab priority
- [x] 外部变更检测（WebSocket 推送，按用户隔离）/ External-change detection
- [x] 外部修改询问（重载 / 保持当前）/ External change prompt

### 界面与体验 / UI & UX

- [x] 主题跟随宿主（深/浅色）/ Theme following host
- [x] 语言跟随宿主（中/英文 i18n）/ Language following host
- [x] 状态栏（路径 / 编码 / 行尾 / 行列 / 字节数）/ Status bar
- [x] 页签拖拽排序 / Tab drag reordering
- [x] 批量关闭确认 / Batch close confirmation
- [x] 移动端窄屏适配 / Mobile narrow-screen support
- [x] 右键上下文菜单 / Context menus
- [x] 预览/编辑悬浮切换按钮 / Floating preview toggle

### 安全与日志 / Security & Logging

- [x] 路径穿越防护（`..` 段过滤 + EvalSymlinks）/ Path traversal protection
- [x] 符号链接逃逸检测 / Symlink escape detection
- [x] 按用户隔离文件访问 / Per-user file access isolation
- [x] 文件写入原子化 / Atomic file writes
- [x] 每日日志 + 7 天自动清理 / Daily log files with 7-day retention
- [x] 本地调试模式（无需 NAS）/ Local debug mode

---

## 架构 / Architecture

OmniEdit 采用 **fnOS 原生应用**形态：常驻后端服务（Go）+ 飞牛桌面 iframe 内的 Web 前端（Vue 3 + CodeMirror 6），通过 **统一网关** `/app/omniedit` 复用 NAS 登录态，并深度集成 fnOS「授权与文件」开放能力。

完整技术选型与设计见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

## 项目结构 / Project Structure

```
OmniEdit/
├── manifest            # 应用元数据
├── ui/                 # 桌面 UI 目录（入口定义 + 图标）
├── app/                # 运行文件（Go 二进制 + 前端构建产物）
├── config/             # 权限 / api-scope 声明
├── cmd/                # 生命周期脚本（start/stop/status）
├── web/                # 前端源码（Vue 3 + CodeMirror 6）
├── server/             # 后端源码（Go）
├── docs/               # 设计文档
│   ├── ARCHITECTURE.md
│   └── BUILDING.md
└── README.md
```

> 当前状态：核心编辑功能完整，已支持 42 语言族语法高亮、大文件（10MB）编辑、Markdown/HTML 预览、会话恢复、外部变更检测、移动端适配。开放 API 授权与用户 ACL 联调需在真实 NAS 环境完成。

## 快速开始 / Getting Started

```powershell
# 构建前端 + 后端（当前平台）
pwsh ./server/build.ps1

# 交叉编译 x86 + ARM（发布用）
pwsh ./server/build.ps1 -AllArch

# 构建并打包 .fpk
pwsh ./server/build.ps1 -AllArch -Pack
```

详细构建与本地调试说明见 **[docs/BUILDING.md](docs/BUILDING.md)**。

---

## 贡献 / Contributing

欢迎提交 Issue 和 Pull Request。

Issues and pull requests are welcome.

---

## 许可证 / License

许可证待定 / License to be determined.

---

<div align="center">

**OmniEdit** · 飞牛原生 · 全格式文件编辑器

</div>
