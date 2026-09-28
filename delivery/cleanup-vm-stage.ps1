<#
.SYNOPSIS
  WinVM —— 清理 VM 部署目录下遗留的临时解包目录 (.*stage*)。

.DESCRIPTION
  deploy-vm.mjs 在 VM 侧解包 dist 时会产生临时 stage 目录（如 .stage / .stage-xxxx）。
  本脚本在 VM 本机（或经隧道 ssh 到 VM 后）运行，递归删除指定根目录下所有名称匹配
  ".*stage*" 的目录。默认先 -WhatIf 预览，确认无误后去掉 -WhatIf 真正执行。

.PARAMETER Roots
  VM 侧部署根目录列表，默认 @('C:/WinVMBridge', 'C:/WinVMWorkspace')。

.PARAMETER WhatIf
  仅预览将被删除的目录，不实际删除。

.EXAMPLE
  # 预览
  powershell -NoProfile -ExecutionPolicy Bypass -File cleanup-vm-stage.ps1
  # 真正执行
  powershell -NoProfile -ExecutionPolicy Bypass -File cleanup-vm-stage.ps1 -WhatIf:$false
#>
param(
  [string[]] $Roots = @('C:/WinVMBridge', 'C:/WinVMWorkspace'),
  [switch]   $WhatIf = $true
)

$ErrorActionPreference = 'Continue'
$removed = 0
$skipped = 0

foreach ($root in $Roots) {
  if (-not (Test-Path $root)) {
    Write-Host "[skip] 根目录不存在: $root"
    $skipped++
    continue
  }
  # 递归查找名称匹配 .*stage* 的目录（只删目录，不碰文件）
  $stageDirs = Get-ChildItem -Path $root -Recurse -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.stage' }

  if (-not $stageDirs) {
    Write-Host "[clean] $root 下无 .stage* 目录"
    continue
  }

  foreach ($d in $stageDirs) {
    if ($WhatIf) {
      Write-Host "[whatif] 将删除: $($d.FullName)"
    } else {
      try {
        Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop
        Write-Host "[removed] $($d.FullName)"
        $removed++
      } catch {
        Write-Warning "[fail] 删除失败: $($d.FullName) -> $($_.Exception.Message)"
        $skipped++
      }
    }
  }
}

Write-Host "`n==== 汇总 (WhatIf=$WhatIf) ===="
Write-Host "已删除: $removed   跳过/失败: $skipped"
if ($WhatIf) { Write-Host "（这是预览，去掉 -WhatIf 才会真正删除）" }
