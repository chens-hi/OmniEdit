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

  # fnpack 会把 -d 目录**整体**复制打包：源码目录（web/node_modules 的 pnpm
  # 软链接、server 源码、.git、docs、tools）绝不能进包——实测直接对仓库根
  # 打包会因 node_modules 软链接报 "Incorrect function" 而失败。
  # 因此先构造只含发布物的 staging 目录，再对其打包。
  $stage = Join-Path $root 'build\pkg'
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'app') | Out-Null

  Copy-Item (Join-Path $root 'manifest') $stage
  # 桌面 UI 必须落在 app/ui（fnpack 官方模板即 app\ui\{config,images}；
  # manifest 的 desktop_uidir=ui 是相对 app 目录解析的）。仓库根 ui/ 仅为开发源目录。
  Copy-Item (Join-Path $root 'ui') (Join-Path $stage 'app\ui') -Recurse
  Copy-Item (Join-Path $root 'config') (Join-Path $stage 'config') -Recurse
  Copy-Item (Join-Path $root 'cmd')    (Join-Path $stage 'cmd')    -Recurse
  if (-not (Test-Path (Join-Path $root 'app\dist\index.html'))) {
    throw "缺少前端产物 app/dist，请先不带 -SkipWeb 运行一次"
  }
  Copy-Item (Join-Path $root 'app\dist') (Join-Path $stage 'app\dist') -Recurse
  # 二进制：cmd/main 按 uname -m 选择架构，两份都放进包（platform=all 策略，
  # 见 ARCHITECTURE.md 风险 #4）。
  foreach ($bin in 'omniedit-amd64', 'omniedit-arm64', 'omniedit') {
    $src = Join-Path $root "app\$bin"
    if (Test-Path $src) { Copy-Item $src (Join-Path $stage "app\$bin") }
  }

  # 根目录图标：fnpack 强制要求 ICON.PNG / ICON_256.PNG（官方模板亦如此），
  # 由构建从 ui/images 生成到 staging，不入库（.gitignore 已忽略根目录副本）。
  $iconSrc = Join-Path $root 'ui\images'
  if (-not (Test-Path $iconSrc)) { throw "缺少图标目录 ui/images（fnpack 打包强制要求根目录 ICON.PNG/ICON_256.PNG）" }
  Copy-Item (Join-Path $iconSrc 'icon_64.png')  (Join-Path $stage 'ICON.PNG')     -Force
  Copy-Item (Join-Path $iconSrc 'icon_256.png') (Join-Path $stage 'ICON_256.PNG') -Force

  # fnpack 解析顺序：仓库内 tools/ 的本地副本（优先，版本可控）-> PATH 中的 fnpack。
  $fnpack = $null
  $localFnpack = Get-ChildItem (Join-Path $root 'tools') -Filter 'fnpack-*-windows-amd64*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($localFnpack) {
    $fnpack = $localFnpack.FullName
    Write-Host "    使用本地 fnpack: $($localFnpack.Name)"
  } else {
    $cmd = Get-Command fnpack -ErrorAction SilentlyContinue
    if ($cmd) { $fnpack = $cmd.Source; Write-Host "    使用 PATH fnpack: $fnpack" }
  }
  if (-not $fnpack) { throw "未找到 fnpack：请放置 fnpack-*-windows-amd64.exe 到 tools/，或安装到 PATH（https://developer.fnnas.com/docs/cli/fnpack/）" }

  Push-Location $stage
  & $fnpack build 2>&1 | ForEach-Object { Write-Host "    $_" }
  Pop-Location

  # 重要：fnpack 1.2.3 **失败时退出码仍为 0**（实测），只能以产物判定成败。
  $fpk = Get-ChildItem $stage -Filter '*.fpk' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $fpk) { throw "fnpack 打包失败（该 CLI 失败也返回 exit 0，以产物缺失判定；见上方输出）" }
  $outFpk = Join-Path $root ("build\" + $fpk.Name)
  Move-Item $fpk.FullName $outFpk -Force
  Write-Host "    打包产物: $outFpk ($([math]::Round((Get-Item $outFpk).Length/1mb,1)) MB)" -ForegroundColor Green
} else {
  Write-Host "==> [3/3] 跳过打包（加 -Pack 启用 fnpack）" -ForegroundColor DarkGray
}

Write-Host "==> 构建完成" -ForegroundColor Cyan
