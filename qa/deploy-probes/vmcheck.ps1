$ErrorActionPreference = 'SilentlyContinue'
# PS5.1 encodes redirected stdout with the console codepage (GBK on zh-CN VM) ->
# non-ASCII fields garble JSON for UTF-8 consumers. Force UTF-8 console output.
$prevOc = $null
try { $prevOc = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
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
  # PS5.1 decodes charset-less application/json $r.Content as GBK -> Chinese detail
  # fields become invalid bytes and break downstream JSON parsing (found 2026-10-29
  # loop run3). Read raw bytes and decode UTF-8 explicitly. Keep this file ASCII-only.
  $out.health_body = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
} catch {
  $out.health_http = 'ERR'
  $out.health_body = $_.Exception.Message
}
$out | ConvertTo-Json -Compress
