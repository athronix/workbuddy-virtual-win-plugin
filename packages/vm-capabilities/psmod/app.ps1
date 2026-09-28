<#
.SYNOPSIS
    WinVM Bridge —— app 能力域（应用管理，FR-202）
#>

# ------------------------------ app.inventory.list ------------------------------
#
# CL-018 C6：同名重复登记（实测 `RustDesk` ×2，两条同在 HKLM64、同版本）会污染清单。
# 合并语义精确为 **按 `(DisplayName, DisplayVersion)` 分组**：
#   * 同 (name,version) 的多条注册键 → 合并为 1 条，新增 `registryKeyCount`（原始键条数）；
#   * `architectures` 由 **hive 推断**（HKLM64→`x64`、HKLM(32 位视图/WOW6432Node)→`x86`、
#     HKCU→**未知**）；**仅当可推断时填充**，推不出则省略（**绝不硬造 `["x64","x86"]`**）；
#   * **name 相同但 version 不同 → 保留多条**（不得按 name 去重）。
#
# 注意（CL-017 N1 教训延续）：旧实现曾按 name 用 -Unique 去重（会**误删同名异版本**），
# 现已由本 (name,version) 分组合并取代 —— 切勿恢复「按 name 去重」。
# 仍需遵守 N1：对 [ordered]@{} 列表一律走脚本块访问器 `-Property { ... }`，禁用裸键形式。

