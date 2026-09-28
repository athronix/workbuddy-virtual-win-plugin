$ErrorActionPreference = 'Continue'
$port = 18443
$task = 'WinVMBridge.Service'

Write-Output "=== STOP SERVICE ==="
schtasks /End /TN $task 2>&1 | Out-Null
$pids = (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Write-Output ("psbridge_after_stop=" + @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' }).Count)

Write-Output "=== EXTRACT (cwd-relative + --force-local) ==="
Push-Location 'C:/WinVMBridge'
& tar --force-local -xf 'cl017-dist.tar'
$code = $LASTEXITCODE
Pop-Location
Write-Output "extract_exit=$code"

Write-Output "=== MD5 (VM) ==="
Get-FileHash 'C:/WinVMBridge/packages/vm-capabilities/psmod/app.ps1','C:/WinVMBridge/packages/vm-capabilities/psmod/appops.ps1','C:/WinVMBridge/packages/vm-capabilities/psmod/gui.ps1','C:/WinVMBridge/packages/vm-capabilities/psmod/ps-bridge.ps1','C:/WinVMBridge/packages/vm-capabilities/psmod/storage.ps1','C:/WinVMBridge/packages/vm-capabilities/psmod/system.ps1','C:/WinVMBridge/packages/core/dist/policy/defaults.js','C:/WinVMBridge/packages/core/dist/policy/engine.js','C:/WinVMBridge/packages/vm-capabilities/dist/ps-bridge.js','C:/WinVMBridge/packages/vm-capabilities/dist/registry/definitions.js','C:/WinVMBridge/packages/adapter-agent-workbuddy/dist/index.js','C:/WinVMBridge/packages/adapter-agent-workbuddy-llm/dist/bridge.js','C:/WinVMBridge/packages/vm-service/dist/server.js' -Algorithm MD5 |
  ForEach-Object { "$($_.Hash.ToLower())  $($_.Path)" }

Write-Output "=== START SERVICE ==="
schtasks /Run /TN $task 2>&1 | Out-Null
Write-Output "START_ISSUED"
Start-Sleep -Seconds 14
Write-Output ("psbridge_after_start=" + @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' }).Count)
