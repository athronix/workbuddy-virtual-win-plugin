$dir = 'C:\Users\User\AppData\Local\WinVMBridge\logs'
$out = 'C:\WinVMWorkspace\v20log.txt'
$res = New-Object System.Collections.Generic.List[string]
if (Test-Path -LiteralPath $dir) {
  $files = Get-ChildItem -LiteralPath $dir -File -Recurse | Sort-Object -Property LastWriteTime -Descending | Select-Object -First 8
  foreach ($f in $files) {
    $res.Add('### FILE ' + $f.FullName + ' mtime=' + $f.LastWriteTime.ToString('o'))
    try {
      $tail = Get-Content -LiteralPath $f.FullName -Tail 500 -ErrorAction Stop
      foreach ($ln in $tail) {
        if ($ln -match '1dfb694a|apr_4e8eea|apr_fa5561|PROVIDER_UNAVAILABLE|EXECUTION_FAILED|degrade|LLM_PERSISTENT|LLM_RUNTIME|NO_EXECUTION_RECEIPT') {
          $res.Add($ln)
        }
      }
    } catch {
      $res.Add('### READ-ERR ' + $_.Exception.Message)
    }
  }
} else {
  $res.Add('### NO-LOG-DIR ' + $dir)
}
$txt = ($res -join "`n")
[IO.File]::WriteAllText($out, $txt, (New-Object Text.UTF8Encoding($false)))
'WROTE ' + $out + ' bytes=' + $txt.Length