function Get-InstalledApps {
    param(
        [string]$Name = '',
        [switch]$IncludeUwp
    )

    # hive → 架构推断表（$null 表示该 hive 无法推断架构 → 不参与 architectures）
    $sources = @(
        @{ path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*';             arch = 'x64' },
        @{ path = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'; arch = 'x86' },
        @{ path = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*';             arch = $null }
    )

    # —— 采集原始注册键（不去重）——
    $raw = New-Object System.Collections.ArrayList
    foreach ($src in $sources) {
        $items = @(Get-ItemProperty -Path $src.path -ErrorAction SilentlyContinue |
            Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName })
        foreach ($item in $items) {
            # D13：可选属性常不存在，严格模式下直接取属性会抛错 → 统一经 PSObject.Properties 守卫
            $pr = $item.PSObject.Properties
            $ver = if ($pr['DisplayVersion']) { $pr['DisplayVersion'].Value } else { $null }
            [void]$raw.Add([ordered]@{
                name         = [string]$item.DisplayName
                version      = $ver
                publisher    = if ($pr['Publisher']) { $pr['Publisher'].Value } else { $null }
                installDate  = if ($pr['InstallDate']) { $pr['InstallDate'].Value } else { $null }
                installPath  = if ($pr['InstallLocation']) { $pr['InstallLocation'].Value } else { $null }
                uninstallCmd = if ($pr['UninstallString']) { $pr['UninstallString'].Value } else { $null }
                source       = 'registry'
                arch         = $src.arch
            })
        }
    }

    # —— 按 (name, version) 分组（用 NUL 分隔，避免名称含分隔符时误合并）——
    $groups = @{}
    foreach ($r in $raw) {
        $verKey = if ($null -eq $r.version) { '' } else { [string]$r.version }
        $key = $r.name + [char]0 + $verKey
        if (-not $groups.ContainsKey($key)) { $groups[$key] = New-Object System.Collections.ArrayList }
        [void]$groups[$key].Add($r)
    }

    $apps = New-Object System.Collections.ArrayList
    foreach ($key in ($groups.Keys | Sort-Object -Property { $_ })) {
        $members = @($groups[$key])
        $first = $members[0]
        $archSet = @($members | Where-Object { $_.arch } | ForEach-Object { $_.arch } | Select-Object -Unique)
        $row = [ordered]@{
            name             = $first.name
            version          = $first.version
            publisher        = $first.publisher
            installDate      = $first.installDate
            installPath      = $first.installPath
            uninstallCmd     = $first.uninstallCmd
            source           = 'registry'
            # 该 (name,version) 的原始注册键条数（反映"重复登记"）
            registryKeyCount = $members.Count
        }
        # 仅当 hive 可可靠推断时填充（推不出则字段缺席）
        if ($archSet.Count -gt 0) { $row['architectures'] = @($archSet) }
        [void]$apps.Add($row)
    }

    if ($IncludeUwp) {
        $uwp = @(Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object {
            [ordered]@{
                name             = $_.Name
                version          = $_.Version
                publisher        = $_.Publisher
                packageName      = $_.PackageFullName
                source           = 'appx'
                registryKeyCount = 1
            }
        })
        foreach ($u in $uwp) { [void]$apps.Add($u) }
    }

    $result = @($apps.ToArray())
    if ($Name) { $result = @($result | Where-Object { $_.name -like "*$Name*" }) }
    return $result
}

# ------------------------------ app.winget.search ------------------------------

# --- winget 表格解析辅助（D25）---
# ① winget search 的输出虽是「定宽表格」，但**按显示宽度（display width）对齐，而非按字符数对齐**。
# ② CJK / 全角字符占 **2 个显示列**（ASCII 占 1 列）；若用「字符索引」直接切列，含中日韩包名的行
#    会整体错位 —— 真机实测第 10 行（`7zip解压缩软件 … XP8C87R6J42SKH`）会被切成
#    `id="7R6J42SKH            Unkno"`、`version="wn"` 之类的**垃圾 id**（另一类「静默错数据」）。
#    故必须先把「显示列」换算为字符索引，再做 Substring 切片。
# ③ ⚠ 本补偿为 **CL-017 D25 裁决保留项**：主理人已二分确认「纯表头定列（char 模式）」会产出 1 行垃圾 id，
#    而「表头定列 + 显示宽度补偿（width 模式）」为 0 行。**勿以『逐字对齐表头』为由删除本补偿** ——
#    删了就会退回「静默错数据」。

# 单个码点的显示宽度：东亚宽/全角字符 = 2，其余 = 1（与 winget 的列对齐规则一致）。
function Get-DisplayCharWidth {
    param([int]$CodePoint)
    if (($CodePoint -ge 0x1100 -and $CodePoint -le 0x115F) -or
        $CodePoint -eq 0x2329 -or $CodePoint -eq 0x232A -or
        ($CodePoint -ge 0x2E80 -and $CodePoint -le 0xA4CF) -or
        ($CodePoint -ge 0xAC00 -and $CodePoint -le 0xD7A3) -or
        ($CodePoint -ge 0xF900 -and $CodePoint -le 0xFAFF) -or
        ($CodePoint -ge 0xFE30 -and $CodePoint -le 0xFE6F) -or
        ($CodePoint -ge 0xFF00 -and $CodePoint -le 0xFF60) -or
        ($CodePoint -ge 0xFFE0 -and $CodePoint -le 0xFFE6) -or
        ($CodePoint -ge 0x20000 -and $CodePoint -le 0x3FFFD)) { return 2 }
    return 1
}

# 为一行建立「显示列 → 字符索引」映射（每行一次；供多列切片复用）。
# map[d] = 该显示列起始字符在字符串中的索引；末尾追加行尾哨兵（= 行长度）。
function Get-DisplayColumnMap {
    param([string]$Line)
    $map = [System.Collections.Generic.List[int]]::new()
    $i = 0
    while ($i -lt $Line.Length) {
        $cp = [char]::ConvertToUtf32($Line, $i)
        $w = Get-DisplayCharWidth -CodePoint $cp
        # 宽度 2 的字符：其覆盖的每个显示列都映射到该字符起点
        for ($d = 0; $d -lt $w; $d++) { $map.Add($i) }
        $i += if ([char]::IsHighSurrogate($Line, $i)) { 2 } else { 1 }
    }
    $map.Add($Line.Length)   # 行尾哨兵
    return ,$map
}

# 取某显示列对应的字符索引（越界则收敛到行尾）。
function Get-CharIndexAtDisplay {
    param($Map, [int]$DisplayCol)
    if ($DisplayCol -le 0) { return 0 }
    if ($DisplayCol -ge $Map.Count) { return $Map[$Map.Count - 1] }
    return $Map[$DisplayCol]
}

function Search-WingetPackage {
    param([Parameter(Mandatory)][string]$Query, [int]$Limit = 20)

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'WINGET_NOT_FOUND: 未找到 winget，请先安装「应用安装程序」'
    }

    # --disable-interactivity 避免任何阻塞式交互（无人值守必需）
    $raw = & winget search --query $Query --disable-interactivity --accept-source-agreements 2>$null
    $lines = @($raw | ForEach-Object { "$_" })

    # ⚠ D25（CL-017，静默空结果修复）：列边界必须取自**分隔线上方的表头行**。
    #   旧实现（D16）误把分隔线当成「按列分段」：winget 的分隔线其实是**一整条连续横线**
    #   （真机实测 98 个 '-'），`[regex]::Matches($sep, '-+')` 只得 1 个匹配 → $cols.Count=1
    #   → 每行 $vals.Count=1 → 全部命中 `$vals.Count -lt 3` 被 continue → out=@() →
    #   **ok=true + data=[] 的「静默空」**（调用方误判「winget 没有这个包」，比列错位更危险）。
    #   正确做法：在表头行定位 Name|Id|Version|Match|Source 各标签的**起始显示列**，
    #   切片区间 [start_i, start_{i+1})；并因按显示宽度对齐而经显示列换算（见上方辅助函数）。
    $sepIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*-{3,}') { $sepIdx = $i; break }
    }

    $out = @()
    if ($sepIdx -lt 1) {
        # 兼容：无分隔线 / 无表头（旧版 winget 或异常输出）时退回宽松解析
        foreach ($line in $lines) {
            if ($line -match '^\s*(\S[^\t]{2,40})\s+(\S+)\s+(.+)$') {
                $out += [ordered]@{ id = $Matches[2].Trim(); name = $Matches[1].Trim(); version = $Matches[3].Trim() }
            }
            if ($out.Count -ge $Limit) { break }
        }
        return @($out)
    }

    # 由表头行各列标签的起始显示列得到列边界
    $header = $lines[$sepIdx - 1]
    $labels = @('Name', 'Id', 'Version', 'Match', 'Source')
    $marks = @()
    foreach ($lab in $labels) {
        $m = [regex]::Match($header, ('(?<![A-Za-z])' + $lab + '(?![A-Za-z])'))
        if ($m.Success) { $marks += [pscustomobject]@{ label = $lab; start = $m.Index } }
    }
    # 用脚本块访问器排序（PS 5.1 对 pscustomobject 用 `-Property start` 亦可，但脚本块更稳，见 N1 教训）
    $marks = @($marks | Sort-Object -Property { $_.start })

    $firstDataLine = $null
    for ($i = $sepIdx + 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        # 跳过重复分隔线 / winget 汇总行（如「N 个包匹配 ...」）
        if ($line -match '^\s*-{3,}') { continue }
        if ($line -match '^\s*\d+\s+\S+\s+(匹配|matching|packages)') { continue }
        if ($null -eq $firstDataLine) { $firstDataLine = $line }

        $map = Get-DisplayColumnMap -Line $line
        $vals = @()
        for ($k = 0; $k -lt $marks.Count; $k++) {
            $startIdx = Get-CharIndexAtDisplay -Map $map -DisplayCol $marks[$k].start
            $endIdx = if ($k + 1 -lt $marks.Count) { Get-CharIndexAtDisplay -Map $map -DisplayCol $marks[$k + 1].start } else { $line.Length }
            if ($endIdx -lt $startIdx) { $endIdx = $startIdx }
            $vals += ($line.Substring($startIdx, $endIdx - $startIdx)).Trim()
        }
        # winget search 列序：Name | Id | Version | [Match] | [Source] → id 固定在索引 1
        if ($vals.Count -lt 2 -or -not $vals[1]) { continue }
        $version = if ($vals.Count -ge 3) { $vals[2] } else { '' }
        $out += [ordered]@{ name = $vals[0]; id = $vals[1]; version = $version }
        if ($out.Count -ge $Limit) { break }
    }

    # D25 fail-loud：分隔线之后**确有数据行**却解析出 0 条 → 明确报错，绝不静默给空。
    # 静默空会让调用方误判「winget 没有这个包」；宁可 fail-loud 暴露解析失败以便尽快修复。
    if ($null -ne $firstDataLine -and $out.Count -eq 0) {
        throw 'WINGET_PARSE_FAILED: ' + $firstDataLine
    }
    return @($out)
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
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$TargetPath = '',
        [string]$Arguments = '',
        [string]$WorkingDirectory = ''
    )

    # D8：capability schema 暴露了 targetPath/arguments/workingDirectory，
    # 但旧实现只声明了 $Path —— 调用方传 targetPath 会报
    # 「找不到与参数名称 targetPath 匹配的参数」，且无法创建快捷方式。
    # 现语义：提供 targetPath 即**创建/覆盖** .lnk；否则读取已有 .lnk 的 target/args/workingDir。
    $shell = New-Object -ComObject WScript.Shell

    if ($TargetPath) {
        $dir = [System.IO.Path]::GetDirectoryName($Path)
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $lnk = $shell.CreateShortcut($Path)
        $lnk.TargetPath = $TargetPath
        if ($Arguments) { $lnk.Arguments = $Arguments }
        if ($WorkingDirectory) { $lnk.WorkingDirectory = $WorkingDirectory }
        $lnk.Save()
        return [ordered]@{
            path        = $Path
            targetPath  = $lnk.TargetPath
            arguments   = $lnk.Arguments
            workingDir  = $lnk.WorkingDirectory
            description = $lnk.Description
            created     = (Test-Path -LiteralPath $Path)
        }
    }

    if (-not (Test-Path -LiteralPath $Path)) { throw "PATH_NOT_FOUND: $Path" }
    $lnk = $shell.CreateShortcut($Path)
    return [ordered]@{
        path        = $Path
        targetPath  = $lnk.TargetPath
        arguments   = $lnk.Arguments
        workingDir  = $lnk.WorkingDirectory
        description = $lnk.Description
        created     = $false
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
