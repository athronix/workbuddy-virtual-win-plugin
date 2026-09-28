# tidy-vm-devqa.ps1 -- Consolidate VM-side dev/qa scratch into C:/WinVMBridge/dev-and-qa
# Rules (user-approved 2026-09-23):
#   - Move ~118 scratch files at C:/WinVMBridge root -> dev-and-qa/scratch-20260923/
#   - Move .c1stage/.c5stage/.r2stage dirs            -> dev-and-qa/stage/
#   - DELETE 5 dist .cl019/.cl020.bak                 (rollback value expired, user confirmed)
#   - Archive WinVMWorkspace {e2e-qa, qa-real-test, out, e2e-qa.zip} -> dev-and-qa/workspace-archive/
#   - KEEP production: delivery/ packages/(ex .bak) node_modules/ skills/ shared-skills/
#     package.json kill-restart.ps1 add-defender-exclusions.ps1 + WinVMWorkspace root *.ps1 diag scripts
# All output ASCII only. Idempotent. Never touches delivery/ or service entry.

$ErrorActionPreference = 'Stop'
$root   = 'C:/WinVMBridge'
$ws     = 'C:/WinVMWorkspace'
$devqa  = Join-Path $root 'dev-and-qa'
$stamp  = 'scratch-20260923'
$manifest = @()

function Ensure-Dir([string]$p) {
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}

Ensure-Dir $devqa
Ensure-Dir (Join-Path $devqa $stamp)
Ensure-Dir (Join-Path $devqa 'stage')
Ensure-Dir (Join-Path $devqa 'dist-backups-removed')
Ensure-Dir (Join-Path $devqa 'workspace-archive')

# ---- 1. scratch files at WinVMBridge root -> scratch-20260923/ ----
$pats = @('cl018-*','cl019-*','codebuddy-*','qa-probe.ps1','qa-retest-healthfix.ps1',
          'r2-*.ps1','d12-vm-verify.ps1','pid.ps1','lead-md5-3.ps1','install-vm-run.log')
$scratchFiles = Get-ChildItem $root -File | Where-Object {
  $n = $_.Name
  @($pats | Where-Object { $n -like $_ }).Count -gt 0
}
$moved = 0
foreach ($f in $scratchFiles) {
  $dest = Join-Path (Join-Path $devqa $stamp) $f.Name
  Move-Item -LiteralPath $f.FullName -Destination $dest -Force
  $manifest += "MOVED-FILE  $($f.FullName) -> $dest"
  $moved++
}
Write-Output ("[1] scratch files moved: " + $moved)

# ---- 2. .stage dirs -> stage/ ----
$stageDirs = Get-ChildItem $root -Directory -Force | Where-Object { $_.Name -like '*stage*' -and $_.Name -ne 'dev-and-qa' }
$smoved = 0
foreach ($d in $stageDirs) {
  $dest = Join-Path (Join-Path $devqa 'stage') $d.Name
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item -LiteralPath $d.FullName -Destination $dest -Force
  $manifest += "MOVED-DIR   $($d.FullName) -> $dest"
  $smoved++
}
Write-Output ("[2] stage dirs moved: " + $smoved)

# ---- 3. delete dist .bak (record md5 first, user-approved deletion) ----
$baks = Get-ChildItem (Join-Path $root 'packages') -Recurse -Force -Filter '*.bak' -ErrorAction SilentlyContinue
$bcount = 0
foreach ($b in $baks) {
  $hash = (Get-FileHash $b.FullName -Algorithm MD5).Hash
  $manifest += "DELETED-BAK $($b.FullName)  md5=$hash  bytes=$($b.Length)"
  Remove-Item -LiteralPath $b.FullName -Force
  $bcount++
}
Write-Output ("[3] dist .bak deleted (md5 recorded below): " + $bcount)

# ---- 4. WinVMWorkspace process dirs -> workspace-archive/ ----
$wsItems = @('e2e-qa','qa-real-test','out','e2e-qa.zip')
$wmoved = 0
foreach ($name in $wsItems) {
  $src = Join-Path $ws $name
  if (Test-Path $src) {
    $dest = Join-Path (Join-Path $devqa 'workspace-archive') $name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item -LiteralPath $src -Destination $dest -Force
    $manifest += "MOVED-WS    $src -> $dest"
    $wmoved++
  }
}
Write-Output ("[4] workspace items archived: " + $wmoved)

# ---- 5. write manifest ----
$mfPath = Join-Path $devqa ("MANIFEST-" + $stamp + ".txt")
$manifest += ""
$manifest += ("Executed: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$manifest += "Totals: files=$moved stageDirs=$smoved baksDeleted=$bcount wsItems=$wmoved"
$manifest | Set-Content -Path $mfPath -Encoding ASCII
Write-Output ("[5] manifest written: " + $mfPath)

# ---- 6. verify root state ----
Write-Output "===== VERIFY: WinVMBridge root after tidy ====="
Get-ChildItem $root -Force | Select-Object Mode,Name | Format-Table -AutoSize | Out-String -Width 200
Write-Output "===== VERIFY: WinVMWorkspace root after tidy ====="
Get-ChildItem $ws -Force | Select-Object Mode,Name | Format-Table -AutoSize | Out-String -Width 200
Write-Output "===== VERIFY: service entry intact ====="
Test-Path (Join-Path $root 'delivery/.generated/start-hidden.ps1')
