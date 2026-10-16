$dir = 'C:\Users\User\AppData\Local\WinVMBridge\logs'
$out = 'C:\WinVMWorkspace\v20log2.txt'
$res = New-Object System.Collections.Generic.List[string]
$files = Get-ChildItem -LiteralPath $dir -File -Recurse | Sort-Object -Property LastWriteTime -Descending
foreach ($f in $files) {
  $res.Add('FILE|' + $f.FullName + '|mtime=' + $f.LastWriteTime.ToString('o') + '|bytes=' + $f.Length)
}
$res.Add('=== TAIL OF NEWEST 3 ===')
foreach ($f in ($files | Select-Object -First 3)) {
  $res.Add('--- ' + $f.Name)
  $enc = New-Object Text.UTF8Encoding($false)
  $tail = [IO.File]::ReadAllLines($f.FullName, $enc) | Select-Object -Last 120
  foreach ($ln in $tail) { $res.Add($ln) }
}
[IO.File]::WriteAllText($out, ($res -join "`n"), (New-Object Text.UTF8Encoding($false)))
'WROTE ' + $out
