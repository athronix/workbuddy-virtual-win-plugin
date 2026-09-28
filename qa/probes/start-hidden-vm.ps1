# WinVM Bridge VM Service —— 隐藏窗口启动器（由 install-vm.mjs 生成，请勿手改）
$nodeExe = 'C:\Users\User\AppData\Local\Author Software\nvm\installs\v24.21.0\node.exe'
$cliArgs = '"C:\WinVMBridge\packages\vm-service\dist\cli.js" --host 127.0.0.1 --port 18443 --config "C:\WinVMBridge\delivery\.generated\vm-service.runtime.json"'
$workDir = 'C:\WinVMBridge\packages\vm-service\dist'
$svcPort = '18443'
# 自清理：若端口已被旧实例（孤儿 node，常见于任务被 /end 后游离）占用，先强杀，
# 避免新实例 EADDRINUSE 秒退、旧实例继续以旧代码服务（GUI 判定迟迟不刷新）。
$portPid = (Get-NetTCPConnection -LocalPort $svcPort -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
if ($portPid) { Stop-Process -Id $portPid -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
# 以 -PassThru 捕获 node 子进程；脚本退出（任务被 /end 终止）时兜底强杀 node，避免孤儿残留。
$nodeProc = Start-Process -WindowStyle Hidden -FilePath $nodeExe -ArgumentList $cliArgs -WorkingDirectory $workDir -PassThru
try { $nodeProc.WaitForExit() } finally { if ($nodeProc -and -not $nodeProc.HasExited) { try { $nodeProc.Kill() } catch {} } }
