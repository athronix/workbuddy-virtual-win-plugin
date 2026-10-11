$ErrorActionPreference = 'Continue'
# P2-T7 窗口收口对账：三点哈希重取（与 step0b 基线 f61dd89f/801038bc/90fee7a4 对账）
# 基线口径：Get-FileHash -Algorithm SHA256（与 step0b 完全同一取法，别换算法）
"--- .generated dir census ---"
Get-ChildItem 'C:\WinVMBridge\delivery\.generated' -Force -ErrorAction SilentlyContinue |
  ForEach-Object { "  $($_.Length)B  $($_.Name)" }
$paths = @(
  'C:\WinVMBridge\delivery\.generated\vm-service.runtime.json',
  'C:\WinVMBridge\delivery\.generated\start-hidden.ps1',
  'C:\WinVMBridge\delivery\.generated\start-hidden.vbs',
  'C:\WinVMBridge\delivery\.generated\task.xml'
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    $h = (Get-FileHash -Algorithm SHA256 -Path $p).Hash.ToLower()
    $len = (Get-Item $p).Length
    "SHA256 $h  $([int]$len)B  $p"
  } else {
    "MISSING  $p"
  }
}
"--- /health final ---"
curl.exe -s --max-time 15 -o C:\WinVMBridge\t7-health-final.json http://127.0.0.1:18443/health
"curl_rc=$LASTEXITCODE"
if (Test-Path C:\WinVMBridge\t7-health-final.json) {
  $j = Get-Content C:\WinVMBridge\t7-health-final.json -Raw | ConvertFrom-Json
  "tasks=" + ($j.tasks | ConvertTo-Json -Compress)
  "authMode=" + $j.security.authMode
  "bearerSelfCheck=" + $j.security.bearerSelfCheck.code
  "innerReconnect=" + $j.security.innerReconnect.status
  "audit=" + ($j.audit | ConvertTo-Json -Compress)
  "provider=" + $j.provider.id + " state=" + $j.provider.state
  "llmSession=" + ($j.llmSession | ConvertTo-Json -Compress)
  "psBridge=" + ($j.psBridge | ConvertTo-Json -Compress)
}
