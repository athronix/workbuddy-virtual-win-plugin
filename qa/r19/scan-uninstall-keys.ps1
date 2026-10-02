# R19 QA read-only registry scan: uninstall keys classification (NSIS vs MSI vs other)
$roots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {
  $u = if ($_.UninstallString) { $_.UninstallString } else { '' }
  $q = if ($_.QuietUninstallString) { $_.QuietUninstallString } else { '' }
  $type = 'other'
  if ($u -match 'msiexec') { $type = 'msi' }
  elseif ($u -match 'unins.*\.exe|Uninstall\.exe' -and $q -eq '') { $type = 'nsis' }
  $il = if ($_.InstallLocation) { $_.InstallLocation } else { '' }
  '{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}' -f $type, $_.DisplayName, $_.PSChildName, $u, $q, $il, $_.DisplayVersion
} | Sort-Object
