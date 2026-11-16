$ErrorActionPreference = 'SilentlyContinue'
# PS5.1 encodes redirected stdout with the console codepage (GBK on zh-CN VM) ->
# non-ASCII fields garble JSON for UTF-8 consumers. Force UTF-8 console output.
$prevOc = $null
try { $prevOc = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$out = [ordered]@{}
# v1.9.1 perf (e2e5 audit): Get-ScheduledTask is CIM-backed and does a full task
# enumeration on first module import (measured 20-35s). `schtasks /query /fo CSV`
# has NO field names, so field POSITION is language-independent (zh-CN status text
# and en "Ready" both land in column 3). Keep this file ASCII-only.
$csv = @(schtasks /query /tn 'WinVMBridge.Service' /fo CSV /nh 2>$null)
if ($LASTEXITCODE -eq 0 -and $csv.Count -gt 0) {
  $cells = ($csv[0] -split '","')
  $out.task_state = if ($cells.Count -ge 3) { ($cells[2] -replace '"', '').Trim() } else { 'UNKNOWN' }
} else { $out.task_state = 'NOT_FOUND' }
# Get-NetTCPConnection is CIM-backed (3-8s); .NET GetActiveTcpListeners() is
# millisecond-level and already returns only listening sockets (same semantics).
$lis = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq 18443 })
$out.listen_addr = if ($lis.Count -gt 0) { [string]$lis[0].Address } else { 'NONE' }
$out.listen_count = $lis.Count
$out.side_json = Test-Path 'C:\Users\User\.workbuddy\winvm\side.json'
$out.bridge_dir = Test-Path 'C:\WinVMBridge'
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18443/health' -UseBasicParsing -TimeoutSec 5
  $out.health_http = [int]$r.StatusCode
  # PS5.1 decodes charset-less application/json $r.Content as GBK -> Chinese detail
  # fields become invalid bytes and break downstream JSON parsing (found 2026-10-29
  # loop run3). Read raw bytes and decode UTF-8 explicitly. Keep this file ASCII-only.
  # v1.9.1 perf: the full body is several KB and was only ever echoed into logs;
  # a 200-char prefix keeps "ok"/provider/session visible without the bulk.
  $body = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
  $out.health_body = if ($body.Length -gt 200) { $body.Substring(0, 200) } else { $body }
} catch {
  $out.health_http = 'ERR'
  $out.health_body = $_.Exception.Message
}
$out | ConvertTo-Json -Compress
