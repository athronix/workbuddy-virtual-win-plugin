<#
  WINVM PREPARE - VM-side environment prerequisite (idempotent)

  Owner: this repository (single source of truth: tools/winvm-prepare.ps1).
  Consumer: the deployment helper app "KaiDaShi" K2 button, pushed through its
  existing VM software installation / PowerShell channel. Do NOT fork this
  script inside the app (single source of truth rule).

  Run location: ELEVATED PowerShell 5.1+ inside the Windows VM.
  Encoding contract: ASCII-only source + CRLF line endings (PS 5.1 reads
  BOM-less UTF-8 through the ANSI codepage; non-ASCII corrupts). Enforced by
  tests/unit/winvm-prepare-ps1.test.js.

  Idempotency rule: every step probes before acting; re-running is safe.
  Output contract: one KEY=VALUE line per item for the app to parse:
    ADMIN, SSHD_STATE, SSHD_STARTMODE, FW_SSH, NODE,
    PUBKEY_USER_AK, PUBKEY_ADMIN_AK, PREPARE_DONE
  Q-3 rule: every key is ALWAYS emitted, even when its feature is skipped
  (value=SKIPPED) - the app parser must never guess defaults for missing keys.

  Judgment parity: steps DB-1 / DB-2 / DB-3 mirror delivery/prepare-vm.mjs
  (buildPrepareVmApplyPs1); step 4 mirrors delivery/bootstrap.mjs trust
  (two-file key injection + icacls ACL tightening).
#>
[CmdletBinding()]
param(
  [string]$PubKey = '',
  [int]$SshPort = 22
)

$ErrorActionPreference = 'Continue'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output ('ADMIN=' + $isAdmin)
Write-Output ('SSH_PORT=' + $SshPort)

# ---------- 1) sshd: install if missing -> Automatic -> Running ----------
$fwName = 'WinVM-SSH-' + $SshPort
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshd) {
  if ($isAdmin) {
    Write-Output '[1/4] sshd missing; Add-WindowsCapability OpenSSH.Server (first install may need a reboot)...'
    try {
      Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction Stop | Out-Null
      $sshd = Get-Service sshd -ErrorAction SilentlyContinue
    } catch {
      Write-Output ('[1/4] ADD_CAPABILITY_FAILED: ' + $_.Exception.Message)
    }
  } else {
    Write-Output '[1/4][MANUAL] sshd not installed and session is NOT elevated. Run in ELEVATED PowerShell:'
    Write-Output '    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0'
  }
} else {
  Write-Output '[1/4] sshd already installed [SKIP]'
}
if ($isAdmin -and $sshd) {
  $mode = (Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue).StartMode
  if ($mode -ne 'Auto') {
    Set-Service sshd -StartupType Automatic
    Write-Output '[1/4] sshd startup set to Automatic'
  } else {
    Write-Output '[1/4] sshd startup already Automatic [SKIP]'
  }
  $sshd = Get-Service sshd -ErrorAction SilentlyContinue
  if ($sshd -and $sshd.Status -ne 'Running') {
    Start-Service sshd -ErrorAction SilentlyContinue
    Write-Output '[1/4] sshd started'
  } else {
    Write-Output '[1/4] sshd already Running [SKIP]'
  }
}
$sshdFinal = Get-Service sshd -ErrorAction SilentlyContinue
if ($sshdFinal) {
  Write-Output ('SSHD_STATE=' + $sshdFinal.Status)
} else {
  Write-Output 'SSHD_STATE=NOT_INSTALLED'
}
$modeFinal = if ($sshdFinal) { (Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue).StartMode } else { $null }
Write-Output ('SSHD_STARTMODE=' + $(if ($modeFinal -eq 'Auto') { 'Automatic' } elseif ($modeFinal) { $modeFinal } else { 'UNKNOWN' }))

# ---------- 2) firewall: inbound TCP <port>, create only if absent ----------
if ($isAdmin) {
  $rule = Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue
  if ($rule) {
    Write-Output ('[2/4] firewall rule ' + $fwName + ' exists [SKIP]')
    Write-Output 'FW_SSH=True'
  } else {
    New-NetFirewallRule -DisplayName $fwName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $SshPort -Profile Any | Out-Null
    Write-Output ('[2/4] firewall rule ' + $fwName + ' created')
    Write-Output 'FW_SSH=True'
  }
} else {
  # Fail-loud per the output contract: the app shows FW_SSH=False -> fix hint.
  Write-Output '[2/4][MANUAL] not elevated: cannot manage firewall. Run elevated, or import the OpenSSH filter (FW_SSH=False)'
  Write-Output 'FW_SSH=False'
}

