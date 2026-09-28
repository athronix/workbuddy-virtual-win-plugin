$ErrorActionPreference = 'Continue'
# ASCII only, no BOM. Observe-only: never touches the running service.
Write-Output ("NOW=" + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))

$listen = @(Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue)
if ($listen.Count -gt 0) {
  foreach ($c in $listen) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    Write-Output ("LISTEN pid=" + $c.OwningProcess + " name=" + $p.ProcessName + " start=" + $p.StartTime)
  }
} else {
  Write-Output 'LISTEN=NONE'
}

$svc = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -and $_.CommandLine -like '*vm-service*' })
Write-Output ("VMSERVICE_COUNT=" + $svc.Count)
foreach ($s in $svc) { Write-Output ("  VMSERVICE PID=" + $s.ProcessId + " PPID=" + $s.ParentProcessId) }

$br = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*ps-bridge.ps1*' })
Write-Output ("PSBRIDGE_COUNT=" + $br.Count)

$ps = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like '*deploy*' -or $_.CommandLine -like '*install-vm*') })
Write-Output ("DEPLOY_PS_COUNT=" + $ps.Count)
foreach ($d in $ps) { Write-Output ("  DEPLOY PID=" + $d.ProcessId + " CMD=" + $d.CommandLine.Substring(0, [Math]::Min(150, $d.CommandLine.Length))) }
