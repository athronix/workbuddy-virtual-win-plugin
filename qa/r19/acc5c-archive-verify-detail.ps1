# ACC-5c: full fields of latest chain-archive-verify entry (nested audit schema, ASCII only)
$dir = Join-Path $env:LOCALAPPDATA 'WinVMBridge\audit'
$files = Get-ChildItem $dir -Filter *.jsonl | Sort-Object LastWriteTime -Descending
$latest = $files[0]
$tail = Get-Content $latest.FullName -Tail 500
$cav = @($tail | Select-String -Pattern 'chain-archive-verify')
Write-Output ("FILE=" + $latest.Name + " HITS=" + $cav.Count)
if ($cav.Count -gt 0) {
  $j = $cav[-1].Line | ConvertFrom-Json
  Write-Output ("auditId=" + $j.auditId)
  Write-Output ("capabilityId=" + $j.capabilityId)
  Write-Output ("risk=" + $j.risk)
  Write-Output ("channel=" + $j.principal.channel)
  Write-Output ("matchedRule=" + $j.policyDecision.matchedRule)
  Write-Output ("allowed=" + $j.policyDecision.allowed)
  Write-Output ("resultOk=" + $j.result.ok)
  Write-Output ("errorCode=" + $j.result.errorCode)
  Write-Output ("kind=" + $j.ext.kind)
  Write-Output ("shardsVerified=" + $j.ext.archive.shardsVerified)
  Write-Output ("shardsTotal=" + $j.ext.archive.shardsTotal)
  Write-Output ("notVerifiedParam=" + $j.params.shardsTotal + "/" + $j.params.shardsVerified + "/" + $j.params.notVerified)
  $broken = @($j.ext.archive.broken)
  Write-Output ("BROKEN_COUNT=" + $broken.Count)
  foreach ($b in $broken) {
    if ($b -is [string]) { Write-Output ("BROKEN=" + $b) }
    else { Write-Output ("BROKEN_NAME=" + $b.shard + " REASON=" + $b.reason + " AT=" + $b.brokenAt) }
  }
}
