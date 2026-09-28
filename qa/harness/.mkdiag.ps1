$realPath = "C:\WinVMBridge\delivery\.generated\task.xml"
$diagPath = "C:\WinVMBridge\diag-session.ps1"
$modPath  = "C:\WinVMBridge\diag-task.xml"
$real = [System.IO.File]::ReadAllText($realPath)
$mod  = $real -replace [regex]::Escape('C:\WinVMBridge\delivery\.generated\start-hidden.ps1'), 'C:\WinVMBridge\diag-session.ps1'
[System.IO.File]::WriteAllText($modPath, $mod, [System.Text.Encoding]::Unicode)
$r = schtasks /Create /TN WinVMBridge.Diag /XML $modPath /F 2>&1
$r | Out-File C:\WinVMBridge\.mkdiag.out -Encoding utf8
$r | Write-Output
$r2 = schtasks /Run /TN WinVMBridge.Diag 2>&1
$r2 | Out-File -Append C:\WinVMBridge\.mkdiag.out -Encoding utf8
$r2 | Write-Output
