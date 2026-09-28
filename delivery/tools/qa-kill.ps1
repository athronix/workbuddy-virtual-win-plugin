$ErrorActionPreference = 'Continue'
$b = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*ps-bridge.ps1*' })
Write-Output ("BEFORE_COUNT=" + $b.Count)
foreach ($x in $b) { Write-Output ("  BEFORE PID=" + $x.ProcessId + " PPID=" + $x.ParentProcessId) }
if ($b.Count -gt 0) {
  $victim = $b[0].ProcessId
  Stop-Process -Id $victim -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  Write-Output ("KILLED=" + $victim)
} else {
  Write-Output "KILLED=none"
}
$a = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*ps-bridge.ps1*' })
Write-Output ("AFTER_KILL_COUNT=" + $a.Count)
foreach ($x in $a) { Write-Output ("  AFTER PID=" + $x.ProcessId + " PPID=" + $x.ParentProcessId) }
