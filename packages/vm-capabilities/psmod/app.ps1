<#
.SYNOPSIS
    WinVM Bridge —— app 能力域（应用管理，FR-202）
#>

# ------------------------------ app.inventory.list ------------------------------

function Get-InstalledApps {
    param(
        [string]$Name = '',
        [switch]$IncludeUwp
    )

    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    $apps = foreach ($p in $paths) {
        Get-ItemProperty -Path $p -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName } |
            ForEach-Object {
                [ordered]@{
                    name         = $_.DisplayName
                    version      = $_.DisplayVersion
                    publisher    = $_.Publisher
                    installDate  = $_.InstallDate
                    installPath  = $_.InstallLocation
                    uninstallCmd = $_.UninstallString
                    source       = 'registry'
                }
            }
    }

    $apps = @($apps | Sort-Object -Property name -Unique)

    if ($IncludeUwp) {
        $uwp = @(Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object {
            [ordered]@{
                name        = $_.Name
                version     = $_.Version
                publisher   = $_.Publisher
                packageName = $_.PackageFullName
                source      = 'appx'
            }
        })
        $apps += $uwp
    }

    if ($Name) { $apps = $apps | Where-Object { $_.name -like "*$Name*" } }
    return $apps
}

# ------------------------------ app.winget.search ------------------------------

function Search-WingetPackage {
    param([Parameter(Mandatory)][string]$Query, [int]$Limit = 20)

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'WINGET_NOT_FOUND: 未找到 winget，请先安装「应用安装程序」'
    }

    # --disable-interactivity 避免任何阻塞式交互（无人值守必需）
    $raw = & winget search --query $Query --disable-interactivity --accept-source-agreements 2>$null
    $out = @()
    foreach ($line in $raw) {
        if ($line -match '^\s*(\S[^\t]{2,40})\s+(\S+)\s+(.+)$') {
            $out += [ordered]@{ id = $Matches[2].Trim(); name = $Matches[1].Trim(); version = $Matches[3].Trim() }
        }
        if ($out.Count -ge $Limit) { break }
    }
    return $out
}

# ------------------------------ app.winget.install ------------------------------

function Install-WingetPackage {
    param(
        [Parameter(Mandatory)][string]$Id,
        [string]$Version = '',
        [switch]$DryRun
    )

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'WINGET_NOT_FOUND: 未找到 winget'
    }

    $args = @('install', '--exact', '--id', $Id, '--accept-package-agreements',
        '--accept-source-agreements', '--disable-interactivity')
    if ($Version) { $args += @('--version', $Version) }
    if ($DryRun)  { $args += '--dry-run' }

    $raw = & winget @args 2>&1
    $exit = $LASTEXITCODE

    return [ordered]@{
        id      = $Id
        version = $Version
        dryRun  = [bool]$DryRun
        exitCode = $exit
        success = ($exit -eq 0)
        output  = @($raw | ForEach-Object { "$_" })
    }
}

# ------------------------------ app.winget.uninstall ------------------------------

function Uninstall-WingetPackage {
    param([Parameter(Mandatory)][string]$Id, [switch]$DryRun)

    $args = @('uninstall', '--exact', '--id', $Id, '--accept-source-agreements', '--disable-interactivity')
    if ($DryRun) { $args += '--dry-run' }

    $raw = & winget @args 2>&1
    return [ordered]@{
        id = $Id; dryRun = [bool]$DryRun; exitCode = $LASTEXITCODE
        success = ($LASTEXITCODE -eq 0); output = @($raw | ForEach-Object { "$_" })
    }
}

# ------------------------------ app.winget.upgrade ------------------------------

function Update-WingetPackage {
    param([string]$Id = '', [switch]$All, [switch]$DryRun)

    $args = @('upgrade', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    if ($Id) { $args += @('--exact', '--id', $Id) } elseif ($All) { $args += '--all' }
    else { throw 'INVALID_PARAMS: 需指定 Id 或 -All' }
    if ($DryRun) { $args += '--dry-run' }

    $raw = & winget @args 2>&1
    return [ordered]@{
        id = $Id; all = [bool]$All; dryRun = [bool]$DryRun; exitCode = $LASTEXITCODE
        success = ($LASTEXITCODE -eq 0); output = @($raw | ForEach-Object { "$_" })
    }
}

# ------------------------------ app.process.launch ------------------------------

function Start-AppProcess {
    param(
        [Parameter(Mandatory)][string]$Target,
        [string]$Arguments = '',
        [string]$WorkingDirectory = '',
        [switch]$Wait
    )

    $psi = [ordered]@{ FilePath = $Target }
    if ($Arguments) { $psi['ArgumentList'] = $Arguments }
    if ($WorkingDirectory) { $psi['WorkingDirectory'] = $WorkingDirectory }

    $proc = Start-Process @psi -PassThru -ErrorAction Stop
    if ($Wait) { $proc.WaitForExit() | Out-Null }

    return [ordered]@{
        processId = $proc.Id
        name      = $proc.ProcessName
        started   = $true
        exited    = if ($Wait) { $true } else { $proc.HasExited }
        exitCode  = if ($Wait) { $proc.ExitCode } else { $null }
    }
}

# ------------------------------ app.shortcut.manage ------------------------------

function Get-ShortcutInfo {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { throw "PATH_NOT_FOUND: $Path" }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    return [ordered]@{
        path        = $Path
        targetPath  = $lnk.TargetPath
        arguments   = $lnk.Arguments
        workingDir  = $lnk.WorkingDirectory
        description = $lnk.Description
    }
}

function New-ShortcutItem {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$TargetPath,
        [string]$Arguments = '',
        [string]$WorkingDirectory = ''
    )

    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $TargetPath
    if ($Arguments) { $lnk.Arguments = $Arguments }
    if ($WorkingDirectory) { $lnk.WorkingDirectory = $WorkingDirectory }
    $lnk.Save()
    return [ordered]@{ path = $Path; targetPath = $TargetPath; created = (Test-Path -LiteralPath $Path) }
}

# ------------------------------ app.appx.manage ------------------------------

function Get-AppxPackageInfo {
    param([string]$Name = '')

    $pkgs = Get-AppxPackage -ErrorAction SilentlyContinue
    if ($Name) { $pkgs = $pkgs | Where-Object { $_.Name -like "*$Name*" } }
    return @($pkgs | ForEach-Object {
        [ordered]@{ name = $_.Name; version = $_.Version; packageFullName = $_.PackageFullName; isFramework = [bool]$_.IsFramework }
    })
}
