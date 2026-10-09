# ACC-34: read chain evidence for canceled task 479e... and rejected task 64597... + approval-decision entries
$dir = Join-Path $env:LOCALAPPDATA 'WinVMBridge\audit'
$files = Get-ChildItem $dir -Filter *.jsonl | Sort-Object LastWriteTime -Descending
function Cut($s, $n) { if ($s.Length -gt $n) { return $s.Substring(0, $n) } ; return $s }
$cancelId = '479e8eab-dda4-4b3f-bdb6-0f6d75f577ab'
$rejectId = '64597dfe-872f-4486-a98e-63faf67f861f'
foreach ($f in $files[0..1]) {
  Write-Output ('== FILE=' + $f.Name)
  $m1 = @(Select-String -Path $f.FullName -SimpleMatch -Pattern $cancelId)
  Write-Output ('CANCEL_TASK_HITS=' + $m1.Count)
  foreach ($x in $m1) { Write-Output ('E1=' + (Cut $x.Line 700)) }
  $m2 = @(Select-String -Path $f.FullName -SimpleMatch -Pattern $rejectId)
  Write-Output ('REJECT_TASK_HITS=' + $m2.Count)
  foreach ($x in $m2) { Write-Output ('E2=' + (Cut $x.Line 700)) }
  $m3 = @(Select-String -Path $f.FullName -Pattern 'approval-decision')
  Write-Output ('APPROVAL_DECISION_HITS=' + $m3.Count)
  foreach ($x in $m3) { Write-Output ('E3=' + (Cut $x.Line 700)) }
}
Write-Output 'ALL-DONE'
