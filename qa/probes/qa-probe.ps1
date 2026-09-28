$ErrorActionPreference = 'Continue'
# NOTE: this file MUST stay ASCII-only and without UTF-8 BOM.
# Windows PowerShell 5.1 reads a BOM-less file as GBK; non-ASCII bytes then corrupt
# tokenization and can silently swallow line breaks (proved on a real VM), which makes
# the `kill` branch below merge into a comment line and report KILLED_PSBRIDGE=none.
#
# Usage: powershell -File qa-probe.ps1 [kill]
#   (no args) report ps-bridge instance count / vm-service node process / port owner
#   kill      additionally force-kill one ps-bridge instance (A3 self-heal check)
$kill = $args.Count -gt 0 -and $args[0] -eq 'kill'

$bridges = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*ps-bridge.ps1*' })
Write-Output ("PSBRIDGE_COUNT=" + $bridges.Count)
foreach ($b in $bridges) { Write-Output ("  PSBRIDGE PID=" + $b.ProcessId + " PPID=" + $b.ParentProcessId + " START=" + $b.CreationDate) }

$svc = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*vm-service*dist*cli.js*' })
Write-Output ("SERVICE_COUNT=" + $svc.Count)
foreach ($s in $svc) { Write-Output ("  SERVICE PID=" + $s.ProcessId + " START=" + $s.CreationDate) }

$owner = (Get-NetTCPConnection -LocalPort 18443 -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
Write-Output ("PORT_18443_OWNER=" + $owner)

if ($kill) {
  if ($bridges.Count -gt 0) {
    $victim = $bridges[0].ProcessId
    Stop-Process -Id $victim -Force -ErrorAction SilentlyContinue
    Write-Output ("KILLED_PSBRIDGE=" + $victim)
  } else {
    Write-Output "KILLED_PSBRIDGE=none"
  }
}
