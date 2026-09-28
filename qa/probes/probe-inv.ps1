$paths = @(
 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
$total = 0
foreach ($p in $paths) {
  if (Test-Path $p) {
    $items = Get-ChildItem $p -ErrorAction SilentlyContinue
    $withName = @($items | ForEach-Object { $v = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($v.DisplayName) { $v.DisplayName } })
    Write-Output ("PATH " + $p + " children=" + @($items).Count + " withDisplayName=" + $withName.Count)
    $withName | ForEach-Object { Write-Output ("   - " + $_) }
    $total += $withName.Count
  } else { Write-Output ("PATH " + $p + " NOT_EXIST") }
}
Write-Output ("TOTAL_WITH_DISPLAYNAME=" + $total)
