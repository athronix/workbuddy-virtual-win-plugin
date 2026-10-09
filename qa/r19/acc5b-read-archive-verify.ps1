# ACC-5b: read latest chain-archive-verify audit entry from VM audit dir (ASCII only)
$dir = Join-Path $env:LOCALAPPDATA 'WinVMBridge\audit'
$files = Get-ChildItem $dir -Filter *.jsonl | Sort-Object LastWriteTime -Descending
if (-not $files) { Write-Output 'NO AUDIT FILES'; exit 0 }
$latest = $files[0]
Write-Output ("LATEST=" + $latest.Name + " SIZE=" + $latest.Length)
# tail 500 lines, filter the two T4 kinds
$tail = Get-Content $latest.FullName -Tail 500
$cav = @($tail | Select-String -Pattern 'chain-archive-verify')
$adv = @($tail | Select-String -Pattern 'approval-decision')
Write-Output ("ARCHIVE_VERIFY_HITS=" + $cav.Count)
if ($cav.Count -gt 0) {
  $line = $cav[-1].Line
  Write-Output ("CAV_RAW=" + $line.Substring(0, [Math]::Min(600, $line.Length)))
}
Write-Output ("APPROVAL_DECISION_HITS=" + $adv.Count)
foreach ($m in $adv) {
  $l = $m.Line
  Write-Output ("ADV_RAW=" + $l.Substring(0, [Math]::Min(400, $l.Length)))
}
# count all shards on disk for cross-check with entry's shardsTotal
$shards = @(Get-ChildItem $dir -Filter *.jsonl).Count
Write-Output ("SHARD_FILES_ON_DISK=" + $shards)
