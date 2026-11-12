# 大文件测试集生成器（OmniEdit 阈值验证用）
# 用法：pwsh ./generate.ps1
# 生成物（本目录）：
#   small.md          500KB  → 预览正常（自动预览 + 编辑实时更新）
#   over-preview.md   1.5MB  → 编辑正常；预览提示「内容过大」
#   over-preview.html 1.5MB  → 同上（HTML 端）
#   2mb.txt / 5mb.log / 9.5mb.txt → ≤10MB：打开/编辑/保存/搜索全流程
#   11mb.log          11MB   → 打开提示「文件过大（上限 10 MB）」
# 内容带行号与 NEEDLE-xxxxxx 锚点，便于验证搜索与滚动。

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

# 1000 行 × ~64B ≈ 62KB 的基础块（带行号锚点，可搜索）
$chunk = (1..1000 | ForEach-Object { 'LINE {0:D6} ··· NEEDLE-000001 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' -f $_ }) -join "`n"

function New-TextFile([string]$name, [double]$targetMB, [string]$header, [string]$footer) {
  # 动态测量块字节（UTF-8），按目标大小算块数——行含中文锚点，不能按估算值。
  $chunkBytes = [System.Text.Encoding]::UTF8.GetByteCount($chunk) + 1
  $chunks = [int][Math]::Ceiling(($targetMB * 1MB - [System.Text.Encoding]::UTF8.GetByteCount($header)) / $chunkBytes)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.Append($header)
  for ($i = 0; $i -lt $chunks; $i++) {
    [void]$sb.Append($chunk)
    [void]$sb.Append("`n")
    if ($i % 50 -eq 0) { [void]$sb.Append("`n## 段落 $i`n`n锚点 NEEDLE-BLOCK-{0:D4} —— 可用查找定位本块。`n`n" -f $i) }
  }
  [void]$sb.Append($footer)
  [System.IO.File]::WriteAllText((Join-Path $dir $name), $sb.ToString())
  $f = Get-Item (Join-Path $dir $name)
  '{0,-18} {1,8:N1} KB' -f $f.Name, ($f.Length / 1KB)
}

New-TextFile 'small.md'        0.5  "# 预览测试 · 500KB Markdown`n`n此文件应正常自动预览，编辑后预览实时更新（防抖 ~500ms）。`n`n" "`n`n--- END（若能在预览中滚到底部看到本行，说明渲染完整）`n"
New-TextFile 'over-preview.md' 1.5  "# 超预览阈值 · 1.5MB Markdown`n`n预期：编辑正常；点眼睛进预览显示「内容过大，暂不支持预览」。`n`n" "`n`n--- END`n"
New-TextFile 'over-preview.html' 1.5 "<!DOCTYPE html><html><body><h1>超预览阈值 · 1.5MB HTML</h1><p>预期：编辑正常；预览显示「内容过大」。</p>`n" "`n<p>--- END ---</p></body></html>`n"
New-TextFile '2mb.txt'   2   "# 2MB 纯文本`n预期：直接打开，编辑/保存/查找流畅。`n`n" "`n--- END ---`n"
New-TextFile '5mb.log'   5   "# 5MB 日志`n预期：直接打开，编辑/保存/查找流畅。`n`n" "`n--- END ---`n"
New-TextFile '9.5mb.txt' 9.5 "# 9.5MB 纯文本（接近 10MB 上限）`n预期：仍可直接打开、可编辑可保存。`n`n" "`n--- END ---`n"
New-TextFile '11mb.log'  11  "# 11MB 日志（超过 10MB 上限）`n预期：打开提示「文件过大：11.x MB（上限 10 MB），无法打开」。`n`n" "`n--- END ---`n"
