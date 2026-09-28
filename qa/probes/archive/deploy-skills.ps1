$ErrorActionPreference = 'Continue'
Write-Output '=== BEFORE ==='
Get-FileHash C:/WinVMBridge/skills/winvm-orchestrator/SKILL.md -Algorithm MD5 | ForEach-Object { 'OLD ' + $_.Hash.ToLower() }
Push-Location 'C:/WinVMBridge'
& tar --force-local -xf 'skills.tar'
Write-Output ('skills_extract_exit=' + $LASTEXITCODE)
Pop-Location
Write-Output '=== AFTER ==='
Get-FileHash C:/WinVMBridge/skills/winvm-orchestrator/SKILL.md,C:/WinVMBridge/skills/winvm-orchestrator/approval-card.md,C:/WinVMBridge/skills/winvm-mcp-reference/SKILL.md,C:/WinVMBridge/skills/winvm-mcp-reference/mcps-reference.md -Algorithm MD5 |
  ForEach-Object { $_.Hash.ToLower() + '  ' + $_.Path }
Write-Output ('FILE_COUNT=' + (Get-ChildItem -Recurse -File C:/WinVMBridge/skills | Measure-Object).Count)
