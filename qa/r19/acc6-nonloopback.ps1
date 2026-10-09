# ACC-6: non-loopback bind must fail closed (ASCII only)
Set-Location C:\WinVMBridge
$errF = 'C:\Users\User\wbtmp_acc6.err.txt'
$outF = 'C:\Users\User\wbtmp_acc6.out.txt'
$p = Start-Process node -ArgumentList 'packages\vm-service\dist\cli.js','--host','0.0.0.0','--port','18999' -NoNewWindow -PassThru -RedirectStandardError $errF -RedirectStandardOutput $outF
Start-Sleep -Seconds 6
if (-not $p.HasExited) {
  Write-Output 'RESULT=STILL-ALIVE (FAIL-CLOSED BROKEN!)'
  Stop-Process -Id $p.Id -Force
} else {
  Write-Output ('RESULT=EXITED code=' + $p.ExitCode)
}
Write-Output '--- STDERR head 12 ---'
if (Test-Path $errF) { Get-Content $errF -TotalCount 12 }
Write-Output '--- STDOUT head 12 ---'
if (Test-Path $outF) { Get-Content $outF -TotalCount 12 }
Write-Output '--- PORT 18999 LISTEN CHECK ---'
$l = Get-NetTCPConnection -LocalPort 18999 -State Listen -ErrorAction SilentlyContinue
if ($l) { Write-Output ('LISTENING ON ' + $l[0].LocalAddress) } else { Write-Output 'NOT LISTENING (good)' }
Remove-Item $errF, $outF -Force -ErrorAction SilentlyContinue
