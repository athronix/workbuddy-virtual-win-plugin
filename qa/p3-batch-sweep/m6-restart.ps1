$ErrorActionPreference='Continue'
function Kill-Holders {
  # 任何状态持有 18443 的进程 + 所有 vm-service node + ps-bridge powershell 全清
  Get-NetTCPConnection -LocalPort 18443 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { taskkill /PID $_ /T /F 2>&1 | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vm-service*cli.js*' } |
    ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' } |
    ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }
}
Kill-Holders
schtasks /End /TN WinVMBridge.Service 2>&1 | Out-Null
for ($i=1; $i -le 4; $i++) {
  Write-Output "=== attempt $i ==="
  Start-Sleep -Seconds (12 * $i)   # socket drain 递增：12/24/36/48s
  Kill-Holders                      # 再清一次（warmup 期可能有半途残留）
  schtasks /Run /TN WinVMBridge.Service | Out-Null
  Start-Sleep -Seconds 30
  $own=(Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue).OwningProcess
  if ($own) {
    Write-Output "LISTEN pid=$($own -join ',')"
    try { $h=Invoke-WebRequest -Uri 'http://127.0.0.1:18443/health' -UseBasicParsing -TimeoutSec 8; $j=ConvertFrom-Json $h.Content
      Write-Output ("HEALTH ok="+$j.ok+" fpFiles="+($j.psBridge.fingerprint.files.PSObject.Properties | Measure-Object).Count)
      break } catch { Write-Output "health err, retry" }
  } else { Write-Output "no listener yet" }
}
