$port = 18443
$task = 'WinVMBridge.Service'
# 1) 杀端口占用（孤儿 node）
$pids = (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
foreach ($p in $pids) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {} }
# 2) 杀 start-hidden 包装进程
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*start-hidden.ps1*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
# 3) 结束任务（若有运行实例）
schtasks /End /TN $task
Start-Sleep -Seconds 2
# 4) 重新运行（新实例会按端口强杀残余并拉起新 node + 新 ps-bridge）
schtasks /Run /TN $task
Write-Output "RESTART_ISSUED"
Start-Sleep -Seconds 4
# 报告状态
Write-Output "===TASK==="
schtasks /Query /TN $task /V /Fo List | Out-String
Write-Output "===NODE==="
Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id,SessionId,StartTime,Path | Format-Table -AutoSize | Out-String
