# ASCII only (MSYS + PS 5.1 safe). Step-3 precondition gate: VM-side runtime chain.
#
# Checks, in dependency order, the three things deploy-vm.mjs refuses to proceed without
# (mirrors delivery/preflight.mjs checkLocalVmDeps):
#   1. vm-node        node -v >= 18
#   2. vm-npm         npm -v exits 0
#   3. vm-agent-cli   codebuddy --version exits 0   (blocking only when provider needs an LLM)
#
# Roles: CHECK + install HINT by default; -Fix only auto-installs the *npm package*
# (user-scope, no version switching). Node/npm are never auto-installed on purpose:
# switching nvm node versions silently orphans globally installed CLIs (see MEMORY).
#
# Params:
#   -Cli <name>      agent CLI command          (default codebuddy)
#   -Pkg <name>      npm package                (default @tencent-ai/codebuddy-code)
#   -MinNode <ver>   minimum node version       (default 18.0.0)
#   -Fix             npm i -g $Pkg when the CLI is missing, then re-check
#   -SimulateMissing strip node dirs from PATH first (negative-path self test)
param(
  [string]$Cli = 'codebuddy',
  [string]$Pkg = '@tencent-ai/codebuddy-code',
  [string]$MinNode = '18.0.0',
  [switch]$Fix,
  [switch]$SimulateMissing
)
$ErrorActionPreference = 'SilentlyContinue'
function Out($k, $v) { Write-Output ("{0}={1}" -f $k, $v) }
function OrMissing($v) { if ($v) { return $v } else { return 'MISSING' } }

if ($SimulateMissing) {
  $keep = ($env:PATH -split ';') | Where-Object { $_ -and $_ -notmatch 'nvm|nodejs|node_modules' }
  $env:PATH = ($keep -join ';')
  Out 'SIMULATE_MISSING' 'true'
}

# ---------- 1) node -------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodeVer = ''
$nodeOk = $false
$nodePath = 'MISSING'
if ($nodeCmd) {
  $nodePath = $nodeCmd.Source
  $nodeVer = ("$(& node -v 2>$null)").Trim()
  try {
    $cur = [version]($nodeVer -replace '^v', '')
    $nodeOk = ($cur -ge [version]$MinNode)
  } catch { $nodeOk = $false }
}
Out 'NODE_FOUND' ([bool]$nodeCmd).ToString().ToLower()
Out 'NODE_PATH' $nodePath
Out 'NODE_VERSION' (OrMissing $nodeVer)
Out 'NODE_OK' $nodeOk.ToString().ToLower()

# ---------- 2) npm --------------------------------------------------------
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
$npmVer = ''
if ($npmCmd) { $npmVer = ("$(& npm -v 2>$null)").Trim() }
Out 'NPM_FOUND' ([bool]$npmCmd).ToString().ToLower()
Out 'NPM_VERSION' (OrMissing $npmVer)

# install channels (informational: what to suggest when node/npm are missing)
$nvm = Get-Command nvm -ErrorAction SilentlyContinue
Out 'NVM_FOUND' ([bool]$nvm).ToString().ToLower()
if ($nvm) {
  $nvmList = ("$(& nvm list 2>&1)") -replace '\s+', ' '
  Out 'NVM_LIST' $nvmList.Trim()
}

# ---------- 3) agent CLI --------------------------------------------------
$cliCmd = Get-Command $Cli -ErrorAction SilentlyContinue
$cliVer = ''
$cliOk = $false
$cliPath = 'MISSING'
if ($cliCmd) {
  $cliPath = $cliCmd.Source
  $v = (& $Cli --version 2>$null) | Select-Object -First 1
  if ($LASTEXITCODE -eq 0 -and $v) { $cliOk = $true; $cliVer = "$v".Trim() }
}
Out 'CLI_CMD' $Cli
Out 'CLI_FOUND' ([bool]$cliCmd).ToString().ToLower()
Out 'CLI_PATH' $cliPath
Out 'CLI_VERSION' (OrMissing $cliVer)
Out 'CLI_OK' $cliOk.ToString().ToLower()

