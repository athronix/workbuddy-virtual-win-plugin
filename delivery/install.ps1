<#
.SYNOPSIS
  WinVM Bridge - VM side install entry shell (thin wrapper).

.DESCRIPTION
  Purpose: give the VM a native, PowerShell-first entry point, so an operator can
  run the installer without a POSIX shell or a pre-configured node on PATH.

  This is a SHELL, not a reimplementation. All real logic stays in
  delivery/install-vm.mjs. The wrapper only does three things:
    1. locate a usable node (see resolution order below);
    2. verify delivery/install-vm.mjs is present next to this script;
    3. forward every argument verbatim to that mjs.

  Node resolution order (fail-loud, never silently falls back):
    1. -NodePath parameter (explicit, wins);
    2. $env:WINVM_NODE_BIN (environment override);
    3. node on PATH (Get-Command node);
    4. common install locations (Program Files / LocalAppData / ProgramData).
  If none resolves, the script exits 1 with the download URL printed. It must
  NEVER pretend to have run - a silent no-op that returns 0 is the exact failure
  mode this wrapper exists to prevent.

  Why -SkipInstall defaults to on:
    A release package ships pre-built dist/. Re-running npm ci inside the VM is
    both slow and fragile (needs network + a lockfile that matches), while the
    dist is already fingerprinted in MANIFEST. So the release-packaging path
    wants --skip-install. A source checkout, however, DOES need npm ci.
    We therefore default it to ON only when the workspace symlink material is
    already in place (packages/*/dist present); otherwise we leave npm ci on.
    Operators can always force either way: -SkipInstall / -InstallDeps.

.PARAMETER SkipInstall
  Forward --skip-install to install-vm.mjs (skip npm ci; rely on distributed dist).

.PARAMETER InstallDeps
  Forward nothing (run npm ci). Mutually exclusive with -SkipInstall.

.PARAMETER WhatIf
  Forward --dry-run: print the plan, change nothing.

.PARAMETER Uninstall
  Forward --uninstall: remove the deployed service from this VM.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -WhatIf
  .\install.ps1 -Provider workbuddy -Cli "C:\path\to\cli.exe"
  .\install.ps1 -Uninstall -Yes

.NOTES
  Encoding: this file MUST stay pure ASCII with no BOM and CRLF line endings.
  The repo has guard tests that enforce exactly that (a PS 5.1 parser cannot
  reliably read a BOM-less UTF-8 file containing non-ASCII bytes).
#>
[CmdletBinding()]
param(
  [string]$NodePath,
  [switch]$SkipInstall,
  [switch]$InstallDeps,
  [switch]$WhatIf,
  [switch]$Uninstall,
  [switch]$Yes,
  [string]$Provider,
  [string]$Cli,
  [int]$Port,
  [string]$Config,
  [string]$TaskName,
  [string]$SkillsRoot,
  [switch]$SkipSkills,
  [switch]$SkipBuild,
  [switch]$SkipLinks,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$msg) { Write-Host "[install.ps1] $msg" }
function Write-Fail([string]$msg) { Write-Host "[install.ps1] ERROR: $msg" -ForegroundColor Red }

# --- 1. locate node (fail-loud) ------------------------------------------------
function Resolve-NodeExe {
  param([string]$Explicit)

  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit)) {
      Write-Fail "NodePath does not exist: $Explicit"
      return $null
    }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }

  $envNode = $env:WINVM_NODE_BIN
  if ($envNode) {
    if (-not (Test-Path -LiteralPath $envNode)) {
      Write-Fail "WINVM_NODE_BIN does not exist: $envNode"
      return $null
    }
    return (Resolve-Path -LiteralPath $envNode).Path
  }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:ProgramData 'chocolatey\bin\node.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }

  Write-Fail 'node not found (tried -NodePath, WINVM_NODE_BIN, PATH, and common install dirs).'
  Write-Host '  Install Node.js LTS, or point at it explicitly:'
  Write-Host '    .\install.ps1 -NodePath "C:\Program Files\nodejs\node.exe"'
  Write-Host '    (download: https://nodejs.org/en/download)'
  return $null
}

$nodeExe = Resolve-NodeExe -Explicit $NodePath
if (-not $nodeExe) { exit 1 }

# --- 2. verify the real installer sits next to this shell ----------------------
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $here 'install-vm.mjs'
if (-not (Test-Path -LiteralPath $installer)) {
  Write-Fail "install-vm.mjs not found next to this script (expected: $installer)"
  Write-Host '  This wrapper must ship alongside delivery/install-vm.mjs (same directory).'
  exit 1
}

# --- 3. forward arguments verbatim --------------------------------------------
$argv = New-Object System.Collections.Generic.List[string]
$argv.Add($installer)

# Default for dependency resolution: skip npm ci ONLY when a distributed build is
# actually present. Reasoning: a release package has packages/*/dist and no need to
# hit the network; a source checkout does not, and must run npm ci or nothing works.
$hasDist = $false
$pkgRoot = Join-Path (Split-Path -Parent $here) 'packages'
if (Test-Path -LiteralPath $pkgRoot) {
  $distDirs = @(Get-ChildItem -LiteralPath $pkgRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'dist') })
  if ($distDirs.Count -gt 0) { $hasDist = $true }
}

if ($SkipInstall -and $InstallDeps) {
  Write-Fail 'SkipInstall and InstallDeps are mutually exclusive.'
  exit 1
}
if ($SkipInstall) {
  $argv.Add('--skip-install')
  Write-Info 'dep resolution: skipped npm ci (-SkipInstall)'
} elseif ($InstallDeps) {
  Write-Info 'dep resolution: will run npm ci (-InstallDeps)'
} elseif ($hasDist) {
  $argv.Add('--skip-install')
  Write-Info 'dep resolution: skipped npm ci (dist already distributed; pass -InstallDeps to force)'
} else {
  Write-Info 'dep resolution: will run npm ci (no packages/*/dist found)'
}

if ($WhatIf) { $argv.Add('--dry-run') }
if ($Uninstall) { $argv.Add('--uninstall') }
if ($Uninstall -and $Yes) { $argv.Add('--yes') }
if ($SkipBuild) { $argv.Add('--skip-build') }
if ($SkipLinks) { $argv.Add('--skip-links') }
if ($SkipSkills) { $argv.Add('--skip-skills') }
if ($Provider) { $argv.Add('--provider'); $argv.Add($Provider) }
if ($Cli) { $argv.Add('--cli'); $argv.Add($Cli) }
if ($PSBoundParameters.ContainsKey('Port')) { $argv.Add('--port'); $argv.Add([string]$Port) }
if ($Config) { $argv.Add('--config'); $argv.Add($Config) }
if ($TaskName) { $argv.Add('--task-name'); $argv.Add($TaskName) }
if ($SkillsRoot) { $argv.Add('--skills-root'); $argv.Add($SkillsRoot) }
if ($Rest) { foreach ($r in $Rest) { $argv.Add($r) } }

Write-Info "node  : $nodeExe"
Write-Info "target: $installer"
Write-Info ('args  : ' + (($argv | Select-Object -Skip 1) -join ' '))

# --- 4. run, and propagate the real exit code ---------------------------------
& $nodeExe @argv
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }

if ($code -eq 0) {
  Write-Info 'install-vm.mjs finished with exit code 0'
} else {
  Write-Fail "install-vm.mjs failed with exit code $code"
}
exit $code