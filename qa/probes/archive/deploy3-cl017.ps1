$ErrorActionPreference = 'Continue'
$port = 18443
$task = 'WinVMBridge.Service'

function Get-PortOwner {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.OwningProcess } else { return $null }
}
function Get-OwnerStart([int]$targetPid) {
  if (-not $targetPid) { return '(none)' }
  $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($p) { return $p.StartTime.ToString('o') } else { return '(gone)' }
}

Write-Output '=== BEFORE ==='
$oldPid = Get-PortOwner
Write-Output ('OLD_OWNER_PID=' + $oldPid)
Write-Output ('OLD_OWNER_START=' + (Get-OwnerStart $oldPid))

Write-Output '=== STOP (schtasks /End + taskkill /T /F) ==='
schtasks /End /TN $task 2>&1 | Out-Null
if ($oldPid) { taskkill /PID $oldPid /T /F 2>&1 | Out-Null }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like '*ps-bridge.ps1*' -or $_.CommandLine -like '*start-hidden.ps1*') } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }
Start-Sleep -Seconds 3
$afterStop = Get-PortOwner
Write-Output ('PORT_OWNER_AFTER_STOP=' + $afterStop)

Write-Output '=== EXTRACT (cwd-relative + --force-local) ==='
Push-Location 'C:/WinVMBridge'
& tar --force-local -xf 'cl017-dist.tar'
Write-Output ('extract_exit=' + $LASTEXITCODE)
Pop-Location

Write-Output '=== MD5 (VM) ==='
Get-FileHash 'C:/WinVMBridge/packages/contracts/dist/errors.js','C:/WinVMBridge/packages/adapter-agent-workbuddy/dist/index.js','C:/WinVMBridge/packages/vm-service/dist/server.js','C:/WinVMBridge/packages/core/dist/policy/defaults.js','C:/WinVMBridge/packages/vm-capabilities/dist/ps-bridge.js' -Algorithm MD5 |
  ForEach-Object { "$($_.Hash.ToLower())  $($_.Path)" }

Write-Output '=== START ==='
schtasks /Run /TN $task 2>&1 | Out-Null
Start-Sleep -Seconds 12
$newPid = Get-PortOwner
Write-Output ('NEW_OWNER_PID=' + $newPid)
Write-Output ('NEW_OWNER_START=' + (Get-OwnerStart $newPid))
Write-Output ('PID_CHANGED=' + ($newPid -ne $oldPid))
$bridges = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*ps-bridge.ps1*' })
Write-Output ('PSBRIDGE_COUNT=' + $bridges.Count)
foreach ($b in $bridges) { Write-Output ('  PSBRIDGE PID=' + $b.ProcessId + ' PPID=' + $b.ParentProcessId) }
