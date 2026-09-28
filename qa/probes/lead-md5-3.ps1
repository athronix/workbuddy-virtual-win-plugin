$ErrorActionPreference = 'Continue'
Write-Output "=== MD5 (VM, 3 key artifacts) ==="
Get-FileHash 'C:/WinVMBridge/packages/vm-capabilities/psmod/app.ps1','C:/WinVMBridge/packages/vm-capabilities/psmod/ps-bridge.ps1','C:/WinVMBridge/packages/adapter-agent-workbuddy/dist/index.js' -Algorithm MD5 |
  ForEach-Object { "$($_.Hash.ToLower())  $($_.Path)" }

Write-Output "=== PSBRIDGE ==="
$pb = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' })
Write-Output "PSBRIDGE_COUNT=$($pb.Count)"
foreach ($p in $pb) { Write-Output "  pid=$($p.ProcessId) ppid=$($p.ParentProcessId)" }

Write-Output "=== PORT 18443 OWNER ==="
try {
  $owner = (Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction Stop).OwningProcess | Select-Object -Unique
  foreach ($o in $owner) {
    $pr = Get-Process -Id $o -ErrorAction SilentlyContinue
    Write-Output "owner_pid=$o name=$($pr.ProcessName) start=$($pr.StartTime.ToString('s'))"
  }
} catch { Write-Output "port_probe_error=$($_.Exception.Message)" }