if ($cliOk) {
  $ls = & npm ls -g --depth=0 --json 2>$null
  if ($ls) {
    try {
      $o = $ls | ConvertFrom-Json
      $hit = $o.dependencies.PSObject.Properties | Where-Object { $_.Name -eq $Pkg }
      if ($hit) { Out 'GLOBAL_PKG' ($hit.Name + '@' + $hit.Value.version) }
      else { Out 'GLOBAL_PKG' 'NOT_IN_NPM_GLOBAL' }
    } catch { Out 'GLOBAL_PKG' 'PARSE_ERR' }
  } else { Out 'GLOBAL_PKG' 'NPM_LS_EMPTY' }
  $prefix = ("$(& npm config get prefix 2>$null)").Trim()
  Out 'NPM_PREFIX' $prefix
}

# ---------- 4) login state (aligns with preflight.evaluateAgentLogin) -----
$cfg = Join-Path $env:USERPROFILE '.codebuddy'
$found = @()
$authVerdict = 'installed-unverified'
if (Test-Path $cfg) {
  foreach ($m in @('settings.json', 'user-state.json')) {
    if (Test-Path (Join-Path $cfg $m)) { $found += $m }
  }
  Out 'AUTH_DIR' 'present'
  if ($found.Count -gt 0) { $authVerdict = 'config-dir-present' }
} else {
  Out 'AUTH_DIR' 'absent'
}
$markers = if ($found.Count -gt 0) { $found -join ',' } else { 'none' }
Out 'AUTH_MARKERS' $markers
Out 'AUTH_VERDICT' $authVerdict

# ---------- 5) verdict + remedies ----------------------------------------
$blockers = @()
if (-not $nodeOk) { $blockers += 'node' }
if (-not $npmCmd) { $blockers += 'npm' }
if (-not $cliOk) { $blockers += 'cli' }

if ($blockers.Count -eq 0) {
  Out 'BLOCKERS' 'none'
  Out 'ENV_PRECHECK' 'PASS'
} else {
  Out 'BLOCKERS' ($blockers -join ',')
  Out 'ENV_PRECHECK' 'FAIL'
}

if (-not $nodeOk -or -not $npmCmd) {
  Out 'NEEDS_RUNTIME' 'true'
  if ($nvm) {
    Out 'RUNTIME_HINT_NVM' 'nvm install 24.21.0 ; nvm use 24.21.0   (then re-install the CLI: npm i -g @tencent-ai/codebuddy-code)'
  }
  Out 'RUNTIME_HINT_MSI' 'silent MSI: msiexec /i node-v24.21.0-x64.msi /qn /norestart   (needs admin + desktop session)'
  Out 'RUNTIME_HINT_WINGET' 'winget install OpenJS.NodeJS.LTS   (NOT reliable over ssh: MSIX alias returns empty version)'
} else {
  Out 'NEEDS_RUNTIME' 'false'
}

if (-not $cliOk) {
  Out 'NEEDS_CLI' 'true'
  Out 'CLI_INSTALL_CMD' ("npm i -g " + $Pkg)
  if ($Fix -and $npmCmd) {
    Write-Output '--- installing agent CLI ---'
    & npm i -g $Pkg 2>&1 | ForEach-Object { Write-Output ("npm| " + $_) }
    $c2 = Get-Command $Cli -ErrorAction SilentlyContinue
    if ($c2) {
      $v2 = (& $Cli --version 2>$null) | Select-Object -First 1
      if ($LASTEXITCODE -eq 0 -and $v2) {
        Out 'AFTER_FIX_CLI_OK' 'true'
        Out 'AFTER_FIX_CLI_VERSION' "$v2".Trim()
        Out 'ENV_PRECHECK' 'PASS'
      } else {
        Out 'AFTER_FIX_CLI_OK' 'false'
      }
    } else {
      Out 'AFTER_FIX_CLI_OK' 'false'
    }
  }
} else {
  Out 'NEEDS_CLI' 'false'
}
