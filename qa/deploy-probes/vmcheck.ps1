$ErrorActionPreference = 'SilentlyContinue'
# PS5.1 encodes redirected stdout with the console codepage (GBK on zh-CN VM) ->
# non-ASCII fields garble JSON for UTF-8 consumers. Force UTF-8 console output.
$prevOc = $null
try { $prevOc = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$out = [ordered]@{}
# v1.9.1 perf (e2e5 audit): Get-ScheduledTask is CIM-backed and does a full task
# enumeration on first module import (measured 20-35s). `schtasks /query /fo CSV`
# has NO field names, so we bind positions with -Header: column order is fixed by
# schtasks and therefore language-independent (zh-CN status text and en "Ready"
# both land in column 3). ConvertFrom-Csv handles quoting/commas correctly.
# Keep this file ASCII-only.
$rows = @(schtasks /query /tn 'WinVMBridge.Service' /fo CSV /nh 2>$null |
  ConvertFrom-Csv -Header 'n', 'next', 'status')
if ($LASTEXITCODE -eq 0 -and $rows.Count -gt 0) {
  $out.task_state = [string]$rows[0].status
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
# ---- MCP upstream tool faces (v2.4.0; former step 4d merged into 4c) ----
# The verdict MUST be a real tools/list count. /health.upstreams[] is a lazily
# started observation (always 'idle' right after boot), so asserting on it turns
# "not called yet" into "installed badly" (false red). Conversely "route exists"
# does not mean "upstream usable": a missing upstream answers 502 on that route.
# Here we POST /mcp/<id> on 127.0.0.1 from inside the guest, which also exercises
# the lazy-start path (first desktop call legitimately takes 8-12s).
# Returns an int count, or 'ERR:http-502' / 'ERR:rpc-<code>' / 'ERR:<exception>'.
# Keep this file ASCII-only (ps-run.sh hard-fails on any byte > 127).
function Get-McpToolCount([string]$id) {
  # Why Stop: the script-level $ErrorActionPreference='SilentlyContinue' makes
  # Invoke-WebRequest swallow 4xx/5xx and return $null (no exception thrown), so a
  # 502 would surface as "empty body, parse failed" and we could not tell
  # "upstream not installed" from "route missing".
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Stop'
  $payload = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
  try {
    $r = Invoke-WebRequest -Uri ('http://127.0.0.1:18443/mcp/' + $id) -Method POST -Body $payload `
      -ContentType 'application/json' -Headers @{ 'Accept' = 'application/json, text/event-stream' } `
      -UseBasicParsing -TimeoutSec 60
    $b = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
    # SSE frame tolerance: keep the last data: line only
    if ($b -match '(?m)^data:\s*(\{.*)$') { $b = $Matches[1] }
    $d = $b | ConvertFrom-Json
    if ($d.error) { return ('ERR:rpc-' + $d.error.code) }
    return @($d.result.tools).Count
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($resp) { return ('ERR:http-' + [int]$resp.StatusCode) }
    return 'ERR:http-none'
  } catch {
    return ('ERR:' + $_.Exception.Message)
  } finally {
    $ErrorActionPreference = $prevEap
  }
}
$out.browser_tools = [string](Get-McpToolCount 'browser')
$out.desktop_tools = [string](Get-McpToolCount 'desktop')
$out | ConvertTo-Json -Compress
