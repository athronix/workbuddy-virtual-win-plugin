# P2-T5 refuse-path readback: no listener / no node / no orphan ps-bridge + chain entry with refused=true.
$ErrorActionPreference = 'Continue'
Write-Output ('LISTEN_18443=' + ((Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count))
Write-Output ('NODE_PROCS=' + ((Get-Process node -ErrorAction SilentlyContinue | Measure-Object).Count))
$orphan = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*ps-bridge.ps1*' })
Write-Output ('ORPHAN_PSBRIDGE=' + $orphan.Count)

$d = Join-Path $env:LOCALAPPDATA 'WinVMBridge\audit'
$active = Get-ChildItem $d -Filter '*.jsonl' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Output ('ACTIVE=' + $active.Name + ' size=' + $active.Length)
Write-Output '=== LAST 6 ENTRIES ==='
Get-Content $active.FullName -Tail 6 | ForEach-Object {
  $o = $null
  try { $o = $_ | ConvertFrom-Json } catch { }
  if ($o) {
    $rule = ''
    if ($o.policyDecision) { $rule = [string]$o.policyDecision.matchedRule }
    $refused = ''
    if ($o.ext) { $refused = [string]$o.ext.refused }
    $inner = ''
    if ($o.ext -and $o.ext.innerReconnect) { $inner = [string]$o.ext.innerReconnect.status }
    $sc = ''
    if ($o.ext -and $o.ext.selfCheck) { $sc = [string]$o.ext.selfCheck.code }
    $auth = ''
    if ($o.ext) { $auth = [string]$o.ext.authMode }
    Write-Output ('seq=' + $o.seq + ' ts=' + $o.ts + ' rule=' + $rule + ' result.ok=' + $o.result.ok + ' refused=' + $refused + ' inner=' + $inner + ' selfCheck=' + $sc + ' authMode=' + $auth)
  } else {
    Write-Output ('RAW: ' + $_.Substring(0, [Math]::Min(120, $_.Length)))
  }
}
Write-Output '=== READBACK_DONE ==='