# ---------- 3) node >= 18 (VM service runtime), winget silent install if missing ----------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($wingetCmd) {
    Write-Output '[3/4] node missing; winget silent install OpenJS.NodeJS.LTS...'
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --silent 2> $null | Out-Null
    # Refresh PATH for this session from machine/user scopes (no logoff needed)
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  } else {
    Write-Output '[3/4][MANUAL] node missing and winget unavailable: install Node LTS >= 18 manually (msiexec /q or the app software source)'
  }
} else {
  Write-Output '[3/4] node present [SKIP]'
}
if ($nodeCmd) {
  $nodeVersion = ''
  try { $nodeVersion = (& node -v 2> $null) | Out-String | ForEach-Object { $_.Trim() } } catch { }
  Write-Output ('NODE=' + $(if ($nodeVersion) { $nodeVersion } else { 'INSTALLED_PATH_UNRESOLVED' }))
} else {
  Write-Output 'NODE=MISSING'
}

# ---------- 4) pubkey injection (G1: BOTH files + ACL tightening) ----------
# Windows OpenSSH IGNORES the per-user authorized_keys for Administrators-group
# accounts: the key MUST also live in C:\ProgramData\ssh\administrators_authorized_keys,
# owned by SYSTEM, accessible to SYSTEM + Administrators only (broken inheritance).
$akUser = Join-Path (Join-Path $env:USERPROFILE '.ssh') 'authorized_keys'
$akAdmin = 'C:\ProgramData\ssh\administrators_authorized_keys'
if ($PubKey -ne '') {
  $keyLine = $PubKey.Trim()
  if ($keyLine -match "[\r\n']") {
    # Malformed key (quotes/newlines): refuse instead of corrupting both files.
    Write-Output 'PUBKEY_USER_AK=False'
    Write-Output 'PUBKEY_ADMIN_AK=False'
    Write-Output '[4/4] PUBKEY_MALFORMED: PubKey contains quote/newline; injection skipped'
  } else {
    # Per-user authorized_keys (covers standard non-admin VM accounts)
    $dirUser = Split-Path $akUser -Parent
    if (-not (Test-Path $dirUser)) { New-Item -ItemType Directory -Path $dirUser -Force | Out-Null }
    $userLines = @(Get-Content $akUser -ErrorAction SilentlyContinue)
    if ($userLines -notcontains $keyLine) { Add-Content -Path $akUser -Value $keyLine }
    $checkUser = @(Get-Content $akUser -ErrorAction SilentlyContinue)
    Write-Output ('PUBKEY_USER_AK=' + $(if ($checkUser -contains $keyLine) { 'True' } else { 'False' }))
    # administrators_authorized_keys (the ONLY file sshd honors for the
    # Administrators group - pitfall G1) + ACL tightening
    $dirAdmin = Split-Path $akAdmin -Parent
    if (-not (Test-Path $dirAdmin)) { New-Item -ItemType Directory -Path $dirAdmin -Force | Out-Null }
    $adminLines = @(Get-Content $akAdmin -ErrorAction SilentlyContinue)
    if ($adminLines -notcontains $keyLine) { Add-Content -Path $akAdmin -Value $keyLine }
    icacls $akAdmin /inheritance:r /grant 'SYSTEM:F' /grant 'BUILTIN\Administrators:F' 2> $null | Out-Null
    $checkAdmin = @(Get-Content $akAdmin -ErrorAction SilentlyContinue)
    Write-Output ('PUBKEY_ADMIN_AK=' + $(if ($checkAdmin -contains $keyLine) { 'True' } else { 'False' }))
    Write-Output '[4/4] pubkey ensured in both authorized_keys files (icacls tightened on the admin file)'
  }
} else {
  # Q-3: keys always present - SKIPPED is an explicit value, not an absence.
  Write-Output 'PUBKEY_USER_AK=SKIPPED'
  Write-Output 'PUBKEY_ADMIN_AK=SKIPPED'
  Write-Output '[4/4] no -PubKey provided [SKIP]'
}

# ---------- DONE sentinel ----------
Write-Output 'PREPARE_DONE=True'
