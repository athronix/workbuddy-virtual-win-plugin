$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:18443'

# 1) trigger one capability call -> one audit record (full chain: audit.append -> shard file)
try {
  $body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"meta.health.check","arguments":{}}}'
  $r = Invoke-RestMethod -Uri "$base/mcp" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 20
  Write-Output ('CALL_OK=' + ($r.result.isError -eq $false))
} catch {
  Write-Output ('CALL_FAIL=' + $_.Exception.Message)
}

# 2) list audit shards (fresh-chain new shard should coexist with archived history)
$dir = Join-Path $env:LOCALAPPDATA 'WinVMBridge\audit'
Get-ChildItem $dir | Sort-Object Name | ForEach-Object { Write-Output ('SHARD ' + $_.Name + ' size=' + $_.Length) }

# 3) /health recheck
$h = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 8
Write-Output ('HEALTH ok=' + $h.ok + ' audit.entries=' + $h.audit.entries + ' chainValid=' + $h.audit.chainValid + ' restarts=' + $h.psBridge.restarts)
