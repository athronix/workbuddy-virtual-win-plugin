$out = 'C:\WinVMWorkspace\v20chain.txt'
$res = New-Object System.Collections.Generic.List[string]
$roots = @(
  'C:\Users\User\AppData\Local\WinVMBridge',
  'C:\WinVMBridge',
  'C:\WinVMWorkspace'
)
foreach ($r in $roots) {
  if (Test-Path -LiteralPath $r) {
    $res.Add('### ROOT ' + $r)
    Get-ChildItem -LiteralPath $r -Directory -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'audit|chain|ledger' } |
      ForEach-Object { $res.Add('DIR|' + $_.FullName) }
    Get-ChildItem -LiteralPath $r -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'audit|chain' } |
      Sort-Object -Property LastWriteTime -Descending |
      Select-Object -First 25 |
      ForEach-Object { $res.Add('FILE|' + $_.FullName + '|' + $_.LastWriteTime.ToString('o') + '|' + $_.Length) }
  }
}
[IO.File]::WriteAllText($out, ($res -join "`n"), (New-Object Text.UTF8Encoding($false)))
'WROTE ' + $out
