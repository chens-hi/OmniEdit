<div align="center">

# OmniEdit

**飞牛原生 · 全格式文件编辑器**

*A native, all-format file editor for fnOS.*

[![Platform](https://img.shields.io/badge/Platform-fnOS-blue)]()
[![License](https://img.shields.io/badge/License-TBD-green)]()

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

> 🚧 **开发中 / Work in progress** — ✅ 已完成 · 🚧 进行中 · ⬜ 规划中

- [x] 纯文本编辑 / Plain text editing
- [x] 语法高亮（JSON / Markdown / HTML / XML / Go / C#）/ Syntax highlighting
- [x] Markdown 编辑与预览 / Markdown editing & preview
- [x] 多标签页 / Multi-tab
- [x] 目录浏览（授权目录内）/ Directory browsing
- [x] 全局搜索（授权目录内内容搜索）/ Global search
- [x] 文件保存冲突检测 / Save conflict detection
- [x] 主题跟随宿主（深/浅色）/ Theme following host
- [x] 语言跟随宿主（中/英文 i18n）/ Language following host
- [x] 大文件保护（>5MB 只读预览）/ Large-file protection
- [x] 外部变更检测（WebSocket 推送 + 自动刷新/提示）/ External-change detection
- [x] 本地调试模式（无需 NAS）/ Local debug mode
- [ ] 主题实时变化监听 / Live theme-change listener
- [ ] Office（docx/xlsx/pptx）/ Office formats

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

> 🚧 目前处于 **M1 核心编辑功能已实现** 阶段（多标签 / 语法高亮 / Markdown 预览 / 目录浏览 / 冲突检测 / 本地调试）。开放 API 授权与用户 ACL 联调需在真实 NAS 环境完成。

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
