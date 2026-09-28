$ErrorActionPreference = 'Continue'
$repoSkills = 'C:/WinVMBridge/skills'
$shared = 'C:/WinVMBridge/shared-skills'

Write-Output '=== BEFORE: shared-skills file list ==='
if (Test-Path $shared) {
  Get-ChildItem -Recurse -File $shared | ForEach-Object { Write-Output ('  ' + $_.FullName.Substring($shared.Length).TrimStart('\')) }
} else {
  Write-Output '  (shared-skills 不存在)'
}

Write-Output '=== EXTRACT skills.tar -> C:/WinVMBridge ==='
Push-Location 'C:/WinVMBridge'
& tar --force-local -xf 'skills.tar'
Write-Output ('skills_extract_exit=' + $LASTEXITCODE)
Pop-Location

Write-Output '=== MERGE repo skills -> shared-skills (no purge) ==='
if (-not (Test-Path $shared)) { New-Item -ItemType Directory -Path $shared | Out-Null }
Copy-Item -Path (Join-Path $repoSkills '*') -Destination $shared -Recurse -Force
Write-Output 'copy done'

Write-Output '=== AFTER: md5 (repo skills vs shared-skills) ==='
foreach ($rel in @('winvm-orchestrator/SKILL.md','winvm-mcp-reference/SKILL.md','winvm-storage-manager/SKILL.md')) {
  $a = (Get-FileHash (Join-Path $repoSkills $rel) -Algorithm MD5).Hash.ToLower()
  $b = (Get-FileHash (Join-Path $shared $rel) -Algorithm MD5).Hash.ToLower()
  Write-Output ('  repo=' + $a + '  shared=' + $b + '  match=' + ($a -eq $b) + '  ' + $rel)
}
Write-Output ('shared-skills file count = ' + (Get-ChildItem -Recurse -File $shared | Measure-Object).Count)
