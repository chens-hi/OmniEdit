# OmniEdit 构建脚本 / Build Script
# 用法（在仓库根目录的 server/ 下执行）：
#   pwsh ./build.ps1              # 构建当前平台（开发）
#   pwsh ./build.ps1 -AllArch     # 交叉编译 x86_64 + arm64（发布）
#
# 步骤：
#   1. 构建前端 -> app/dist
#   2. 编译 Go 后端 -> app/omniedit
#   3. （可选）调用 fnpack 打包 .fpk

param(
  [switch]$AllArch,
  [switch]$SkipWeb,
  [switch]$Pack
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # server/ 的父目录 = 仓库根
$webDir = Join-Path $root 'web'
$appDir = Join-Path $root 'app'

Write-Host "==> OmniEdit build (root=$root)" -ForegroundColor Cyan

# ---------- 1. 前端 ----------
if (-not $SkipWeb) {
  Write-Host "==> [1/3] 构建前端 (Vite) ..." -ForegroundColor Yellow
  Push-Location $webDir
  if (-not (Test-Path 'node_modules')) {
    Write-Host "    安装依赖 (pnpm install) ..."
    pnpm install
  }
  pnpm build
  Pop-Location
  Write-Host "    前端产物: $appDir\dist" -ForegroundColor Green
} else {
  Write-Host "==> [1/3] 跳过前端构建 (-SkipWeb)" -ForegroundColor DarkGray
}

# ---------- 2. Go 后端 ----------
Write-Host "==> [2/3] 编译 Go 后端 ..." -ForegroundColor Yellow
Push-Location $PSScriptRoot

function Build-One($goos, $goarch, $outName) {
  $env:GOOS = $goos
  $env:GOARCH = $goarch
  $env:CGO_ENABLED = '0'
  $out = Join-Path $appDir $outName
  Write-Host "    $goos/$goarch -> $out"
  go build -ldflags="-s -w" -o $out .
  if ($LASTEXITCODE -ne 0) { throw "编译失败: $goos/$goarch" }
}

if ($AllArch) {
  Build-One 'linux' 'amd64' 'omniedit-amd64'
  Build-One 'linux' 'arm64' 'omniedit-arm64'
  # 复制当前开发机可用的一份作为默认 omniedit（打包脚本按架构选择）
  Copy-Item (Join-Path $appDir 'omniedit-amd64') (Join-Path $appDir 'omniedit') -Force
} else {
  # 本地/当前平台构建（Windows 下生成 omniedit.exe 仅供调试）
  $env:CGO_ENABLED = '0'
  $out = Join-Path $appDir 'omniedit'
  Write-Host "    current platform -> $out"
  go build -ldflags="-s -w" -o $out .
  if ($LASTEXITCODE -ne 0) { throw "编译失败" }
}
Pop-Location

# ---------- 3. 打包（可选） ----------
if ($Pack) {
  Write-Host "==> [3/3] 打包 .fpk (fnpack) ..." -ForegroundColor Yellow
  Push-Location $root
  fnpack
  Pop-Location
} else {
  Write-Host "==> [3/3] 跳过打包（加 -Pack 启用 fnpack）" -ForegroundColor DarkGray
}

Write-Host "==> 构建完成" -ForegroundColor Cyan
