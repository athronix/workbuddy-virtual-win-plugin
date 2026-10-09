$dir = "C:\Users\User\AppData\Local\WinVMBridge\audit"
$files = Get-ChildItem $dir -Filter "audit-20261009*.jsonl" | Sort-Object Name
Write-Output ("SHARDS=" + ($files | Measure-Object).Count)
foreach ($f in $files) {
  $hits = Select-String -Path $f.FullName -Pattern "cde70b18" -SimpleMatch
  foreach ($h in $hits) {
    $line = $h.Line
    if ($line.Length -gt 700) { $line = $line.Substring(0,700) }
    Write-Output ("FILE=" + $f.Name + " :: " + $line)
  }
}
