$p = 'C:\Users\User\AppData\Local\WinVMBridge\audit\audit-20261016-2.jsonl'
$out = 'C:\WinVMWorkspace\v20entry.txt'
$enc = New-Object Text.UTF8Encoding($false)
$lines = [IO.File]::ReadAllLines($p, $enc)
$hit = New-Object System.Collections.Generic.List[string]
for ($i = 0; $i -lt $lines.Count; $i++) {
  $ln = $lines[$i]
  if ($ln.Length -lt 5) { continue }
  if ($ln -match 'tr_mvb6vtsx_4-replay|tr_mvb6ss9l_3-replay') {
    $hit.Add('IDX=' + $i + ' ' + $ln)
  }
}
[IO.File]::WriteAllText($out, ($hit -join "`n"), $enc)
'WROTE ' + $out + ' total=' + $lines.Count + ' hits=' + $hit.Count
