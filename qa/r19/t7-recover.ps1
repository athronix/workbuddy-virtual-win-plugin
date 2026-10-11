$ErrorActionPreference = 'Continue'
$task = 'WinVMBridge.Service'

"=== STEP1: node process census (CommandLine) ==="
$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
"node_total=" + $nodes.Count
foreach ($p in $nodes) {
  $cl = if ($p.CommandLine) { $p.CommandLine } else { '(none)' }
  if ($cl.Length -gt 170) { $cl = $cl.Substring(0, 170) }
  "  PID=$($p.ProcessId) PPID=$($p.ParentProcessId) CREATED=$($p.CreationDate) CMD=$cl"
}

"=== STEP2: port owner census ==="
"owner_18443=" + ((Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue).OwningProcess -join ',')

"=== STEP3: kill orphans whose parent is dead or is a lost-bridge child ==="
# 端口持有者由后面的 schtasks 流程处理；这里清理的是「父进程已不存在」的 node 孤儿
# （即 fill 轮里 480 路委派留下的 workbuddy -p 子进程后裔），它们不属于任何服务树。
$livePids = @{}
foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) { $livePids[[int]$p.ProcessId] = $true }
$killed = 0
foreach ($p in $nodes) {
  $isPortOwner = ((Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue).OwningProcess -contains [int]$p.ProcessId)
  if ($isPortOwner) { "  skip_port_owner PID=$($p.ProcessId)"; continue }
  if (-not $livePids.ContainsKey([int]$p.ParentProcessId)) {
    $r = (taskkill /PID $p.ProcessId /T /F 2>&1) -join ' | '
    "  kill_orphan PID=$($p.ProcessId) PPID=$($p.ParentProcessId) => $r"
    $killed = $killed + 1
  }
}
"killed_orphans=$killed"

"=== STEP4: leftover ps-bridge ==="
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' } |
  ForEach-Object { "  kill_psbridge PID=$($_.ProcessId) => " + ((taskkill /PID $_.ProcessId /T /F 2>&1) -join ' | ') }

Start-Sleep -Seconds 3

"=== STEP5: restart service task ==="
schtasks /End /TN $task 2>&1 | Out-Null
Start-Sleep -Seconds 2
"run => " + ((schtasks /Run /TN $task 2>&1) -join ' | ')

"=== STEP6: poll port (up to 60s) ==="
$owner = $null
for ($i = 0; $i -lt 20; $i = $i + 1) {
  $owner = (Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($owner) { "  poll#$i LISTEN PID=$($owner -join ',')"; break }
  Start-Sleep -Seconds 3
}
if (-not $owner) { "  NO_LISTENER after 60s" }

"=== STEP7: health ==="
$out = "$env:LOCALAPPDATA\..\..\WinVMBridge\h.json"
curl.exe -s --max-time 15 -o C:\WinVMBridge\h-after-restore.json http://127.0.0.1:18443/health
"curl_rc=$LASTEXITCODE"
if (Test-Path C:\WinVMBridge\h-after-restore.json) {
  $j = Get-Content C:\WinVMBridge\h-after-restore.json -Raw
  if ($j.Length -gt 900) { $j.Substring(0, 900) } else { $j }
}

"=== STEP8: final node census ==="
"node_total_after=" + (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue).Count
