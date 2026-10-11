$ErrorActionPreference = 'Continue'
# P2-T6 E2 inner-reconnect probe (run ON THE VM, pushed via scp + powershell -File).
# Proves the VM-side inner reconnect to /mcp with the bearer credential returns 200
# (and WITHOUT the credential returns 401) -- the exact shape the CLI subprocess does.
$out = 'C:/WinVMWorkspace/t6probe/e2-inner.txt'
New-Item -ItemType Directory -Force -Path 'C:/WinVMWorkspace/t6probe' | Out-Null
Remove-Item $out -ErrorAction SilentlyContinue

$body = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"winvm-t6-e2","version":"1.0.0"}}}'
Set-Content -Path 'C:/WinVMWorkspace/t6probe/e2-body.json' -Value $body -Encoding ASCII

# token read from the SAME env the service process got (start-hidden.ps1 assignment)
$tok = $env:WINVM_BEARER_TOKEN
if (-not $tok) { "NO_TOKEN_IN_THIS_SHELL (expected: ssh shell has no env; reading from ps1 file)" | Add-Content $out }

# Fallback: extract the value from the generated launcher (authoritative source).
if (-not $tok) {
  $line = Select-String -Path 'C:/WinVMBridge/delivery/.generated/start-hidden.ps1' -Pattern '^\$env:WINVM_BEARER_TOKEN\s*=' | Select-Object -First 1
  if ($line) {
    $tok = ($line.Line -replace "^\`$env:WINVM_BEARER_TOKEN\s*=\s*'", '') -replace "'$", ''
    "TOKEN_FROM_PS1 len=" + $tok.Length | Add-Content $out
  }
}

$hdr = @{ 'Content-Type' = 'application/json'; 'Accept' = 'application/json, text/event-stream' }

# 1) WITHOUT credential -> must be 401 (guard really in force)
try {
  $r1 = Invoke-WebRequest -Uri 'http://127.0.0.1:18443/mcp?dtid=t6e2nobody' -Method Post -Headers $hdr -Body $body -UseBasicParsing -TimeoutSec 20
  "NOAUTH_STATUS=" + $r1.StatusCode | Add-Content $out
} catch {
  "NOAUTH_STATUS=" + $_.Exception.Response.StatusCode.value__ | Add-Content $out
}

# 2) WITH credential -> must be 200 (inner reconnect end-to-end works)
if ($tok) {
  $hdr2 = @{ 'Content-Type' = 'application/json'; 'Accept' = 'application/json, text/event-stream'; 'Authorization' = 'Bearer ' + $tok }
  try {
    $r2 = Invoke-WebRequest -Uri 'http://127.0.0.1:18443/mcp?dtid=t6e2authed' -Method Post -Headers $hdr2 -Body $body -UseBasicParsing -TimeoutSec 20
    "AUTHED_STATUS=" + $r2.StatusCode | Add-Content $out
    "AUTHED_BODY=" + ($r2.Content -replace '\s+', ' ').Substring(0, [Math]::Min(300, $r2.Content.Length)) | Add-Content $out
  } catch {
    "AUTHED_STATUS=" + $_.Exception.Response.StatusCode.value__ | Add-Content $out
  }
  # 3) WRONG credential -> must be 401 (proof the 200 above came from the token, not from the guard being off)
  $hdr3 = @{ 'Content-Type' = 'application/json'; 'Accept' = 'application/json, text/event-stream'; 'Authorization' = 'Bearer wrong-token-zzz' }
  try {
    $r3 = Invoke-WebRequest -Uri 'http://127.0.0.1:18443/mcp?dtid=t6e2wrong' -Method Post -Headers $hdr3 -Body $body -UseBasicParsing -TimeoutSec 20
    "WRONG_STATUS=" + $r3.StatusCode | Add-Content $out
  } catch {
    "WRONG_STATUS=" + $_.Exception.Response.StatusCode.value__ | Add-Content $out
  }
} else {
  "NO_TOKEN_AVAILABLE - authed probe skipped" | Add-Content $out
}
"---HEALTH-VIA-VM-LOCALHOST---" | Add-Content $out
try {
  $h = Invoke-WebRequest -Uri 'http://127.0.0.1:18443/health' -UseBasicParsing -TimeoutSec 20
  $hj = $h.Content | ConvertFrom-Json
  "authMode=" + $hj.security.authMode | Add-Content $out
  "innerReconnect=" + $hj.security.innerReconnect.status | Add-Content $out
  "selfCheck=" + $hj.security.bearerSelfCheck.code | Add-Content $out
} catch {
  "HEALTH_ERR=" + $_.Exception.Message | Add-Content $out
}
Get-Content $out
"E2_DONE"
