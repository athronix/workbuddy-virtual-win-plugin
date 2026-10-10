# P2-T5 real-machine probe: read the bearer-selfcheck chain entry + tail the active audit shard.
# ASCII-only payload (VM remote shell = Git Bash; non-ASCII in inline -Command gets mangled).
$ErrorActionPreference = 'Stop'
$d = Join-Path $env:LOCALAPPDATA 'WinVMBridge\audit'
Write-Output '=== AUDIT DIR (newest 5) ==='
Get-ChildItem $d | Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200

$active = Get-ChildItem $d -Filter '*.jsonl' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Output ('ACTIVE=' + $active.FullName)
Write-Output '=== LAST 6 ENTRIES (compact: kind/capability/matchedRule/ok) ==='
Get-Content $active.FullName -Tail 6 | ForEach-Object {
  try {
    $o = $_ | ConvertFrom-Json
    $kind = ''
    if ($o.ext -and $o.ext.kind) { $kind = $o.ext.kind }
    $rule = ''
    if ($o.policyDecision -and $o.policyDecision.matchedRule) { $rule = $o.policyDecision.matchedRule }
    $okv = ''
    if ($null -ne $o.result.ok) { $okv = $o.result.ok }
    Write-Output ('seq=' + $o.seq + ' ts=' + $o.ts + ' cap=' + $o.capabilityId + ' kind=' + $kind + ' rule=' + $rule + ' result.ok=' + $okv)
  } catch {
    Write-Output ('RAW(line parse fail): ' + $_.Exception.Message)
  }
}

Write-Output '=== BEARER-SELFCHECK ENTRIES (grep whole active shard) ==='
$hits = Select-String -Path $active.FullName -Pattern 'bearer-selfcheck' -SimpleMatch
if (-not $hits) { Write-Output 'NONE-ON-ACTIVE-SHARD' } else {
  $hits | ForEach-Object {
    $o = $_.Line | ConvertFrom-Json
    Write-Output '--- entry (full) ---'
    Write-Output ($o | ConvertTo-Json -Depth 6 -Compress)
  }
}
Write-Output '=== PROBE_DONE ==='
