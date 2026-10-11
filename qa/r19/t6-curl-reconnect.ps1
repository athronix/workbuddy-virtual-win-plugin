$ErrorActionPreference='Continue'
# P2-T6 E2E evidence E1b: VM-INITIATED credentialed reconnect to the loopback /mcp.
# Runs inside the VM (Git Bash invokes powershell -File). ASCII-only output.
# Three sub-probes, all POST an id-bearing initialize (zero-side-effect sample):
#   NOAUTH  : no Authorization header   => expect 401 (guard really denying)
#   WRONGAUTH: bearer wrong value       => expect 401 (no rubber-stamp)
#   RIGHTAUTH: bearer = task env value  => expect 200 (the T6 channel works end-to-end)
$envName = 'WINVM_BEARER_TOKEN'
# Read the token the way the CLI child process sees it: from the service process env.
# The task runs start-hidden.ps1 which assigns $env:<name>; powershell -File inherits
# interactive-session env, NOT the task's. So read the generated ps1 line and extract value.
$ps1 = Get-Content 'C:/WinVMBridge/delivery/.generated/start-hidden.ps1' -Raw
$m = [regex]::Match($ps1, "\`$env:$envName\s*=\s*'([^']*)'")
if (-not $m.Success) { 'FATAL: env assignment line not found in start-hidden.ps1'; exit 1 }
$token = $m.Groups[1].Value
"value_source=start-hidden.ps1 line; tokenLen=" + $token.Length

$body = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t6-vmcurl-probe","version":"1.0.0"}}}'
$url = 'http://127.0.0.1:18443/mcp?dtid=t6vmcurl'

function Probe($label, $headers) {
  try {
    $r = Invoke-WebRequest -Uri $url -Method Post -ContentType 'application/json' -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 20
    $code = $r.StatusCode
    $snippet = ($r.Content -replace '\s+', ' ').Substring(0, [Math]::Min(160, ($r.Content -replace '\s+', ' ').Length))
  } catch {
    $resp = $_.Exception.Response
    if ($resp -ne $null) { $code = [int]$resp.StatusCode } else { $code = 'ERR:' + $_.Exception.Message }
    $snippet = ''
  }
  $label + ' => HTTP ' + $code + ' | ' + $snippet
}

Probe 'NOAUTH' @{ 'accept' = 'application/json, text/event-stream' }
Probe 'WRONGAUTH' @{ 'accept' = 'application/json, text/event-stream'; 'authorization' = 'Bearer deliberately-wrong-token' }
Probe 'RIGHTAUTH' @{ 'accept' = 'application/json, text/event-stream'; 'authorization' = ('Bearer ' + $token) }
# health is exempt (must be reachable without creds even when enforced) - proves exemption surface intact
try {
  $h = Invoke-WebRequest -Uri 'http://127.0.0.1:18443/health' -Method Get -UseBasicParsing -TimeoutSec 20
  'HEALTH_NOAUTH => HTTP ' + $h.StatusCode
} catch { 'HEALTH_NOAUTH => ERR ' + $_.Exception.Message }
