$ErrorActionPreference = 'Continue'
$task = 'WinVMBridge.Service'
function Owner { (Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue).OwningProcess }
"owner_before=" + ((Owner) -join ',')

# Force-kill the 18443 port owner and its child process tree (incl. its ps-bridge.ps1)
foreach ($p in (Owner)) { "taskkill $p => " + ((taskkill /PID $p /T /F 2>&1) -join ' | ') }
# Fallback: any leftover ps-bridge.ps1
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' } |
  ForEach-Object { "taskkill psbridge $($_.ProcessId) => " + ((taskkill /PID $_.ProcessId /T /F 2>&1) -join ' | ') }
Start-Sleep -Seconds 3
"owner_after_kill=" + ((Owner) -join ',')

schtasks /End /TN $task 2>&1 | Out-Null
Start-Sleep -Seconds 1
"run => " + ((schtasks /Run /TN $task 2>&1) -join ' | ')
Start-Sleep -Seconds 8
$o = Owner
"owner_after_run=" + (($o) -join ',')
foreach ($p in $o) {
  $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
  "  new_service PID=$p Start=$($pr.CreationDate)"
}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' } |
  ForEach-Object { "  psbridge PID=$($_.ProcessId) PPID=$($_.ParentProcessId) Start=$($_.CreationDate)" }
