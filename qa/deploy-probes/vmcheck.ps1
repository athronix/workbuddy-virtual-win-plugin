$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}
$t = Get-ScheduledTask -TaskName 'WinVMBridge.Service'
$out.task_state = if ($t) { [string]$t.State } else { 'NOT_FOUND' }
$c = Get-NetTCPConnection -LocalPort 18443 -State Listen
$out.listen_addr = if ($c) { [string]$c[0].LocalAddress } else { 'NONE' }
$out.listen_count = @($c).Count
$out.side_json = Test-Path 'C:\Users\User\.workbuddy\winvm\side.json'
$out.bridge_dir = Test-Path 'C:\WinVMBridge'
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18443/health' -UseBasicParsing -TimeoutSec 10
  $out.health_http = [int]$r.StatusCode
  $out.health_body = $r.Content
} catch {
  $out.health_http = 'ERR'
  $out.health_body = $_.Exception.Message
}
$out | ConvertTo-Json -Compress
