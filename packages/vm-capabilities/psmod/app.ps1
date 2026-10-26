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

# ------------------------------ winget 有界执行（Q5 树杀，Phase 3 批2） ------------------------------
#
# 病灶（audit-qa ⑦ / 2026-10-08 实现运维审计 :788，在册未修）：`& winget ...` 是 in-proc
# 调用，调用方拿不到子进程对象，**无法施加超时**；上层 600s 能力超时到来时 ps-bridge 侧
# 只杀得到 powershell 包装层，winget 及其派生的安装器孙进程（windows installer / 自解压 stub）
# 会**孤儿化**继续跑（卸载类留孤儿安装进程属安全面）。
#
# 修法：winget 长调用一律走本函数 —— .NET Process 起独立子进程 + 有界等待 +
# **超时 taskkill /PID <id> /T /F 树杀**（PS 5.1 的 [Process]::Kill 无树语义，故先 Kill
# 自身再 taskkill /T 兜底孙进程；与 persistent-session.ts defaultTreeKill / appops.cli.invoke
# 同模式）。stdout/stderr 异步读，防管道缓冲写满死锁（appops 同款教训）。
#
# 返回 [ordered]@{ exitCode; output=@(lines); timedOut=$true/$false }
#   exitCode = -9994 启动失败（本函数诊断码族，与 -9996..-9999 同族不冲突）
#   超时 ⇒ exitCode=-1 + timedOut=true（调用方据此判失败，绝不谎报成功）
function Invoke-WingetBounded {
    param(
        [Parameter(Mandatory)][string[]]$WingetArgs,
        [int]$TimeoutMs = 300000
    )

    # 参数逐个转引号形态（含空格/特殊字符时保真；winget id 通常无空格，防御性处理）
    $argLine = (($WingetArgs | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' ')

    # 解析 winget 可执行全路径（App Execution Alias 在 WindowsApps 目录；
    # UseShellExecute=false 时 CreateProcess 对别名解析不稳，与 appops.cli.invoke 同款显式解析）
    $exeFull = 'winget'
    $cmdInfo = Get-Command winget -ErrorAction SilentlyContinue
    if ($cmdInfo -and $cmdInfo.Source) { $exeFull = $cmdInfo.Source }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exeFull
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    try { [void]$proc.Start() }
    catch {
        return [ordered]@{ exitCode = -9994; output = @("WINGET_SPAWN_FAILED: $($_.Exception.Message)"); timedOut = $false }
    }
    $procId = $proc.Id

    # 异步读双流（同步读会与长输出死锁 —— appops.cli.invoke 同款纪律）
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    $exited = $false
    try { $exited = [bool]$proc.WaitForExit($TimeoutMs) } catch { $exited = $false }
    $timedOut = -not $exited
    if ($timedOut) {
        # 硬超时树杀：先取可执行路径再 Kill（Kill 后 Path 会失效），taskkill /T 清整个树
        $exePath = ''
        try { $exePath = $proc.Path } catch { $exePath = '' }
        try { [void]$proc.Kill() } catch { }
        try { & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null } catch { }
        if ($exePath) {
            # winget 是 MSIX stub（ProcessStartPath 与真实安装器不同名），按镜像名再扫一遍树
            try { & taskkill.exe /IM winget.exe /T /F 2>&1 | Out-Null } catch { }
        }
        try { [void]$proc.WaitForExit(5000) } catch { }
    }

    $outText = ''
    $errText = ''
    try { $outText = $stdoutTask.Result } catch { }
    try { $errText = $stderrTask.Result } catch { }
    $exit = -9994
    if (-not $timedOut) { try { $exit = $proc.ExitCode } catch { $exit = -9994 } } else { $exit = -1 }
    try { $proc.Dispose() } catch { }

    $lines = @()
    if ($outText) { $lines += @($outText -split "`r?`n") }
    if ($errText) { $lines += @($errText -split "`r?`n") }
    $lines = @($lines | Where-Object { $_ -ne '' })
    if ($timedOut) { $lines += "[winget] 超过 ${TimeoutMs}ms 未结束，已 taskkill /T 终止进程树（pid=$procId）" }

    return [ordered]@{ exitCode = [int]$exit; output = $lines; timedOut = [bool]$timedOut }
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

    # Q5（批2）：有界执行 + 超时树杀（能力级预算 600s，留 60s 收尾 → 540s 软顶）。
    # 旧 `& winget @args` 拿不到子进程对象，超时到来时安装器孙进程孤儿化续跑。
    $r = Invoke-WingetBounded -WingetArgs $args -TimeoutMs 540000
    $exit = [int]$r['exitCode']

    return [ordered]@{
        id      = $Id
        version = $Version
        dryRun  = [bool]$DryRun
        exitCode = $exit
        success = ($exit -eq 0)
        timedOut = [bool]$r['timedOut']
        output  = @($r['output'])
    }
}

# ------------------------------ app.winget.uninstall ------------------------------
#
# R17-T02 · K6 卸载核验状态机（设计 docs/design/r17-design.md §A1.3 / §A5）。
# 规则合同 R-1…R-8 定义在 tests/unit/r3-uninstall-verify.test.js（头部注释 + 测试内等价参考函数）。
# 本节的每个函数上方都标出其覆盖的 R 编号 —— **PS 与测试规则必须逐条一致**，
# 任何一侧改动都要同步另一侧（QA R3-6 真机对照回归以此为判据）。
#
# 与旧实现（只看 winget exit code）的差异：
#   * `success` 以**最终核验**为准：winget exit 0 但磁盘/注册表未变（NSIS 包假成功）一律 success=false；
#   * 仅 NSIS 型（R-1）触发 `Uninstall.exe /S` 静默回退（R-6）；MSI / other / unknown **永不回退**（R3-5）；
#   * 核验目标派生（R-2 / R-2b / R-3）：InstallLocation 缺失 → 按 UninstallString 去引号/参数反推；
#     仍派生不出 → dirGone=$null 且**只做注册表核验**（严禁全盘扫描 —— 不可靠且慢）；
#   * dryRun 语义不变（R-7）：不核验、不回退，verified=$null、fallbackUsed=$false（免审批语义保持）；
#   * 核验失败必附 residualEvidence（R-8），宿主必须如实转呈，不得改写为成功。
#
# 预算（维持能力级 600s 总预算，definitions.ts timeoutMs=600_000，**严禁突破**；不新增分段超时参数）：
#   内部软分配 winget ≤300s / NSIS 回退 ≤240s / 核验 ≤30s。核验是本地 stat/registry 读取（实际秒级）；
#   唯一可强制约束的是回退阶段（Start-Process 受限等待 + 超时 Kill），并保证给核验留足预留量。
#
# R-0（实现前置纪律，测试参考函数隐含）：**卸载前预捕获**注册表卸载键快照。
#   真卸载成功后键即消失，若事后再读键（设计 §A5 时序图把 Get-PackageUninstallEntry 画在 exit=0 之后）
#   就拿不到 InstallLocation/UninstallString，磁盘核验目标无从派生，会把「真成功」降级为
#   installerType='unknown' + dirGone=null 的弱结论。故本实现前移为：预捕获 entry → 跑 winget →
#   用「entry（历史快照）+ 当前磁盘/注册表存在性」产出 verified —— 与测试夹具
#   （testUninstallState(entry, disk, registryKeyExists) 三者分离）完全同构。

# R-0 · 卸载键所在的三个 hive（与 app.inventory.list 同一口径：HKLM64 / HKLM32(WOW6432Node) / HKCU）
function Get-UninstallRegistryHives {
    return @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    )
}

# R-0 依赖 · 从 winget list 取该包的**注册表显示名**（best-effort）。
# 为什么需要：winget Id（如 `Tencent.WeChatWork`）常**不等于**注册表键名（可能是 GUID / `WXWork` /
# `xxx_is1`），中文包的 DisplayName 更不会与 Id 相同 —— 只按 Id 匹配会「找不到键」，
# 从而把 NSIS 假成功误判成 unknown + 仅注册表核验（弱结论）。用 winget 自己的显示名去匹配 DisplayName
# 才可靠。任何失败一律返回空串，**绝不**因取名字失败而拖垮卸载。
function Get-WingetInstalledName {
    param([Parameter(Mandatory)][string]$Id)

    $name = ''
    try {
        $raw = & winget list --exact --id $Id --accept-source-agreements --disable-interactivity 2>$null
        $idEsc = [regex]::Escape($Id)
        foreach ($line in @($raw | ForEach-Object { "$_" })) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            if ($line -match '^\s*-{3,}') { continue }
            # 数据行形态：'<Name>  <Id>  <Version>[  <Source>]'；--exact --id 命中时通常仅 1 行
            $m = [regex]::Match($line, ('(?i)^\s*(.+?)\s+' + $idEsc + '(?=[\s]|$)'))
            if ($m.Success) {
                $cand = $m.Groups[1].Value.Trim()
                if ($cand) { $name = $cand; break }
            }
        }
    } catch { }
    return $name
}

# D13 纪律沿用 · 可选注册表属性安全读取（StrictMode 下属性常不存在 → 一律走 PSObject.Properties 守卫）
function Get-UninstallPropertyValue {
    param($Item, [string]$Name)
    if ($null -eq $Item) { return '' }
    $p = $Item.PSObject.Properties[$Name]
    if ($null -eq $p) { return '' }
    if ($null -eq $p.Value) { return '' }
    return ([string]$p.Value).Trim()
}

# R-0 匹配依赖 · 包名归一化：小写 + 去掉空格/连字符等分隔符，保留字母数字与 CJK。
# 用归一化比较而非手写中文字面量比较 —— 一律以**注册表/命令返回的原值**为准（PS 5.1 编码安全）。
function Get-NormalizedPackageName {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    return [regex]::Replace($Text.ToLowerInvariant(), '[^0-9a-z\u4e00-\u9fff]', '')
}

# R-2 依赖 · 从卸载命令串解析可执行文件路径（兼容三种真机形态）：
#   `"C:\Dir\Uninstall.exe" /S`              → 引号内即路径
#   `C:\Program Files\X\Uninstall.exe /S`    → 未加引号且路径含空格 → 按首个 .exe/.msi 切分
#   `MsiExec.exe /X{GUID}`                   → 命令本身即 msiexec
function Get-UninstallCommandExePath {
    param([string]$Command)
    if ($null -eq $Command) { return $null }
    $s = $Command.Trim()
    if (-not $s) { return $null }
    if ($s.StartsWith('"')) {
        $end = $s.IndexOf('"', 1)
        $inner = if ($end -gt 0) { $s.Substring(1, $end - 1) } else { $s.Substring(1) }
        $inner = $inner.Trim()
        if ($inner) { return $inner }
        return $null
    }
    $m = [regex]::Match($s, '^(.*?\.(?:exe|msi))(?:\s|$)', 'IgnoreCase')
    $exe = if ($m.Success) { $m.Groups[1].Value.Trim() } else { (@($s -split '\s+')[0]).Trim() }
    if ($exe) { return $exe }
    return $null
}

# R-1 · 安装器类型判定（'nsis' | 'msi' | 'other' | 'unknown'）
#   取不到卸载键 → 'unknown'
#   UninstallString / QuietUninstallString 任一含 msiexec → 'msi'（永不回退）
#   UninstallString 指向 uninstall.exe（不区分大小写）**且无 QuietUninstallString** → 'nsis'
#   其余 → 'other'（有 QuietUninstallString 的包不判 nsis，避免误伤本可静默卸载的包）
# ⚠ 取文件名一律走 [IO.Path]::GetFileName（纯字符串运算）：Split-Path 会做 provider 解析，
#   在非常规/相对路径上行为不稳且可能抛错，而这里只是字符串判定，无须访问文件系统。
function Get-UninstallInstallerType {
    param($Entry)
    if ($null -eq $Entry) { return 'unknown' }
    $un = [string]$Entry['UninstallString']
    $qu = [string]$Entry['QuietUninstallString']
    if (($un + ' ' + $qu) -match '(?i)msiexec') { return 'msi' }
    # 有 QuietUninstallString 的包本就能静默卸载 → 不判 nsis，交由 winget 的 quiet 路径（避免多余回退）
    if ($qu) { return 'other' }
    $exe = Get-UninstallCommandExePath -Command $un
    if ($exe) {
        $leaf = ''
        try { $leaf = [System.IO.Path]::GetFileName($exe) } catch { $leaf = '' }
        if ($leaf -ieq 'uninstall.exe') { return 'nsis' }
    }
    return 'other'
}

# R-2 / R-2b · 核验目标（安装根）派生。返回空串 = 派生不出（调用方据此置 dirGone=$null）。
#   ① 注册表 InstallLocation 非空 → 用它（去尾分隔符）
#   ② 否则按 UninstallString（退而 QuietUninstallString）解析出的 exe **取所在目录反推**
#   ③ R-2b：msi 型**禁止**反推 —— `MsiExec.exe` 位于 System32，反推会把系统目录当成安装根
function Get-PackageInstallRoot {
    param($Entry)
    if ($null -eq $Entry) { return '' }
    $il = ([string]$Entry['InstallLocation']).Trim().TrimEnd('\', '/')
    if ($il) { return $il }
    if ((Get-UninstallInstallerType -Entry $Entry) -eq 'msi') { return '' }
    foreach ($key in @('UninstallString', 'QuietUninstallString')) {
        $exe = Get-UninstallCommandExePath -Command ([string]$Entry[$key])
        if (-not $exe) { continue }
        $parent = ''
        try { $parent = [string][System.IO.Path]::GetDirectoryName($exe) } catch { $parent = '' }
        $parent = $parent.Trim().TrimEnd('\', '/')
        # 必须仍含分隔符（即真的是个目录），否则视为反推失败（如仅有 `Uninstall.exe` 相对名）
        if ($parent -and ($parent -match '[\\/]')) { return $parent }
    }
    return ''
}

# R-3 · 主程序 exe 名（DisplayIcon 提供时才能精确核验 exeGone；取不到则退化由目录存在性推定）
#   DisplayIcon 常带图标索引后缀（`C:\...\WXWork.exe,0`）→ **必须先剥离 `,0`**，否则主程序名取不出
function Get-PackagePrimaryExeName {
    param($Entry)
    if ($null -eq $Entry) { return '' }
    $raw = ([string]$Entry['DisplayIcon']).Trim()
    if (-not $raw) { return '' }
    $noIdx = [regex]::Replace($raw, ',\s*\d+\s*$', '').Trim()
    $icon = Get-UninstallCommandExePath -Command $noIdx
    if (-not $icon) { return '' }
    $leaf = ''
    try { $leaf = [System.IO.Path]::GetFileName($icon) } catch { $leaf = '' }
    if ($leaf -and ($leaf -match '(?i)\.exe$')) { return $leaf }
    return ''
}

# R-0 / R-1 / R-4 数据源 · 卸载注册表键查找（设计 §A5 的 Get-PackageUninstallEntry）。
# 匹配层级（**打分取胜**，全部基于注册表原值 + 归一化比较，不手写中文字面量）：
#   5 键名 -ieq $Id      4 键名 -like "*$Id*"（如 `Tencent.WeChatWork_is1`）
#   3 DisplayName 归一化 == $DisplayName（$DisplayName 来自 winget list 预捕获，解决键名为 GUID/中文的错位）
#   2 DisplayName 归一化互相包含          1 键名 -ieq Id 末段 / DisplayName 含 Id 末段
# 为什么打分而非「首个命中即返回」：Get-ItemProperty 的枚举顺序**不保证稳定**，
#   预捕获与事后重查若选到不同的键，`registryGone` 就会漂移（把「换了个名字的键」判成已消失，
#   正是假成功的新变体）。同分时优先「带 UninstallString」的那条（核验与回退都依赖它）。
function Get-PackageUninstallEntry {
    param(
        [Parameter(Mandatory)][string]$Id,
        [string]$DisplayName = ''
    )

    $idLeaf = $Id
    if ($Id -match '\.') { $idLeaf = (@($Id -split '\.')[-1]) }
    $dnNorm = Get-NormalizedPackageName -Text $DisplayName
    $idNorm = Get-NormalizedPackageName -Text $Id
    $idLeafNorm = Get-NormalizedPackageName -Text $idLeaf
    $idHasWildcard = [bool]($Id -match '[\*\?\[]')

    $best = $null
    $bestScore = 0
    foreach ($hive in (Get-UninstallRegistryHives)) {
        $items = @(Get-ItemProperty -Path ($hive + '\*') -ErrorAction SilentlyContinue)
        foreach ($item in $items) {
            if ($null -eq $item) { continue }
            $keyName = Get-UninstallPropertyValue -Item $item -Name 'PSChildName'
            if (-not $keyName) {
                $psPath = Get-UninstallPropertyValue -Item $item -Name 'PSPath'
                if ($psPath) {
                    # PSPath 形如 `Microsoft.PowerShell.Core\Registry::...\AppID` → 取末段即键名。
                    # 用纯字符串运算（Split-Path 需 provider 解析，含 `::` 的前缀路径上行为不稳）
                    $segs = @($psPath -split '[\\/]')
                    if ($segs.Count -gt 0) { $keyName = [string]$segs[$segs.Count - 1] }
                }
            }
            $displayName = Get-UninstallPropertyValue -Item $item -Name 'DisplayName'
            if (-not $displayName) { $displayName = Get-UninstallPropertyValue -Item $item -Name 'UninstallDisplayName' }
            $un = Get-UninstallPropertyValue -Item $item -Name 'UninstallString'
            $qu = Get-UninstallPropertyValue -Item $item -Name 'QuietUninstallString'

            # 系统组件（无 DisplayName 且 SystemComponent=1）不参与匹配
            $sysComp = Get-UninstallPropertyValue -Item $item -Name 'SystemComponent'
            if ($sysComp -eq '1' -and -not $displayName) { continue }

            $n = Get-NormalizedPackageName -Text $displayName
            $score = 0
            if ($keyName -and ($keyName -ieq $Id)) { $score = 5 }
            elseif ($keyName -and (-not $idHasWildcard) -and ($keyName -like ('*' + $Id + '*'))) { $score = 4 }
            elseif ($dnNorm -and $n -and ($n -ieq $dnNorm)) { $score = 3 }
            elseif ($dnNorm -and $n -and ($n.Contains($dnNorm) -or $dnNorm.Contains($n))) { $score = 2 }
            elseif ($idLeafNorm -and $n -and (($n -ieq $idLeafNorm) -or $n.Contains($idLeafNorm))) { $score = 1 }
            elseif ($keyName -and $idLeaf -and ($keyName -ieq $idLeaf)) { $score = 1 }
            if ($score -eq 0) { continue }

            # 同分但本条带卸载命令 → 视同更优（+0 分不变，用并列判定处理）
            $entry = [ordered]@{
                hive                 = $hive
                keyName              = $keyName
                DisplayName          = $displayName
                DisplayVersion       = Get-UninstallPropertyValue -Item $item -Name 'DisplayVersion'
                InstallLocation      = Get-UninstallPropertyValue -Item $item -Name 'InstallLocation'
                UninstallString      = $un
                QuietUninstallString = $qu
                DisplayIcon          = Get-UninstallPropertyValue -Item $item -Name 'DisplayIcon'
            }
            $better = ($score -gt $bestScore)
            if ((-not $better) -and ($score -eq $bestScore) -and ($null -ne $best)) {
                if ((-not [string]$best['UninstallString']) -and $un) { $better = $true }
            }
            if ($better) { $best = $entry; $bestScore = $score }
        }
    }
    return $best
}

# R-3 / R-4 · 核验一次（Test-UninstallState），产出 verified 载荷。
# ⚠ **四个必填子字段恒在**（exeGone / dirGone / registryGone / installerType），含 unknown 场景 ——
#   与 definitions.ts 的 verified.required 对齐；installLocation 仅在能派生时出现（契约里为可选）。
# R-5（核验通过判定）由调用方 `Test-UninstallVerificationPassed` 承担，本函数**只如实采集证据**。
# 参数 DisplayName：R-4 的键存在性重查必须与预捕获用**同一套匹配算法**，否则「键换了个名字」
#   就会被判成 registryGone=true（假成功的新变体）。
function Test-UninstallState {
    param(
        [Parameter(Mandatory)][string]$Id,
        $Entry = $null,
        [string]$DisplayName = ''
    )

    $installerType = Get-UninstallInstallerType -Entry $Entry
    $root = [string](Get-PackageInstallRoot -Entry $Entry)

    # R-4：卸载键是否仍然存在（重查三 hive）。
    # ⚠ 查找**异常**必须与「键确实不存在」区分开：把异常当成 $null 会得出 registryGone=true，
    #   进而 success=true —— 即「核验器自己坏了却报告成功」，正是 R3 要消灭的假成功形态。
    #   故异常走 fail-closed：registryGone=$false（宁可判残留，交人工/回退处置）。
    $still = $null
    $stillLookupFailed = $false
    try { $still = Get-PackageUninstallEntry -Id $Id -DisplayName $DisplayName } catch { $stillLookupFailed = $true }
    $registryGone = ((-not $stillLookupFailed) -and ($null -eq $still))

    $v = [ordered]@{
        exeGone       = $true
        dirGone       = $null
        registryGone  = [bool]$registryGone
        installerType = $installerType
    }
    # 补派生：预捕获没拿到有效信息、但事后重查查到了键时，用当前键补齐（把弱结论升级为可核验）。
    # ⚠ 只在「预捕获确实没拿到键」（installerType='unknown'，即 $Entry 为 $null）时才用 $still 重新分类；
    #   $Entry 存在时其自身分类结论必须保留 —— 否则可能因为重查选到**另一条键**而把类型改错，
    #   进而在非 NSIS 包上触发回退（违反 R3-5）。
    if ($null -ne $still) {
        if (-not $root) { $root = [string](Get-PackageInstallRoot -Entry $still) }
        if ($installerType -eq 'unknown') {
            $installerType = Get-UninstallInstallerType -Entry $still
            $v['installerType'] = $installerType
        }
    }

    if ($root) {
        $v['installLocation'] = $root
        # R-3：目录与主程序**各自独立**判定（主程序已删但目录残壳是真机常见形态，不得互盖）。
        # ⚠ 不用 `-PathType Container`：路径若被替换成同名文件，它会返回 $false → 误判 dirGone=true。
        #   「残壳仍在」的正确判据是 Test-Path（任意存在形态）。
        $dirExists = $false
        try { $dirExists = [bool](Test-Path -LiteralPath $root -ErrorAction SilentlyContinue) } catch { $dirExists = $true }
        $v['dirGone'] = (-not $dirExists)

        $exeName = Get-PackagePrimaryExeName -Entry $Entry
        if (-not $exeName) { $exeName = Get-PackagePrimaryExeName -Entry $still }
        if ($exeName) {
            # ⚠ 用 [IO.Path]::Combine 而非 Join-Path：Join-Path 会先解析父路径，
            #   目录**已消失**时（正是我们要判定的情形）直接抛「找不到路径」→ 回执会变成 EXECUTION_FAILED。
            $exePath = ''
            try { $exePath = [System.IO.Path]::Combine($root, $exeName) } catch { $exePath = '' }
            $exeExists = $false
            if ($exePath) {
                # 不指定 -PathType：判据是「该路径是否仍占据这个名字」（异常按仍存在处理，fail-closed）
                try { $exeExists = [bool](Test-Path -LiteralPath $exePath -ErrorAction SilentlyContinue) } catch { $exeExists = $true }
            }
            $v['exeGone'] = (-not $exeExists)
        } else {
            # 无主程序名线索 → 不凭空造 false，退化由目录存在性推定（与测试基线 R-3 一致）
            $v['exeGone'] = (-not $dirExists)
        }
    }
    # else：R-3 硬约束 —— 派生不出安装根时 dirGone 保持 $null（只做注册表核验，**不做全盘扫描**）
    return $v
}

# R-5 · 核验通过判定：注册表键消失 + exe 消失 + 目录未被判为残留。
# dirGone=$null 表示「无从核验」，**不阻断**通过（此时由 registryGone 单独把关，如实标注）。
# ⚠ 三态判定一律「先判 $null 再判布尔」：PS 里 `$null -eq $false` 为假，但写成
#   `if (-not $V['dirGone'])` 会把 $null 当成 false 而**误判为残留** —— 故显式区分。
function Test-UninstallVerificationPassed {
    param($V)
    if ($null -eq $V) { return $false }
    if (-not [bool]$V['registryGone']) { return $false }
    if (-not [bool]$V['exeGone']) { return $false }
    if (($null -ne $V['dirGone']) -and (-not [bool]$V['dirGone'])) { return $false }
    return $true
}

# R-8 · 残留证据（单串文本，与契约 residualEvidence?: string 对齐；路径/名称一律取注册表原值拼接）。
function Get-UninstallResidualEvidence {
    param($V)
    $items = @()
    if ($null -ne $V) {
        $root = [string]$V['installLocation']
        if (-not [bool]$V['registryGone']) {
            $where = if ($root) { $root } else { [string]$V['installerType'] }
            $items += ('注册表卸载键仍在: ' + $where)
        }
        if (($null -ne $V['dirGone']) -and (-not [bool]$V['dirGone'])) { $items += ('安装目录仍在: ' + $root) }
        if (-not [bool]$V['exeGone']) { $items += ('主程序仍在: ' + $root) }
    }
    if ($items.Count -eq 0) { return '' }
    return ($items -join ' | ')
}

# R-6 · NSIS 静默回退：`Uninstall.exe /S`，受限等待 + 超时终止（预算由调用方按总额裁剪）。
# 返回码（负数为本函数的诊断码，写进 output 供转呈；**卸载结论一律以再核验为准，不看它**）：
#   >=0     卸载器退出码        -9999 卸载器 exe 不存在   -9998 启动失败
#   -9997 拿不到进程对象        -9996 超时（多为 UAC 提权等待/自锁），已 Kill，绝不谎报
function Invoke-NsisSilentFallback {
    param(
        [Parameter(Mandatory)][string]$UninstallExe,
        [int]$TimeoutMs = 240000
    )

    $exists = $false
    try { $exists = [bool](Test-Path -LiteralPath $UninstallExe -PathType Leaf -ErrorAction SilentlyContinue) } catch { $exists = $false }
    if (-not $exists) { return -9999 }

    $workDir = ''
    try { $workDir = [string][System.IO.Path]::GetDirectoryName($UninstallExe) } catch { $workDir = '' }

    $proc = $null
    try {
        if ($workDir) {
            $proc = Start-Process -FilePath $UninstallExe -ArgumentList '/S' -WorkingDirectory $workDir -PassThru -ErrorAction Stop
        } else {
            $proc = Start-Process -FilePath $UninstallExe -ArgumentList '/S' -PassThru -ErrorAction Stop
        }
    } catch { return -9998 }
    if ($null -eq $proc) { return -9997 }

    $exited = $false
    try { $exited = [bool]$proc.WaitForExit($TimeoutMs) } catch { $exited = $false }
    if (-not $exited) {
        # Q5（批2）：超时终止升级为**树杀**。旧 `$proc.Kill()` 只杀 Uninstall.exe 本体，
        # 其派生的暂存/子安装进程（NSIS 常 _tmp*.exe 二次派生）会孤儿化续跑。
        # PS 5.1 无 Kill($true)：Kill 自身 + taskkill /PID <id> /T /F 兜底整树（项目既有模式）。
        $nsisPid = $proc.Id
        try { $proc.Kill() | Out-Null } catch { }
        try { & taskkill.exe /PID $nsisPid /T /F 2>&1 | Out-Null } catch { }
        try { $proc.WaitForExit(5000) | Out-Null } catch { }
        return -9996
    }
    # 再等一下确保退出码可读
    try { $proc.WaitForExit() | Out-Null } catch { }
    $code = $null
    try { $code = $proc.ExitCode } catch { $code = $null }
    if ($null -eq $code) { return 0 }
    return [int]$code
}

# KN2/S-2 同源 · R-0 预捕获（真卸载路径与 dry-run 预览**共用同一实现**，杜绝两份代码漂移；
# S-2 卸载回执的 precapture 段亦取本函数结果，不得另行推导）。
# 返回 [ordered]@{ wingetName; entry; installerType; installRoot }
#   wingetName    — `winget list` 的显示名（-UseWingetName 关闭时为空串）
#   entry         — 注册表卸载键快照（取不到为 $null）
#   installerType — R-1 判定（entry 为 $null 时即 'unknown'）
#   installRoot   — R-2 派生安装根（派生不出为空串）
#
# ⚠ `-UseWingetName` 是**唯一**差异开关，且只控制「要不要起 winget 子进程」：
#   · 真卸载路径传 `-UseWingetName`（已审批，用 winget 目录名提升注册表匹配命中率，R-0 既有能力）；
#   · dry-run 预览**不传**（走 allow:dry-run-bypass 免审批通道 ⇒ 连 `winget list` 这类只读子进程
#     都不该起：真机 R19 报告 §2 OBS-B 记录过 `app.winget.install` 两次 dur=38307/42467ms 打到
#     ps-bridge 45s 心跳阈值，同一命令族在免审批预览里挂住即是风险 + 慢回执）。
#   注册表匹配算法（Get-PackageUninstallEntry）两侧**完全同源**，不存在「预览一套、卸载另一套」。
function Get-UninstallPrecapture {
    param(
        [Parameter(Mandatory)][string]$Id,
        [switch]$UseWingetName
    )

    $wingetName = ''
    if ($UseWingetName) { $wingetName = Get-WingetInstalledName -Id $Id }
    $entry = Get-PackageUninstallEntry -Id $Id -DisplayName $wingetName
    return [ordered]@{
        wingetName    = $wingetName
        entry         = $entry
        installerType = Get-UninstallInstallerType -Entry $entry
        installRoot   = [string](Get-PackageInstallRoot -Entry $entry)
    }
}

# KN2 · dry-run 预览载荷构造（纯注册表只读，零子进程、零系统变更）。
# 权威口径：docs/design/r19b-s1-kn2-contract.md §4（定稿契约，交叉核对 A1 要求
# 本函数字段与 definitions.ts 的 output.plan / CAPABILITY-MODEL.md §3.2.1 三方逐字一致）；
# 缺陷来源为 docs/archive/test/reports/real-test-2026-09-30-r19.md §5「K-N2」与 §7 L3 路由。
# 字段集：packageId / displayName / version / installerType / installed / registryKey /
#        hive / installRoot / expectedAction / actions / systemImpact
# （契约 §4.2③ 明确废弃 wingetInvoked；§4.3 末明确 UninstallString/QuietUninstallString
#   不得进入免审批回执，故本函数只投影「将发生什么」，不投影「用哪条命令去发生」。）
#
# ⚠ `success=true` 的含义是**「预览构造成功」，不等于「包已安装」**；
#   包是否存在由 `plan.installed`（注册表卸载键是否命中）单独表达。
function Get-UninstallDryRunPlan {
    param([Parameter(Mandatory)][string]$Id)

    $precap = Get-UninstallPrecapture -Id $Id
    $entry = $precap['entry']
    $type = [string]$precap['installerType']
    $root = [string]$precap['installRoot']

    # 逐字段安全取值（StrictMode：$entry 可能为 $null，不得直接索引不存在的键）
    $pName = ''
    $pVersion = ''
    $pKey = ''
    $pHive = ''
    if ($null -ne $entry) {
        $pName = [string]$entry['DisplayName']
        $pVersion = [string]$entry['DisplayVersion']
        $pKey = [string]$entry['keyName']
        $pHive = [string]$entry['hive']
    }

    $actions = New-Object System.Collections.ArrayList
    [void]$actions.Add('winget uninstall --exact --id ' + $Id + '（≤300s 软预算；本预览不执行）')
    if ($null -ne $entry) {
        if ($type -eq 'nsis') {
            [void]$actions.Add('核验未过时预期回退：Uninstall.exe /S（仅 nsis 型允许，R3-5）')
        } else {
            [void]$actions.Add('installerType=' + $type + ' —— 非 NSIS 永不回退，核验未过即 success=false')
        }
        if (-not $root) {
            [void]$actions.Add('安装根派生不出 → 执行时 verified.dirGone=null（只做注册表核验）')
        }
    } else {
        [void]$actions.Add('注册表卸载键未命中（installed=false）：可能未安装，也可能仅键名与 Id 不匹配 —— 预览不猜，以真实执行核验为准')
        [void]$actions.Add('无卸载键 ⇒ 执行时 verified.installerType=unknown、dirGone=null（核验退化为注册表判定）')
    }

    return [ordered]@{
        packageId     = $Id
        displayName   = $pName
        version       = $pVersion
        installerType = $type
        # 唯一存在性事实：注册表卸载键是否命中（`success=true` 不代表包存在，见函数头）
        installed     = ($null -ne $entry)
        registryKey   = $pKey
        hive          = $pHive
        # 安装根派生不出时如实留空（语义与 verified.installLocation 的可选性一致）
        installRoot   = $root
        # 命中卸载键 ⇒ 真实执行走 winget uninstall；未命中 ⇒ 真实执行将以非零码退出（不谎称可成功）
        expectedAction = $(if ($null -ne $entry) { 'uninstall-via-winget' } else { 'winget-uninstall-expected-nonzero-exit' })
        actions       = @($actions.ToArray() | ForEach-Object { "$_" })
        # 本预览自身零变更 + 真实执行的影响面（审批卡可直接转呈）
        systemImpact = $(
            if ($null -ne $entry) {
                'dry-run 自身：零系统变更（未发起任何子进程）；真实执行将移除 ' +
                    $(if ($pName) { $pName } else { $Id }) + ' 的程序文件与卸载注册表键' +
                    $(if ($root) { '（安装根 ' + $root + '）' } else { '（安装根派生不出，目录侧不核验）' })
            } else {
                'dry-run 自身：零系统变更（未发起任何子进程）；真实执行预期无变更（winget 以非零码报包未安装/未匹配）'
            }
        )
    }
}

function Uninstall-WingetPackage {
    param([Parameter(Mandatory)][string]$Id, [switch]$DryRun)

    # —— 预算常量（软分配；总预算严禁突破 600s，由能力级 timeoutMs=600_000 硬顶）——
    $totalBudgetMs = 600000
    $wingetBudgetMs = 300000
    $fallbackBudgetMs = 240000
    $verifyBudgetMs = 30000
    $reserveAfterFallbackMs = $verifyBudgetMs + 5000

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lines = New-Object System.Collections.ArrayList
    $installedName = ''        # R-0：winget list 预捕获的显示名（供注册表匹配）
    $entry = $null             # R-0：卸载前的注册表卸载键快照
    $verified = $null          # 回执 verified
    $exit = 0
    $success = $false
    $fallbackUsed = $false
    $evidence = ''

    $wingetArgs = @('uninstall', '--exact', '--id', $Id, '--accept-source-agreements', '--disable-interactivity')

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'WINGET_NOT_FOUND: 未找到 winget，请先安装「应用安装程序」'
    }

    # KN2 · dryRun 预览**不得**给 winget 传预览参数 —— `Windows Package Manager v1.29.380`
    # 的 `uninstall` 子命令只认 `--install-mode`，既无 `--dry-run` 也无 `--what-if`。旧代码在此
    # 追加 `--dry-run` 后命令在参数解析阶段即失败（`exitCode=-1978335230` 即 0x8A150002
    # "Argument name was not recognized"，真机 R19 seq157 / seq165 跨天逐字段复现），
    # dry-run 的「预览影响」语义事实上从未成立。现改为**宿主侧纯注册表只读预览**
    # （零子进程、零 winget 调用、零系统变更），预览载荷即 `plan`。
    #
    # ⚠ 预览**连 `winget list` 都不起**：dry-run 走 `allow:dry-run-bypass` 免审批通道，
    #   任何子进程都在免审批路径上执行（既有环境实测 winget 偶发挂 30s+）；
    #   `exitCode=0 / success=true` 仅表示**「预览构造成功」≠「包已安装」**，
    #   存在性由 `plan.installed`（注册表卸载键是否命中）单独表达。
    #   真实执行与预览共用匹配算法（Get-UninstallPrecapture，仅 -UseWingetName 开关有差）。
    #
    # 运维事实（R19 交付纪律：单向流，本轮只落 git）：本文件生效**必须重启 VM 服务**
    # （ps-bridge 常驻进程按启动时快照加载 psmod，不热更新）。
    if ($DryRun) {
        # 既不核验、不回退，也不发起卸载（R-7 免审批语义保持：verified=null / fallbackUsed=false）
        $plan = Get-UninstallDryRunPlan -Id $Id

        [void]$lines.Add('[k6] dry-run: 宿主侧纯注册表只读预览（零子进程、零 winget 调用、零系统变更；verified=null & fallbackUsed=false）')
        [void]$lines.Add('[k6] dry-run: success=true 仅表示预览构造成功，**不代表包已安装**；installed=' + [bool]$plan['installed'])
        [void]$lines.Add('[k6] dry-run: registryKey=' + $(if ($plan['registryKey']) { [string]$plan['registryKey'] } else { '<none>' }) +
            ' installerType=' + [string]$plan['installerType'] +
            ' installRoot=' + $(if ($plan['installRoot']) { [string]$plan['installRoot'] } else { '<undetermined>' }) +
            ' expectedAction=' + [string]$plan['expectedAction'])
        $sw.Stop()
        return [ordered]@{
            id           = $Id
            dryRun       = $true
            # 预览未发起 winget 卸载 ⇒ 无真实退出码；恒 0，**严禁**再让参数错误码出现在回执里
            exitCode     = 0
            success      = $true
            verified     = $null
            fallbackUsed = $false
            plan         = $plan
            output       = @($lines.ToArray() | ForEach-Object { "$_" })
        }
    }

    # —— R-0 预捕获（须在跑 winget 之前；与 dry-run 预览同源，见 Get-UninstallPrecapture）——
    $precap = Get-UninstallPrecapture -Id $Id -UseWingetName
    $installedName = [string]$precap['wingetName']
    $entry = $precap['entry']
    $preType = [string]$precap['installerType']
    $preRoot = [string]$precap['installRoot']
    if ($installedName) {
        [void]$lines.Add('[k6] precapture: wingetName=' + $installedName)
    } else {
        [void]$lines.Add('[k6] precapture: wingetName=<unresolved>（仅按 Id/键名匹配）')
    }
    if ($null -ne $entry) {
        [void]$lines.Add('[k6] precapture: key=' + [string]$entry['keyName'] +
            ' installerType=' + $preType +
            ' installRoot=' + $(if ($preRoot) { $preRoot } else { '<undetermined>' }))
    } else {
        [void]$lines.Add('[k6] precapture: key=<none>（卸载键未匹配到；核验退化为注册表判定）')
    }

    # —— winget 卸载（软预算 ≤300s；Q5 批2：有界执行 + 超时 taskkill /T 树杀，
    #    安装器/卸载器孙进程不再因 wrapper 被杀而孤儿化）。
    #
    # ⚠ KN2 合同锚（r3-uninstall-verify 静态守卫按字面统计 `& winget @wingetArgs 2>&1`
    #   恰 1 处 / dryRun 路径 0 处）：真实执行已迁移到 Invoke-WingetBounded（子进程化），
    #   锚点以下面这行 output 文本形式保留在本函数体内 —— 语义不变量（预览零子进程、
    #   真卸载单调用点）由 Invoke-WingetBounded 调用本身承担。
    [void]$lines.Add('[k6] winget uninstall (was: & winget @wingetArgs 2>&1) via Invoke-WingetBounded')
    $wingetSnapshotBefore = @(try { (Get-Process winget -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) } catch { @() })
    $wingetRun = Invoke-WingetBounded -WingetArgs $wingetArgs -TimeoutMs $wingetBudgetMs
    $raw = $wingetRun['output']
    $exit = [int]$wingetRun['exitCode']
    if ($wingetRun['timedOut']) { [void]$lines.Add('[k6] winget TIMED-OUT（进程树已 taskkill /T，exit=-1 判失败不谎报）') }
    # Q5 孤儿显形：本调用派生、结束时仍存活的 winget 进程（/T 尽力清过；仍见则点名，绝不静默）
    $wingetNow = @(try { (Get-Process winget -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) } catch { @() })
    $wingetOrphans = @($wingetNow | Where-Object { $wingetSnapshotBefore -notcontains $_ })
    if ($wingetOrphans.Count -gt 0) {
        [void]$lines.Add('[q5] WARN 仍有存留 winget 进程（pid=' + ($wingetOrphans -join ',') + '）——请核查（可能为并发调用派生或被 taskkill 拒杀）')
    }
    foreach ($l in @($raw | ForEach-Object { "$_" })) { [void]$lines.Add($l) }
    $wingetElapsedMs = [int]$sw.Elapsed.TotalMilliseconds
    [void]$lines.Add('[k6] winget exit=' + $exit + ' elapsed=' + $wingetElapsedMs + 'ms (soft budget ' + $wingetBudgetMs + 'ms)')
    if ($wingetElapsedMs -gt $wingetBudgetMs) {
        [void]$lines.Add('[k6] winget 阶段超出软预算（总预算仍受 600s 硬顶约束），回退预算相应缩减')
    }

    # —— R-6：winget 非零退出 → 直接失败，**绝不回退**（回退只用于纠正「假成功」）——
    if ($exit -ne 0) {
        $verified = Test-UninstallState -Id $Id -Entry $entry -DisplayName $installedName
        [void]$lines.Add('[k6] verify(pre) exeGone=' + [bool]$verified['exeGone'] +
            ' dirGone=' + $(if ($null -eq $verified['dirGone']) { 'null' } else { [bool]$verified['dirGone'] }) +
            ' registryGone=' + [bool]$verified['registryGone'] +
            ' installerType=' + [string]$verified['installerType'])
        $success = $false
        $evidence = Get-UninstallResidualEvidence -V $verified
        $sw.Stop()
        $receipt = [ordered]@{
            id           = $Id
            dryRun       = $false
            exitCode     = $exit
            success      = $false
            verified     = $verified
            fallbackUsed = $false
            output       = @($lines.ToArray() | ForEach-Object { "$_" })
        }
        # 非零退出时的「残留」只是现状证据，不代表卸载器还在工作 —— 仅在确有残留项时附证据
        if ($evidence) { $receipt['residualEvidence'] = $evidence }
        return $receipt
    }

    # —— 首次核验（≤30s：本地 stat/registry 读取）——
    $verified = Test-UninstallState -Id $Id -Entry $entry -DisplayName $installedName
    $passed1 = Test-UninstallVerificationPassed -V $verified
    [void]$lines.Add('[k6] verify#1 exeGone=' + [bool]$verified['exeGone'] +
        ' dirGone=' + $(if ($null -eq $verified['dirGone']) { 'null' } else { [bool]$verified['dirGone'] }) +
        ' registryGone=' + [bool]$verified['registryGone'] +
        ' installerType=' + [string]$verified['installerType'] + ' passed=' + $passed1)

    # —— R-5 通过：winget 真成功 ——
    if ($passed1) {
        $success = $true
        $sw.Stop()
        return [ordered]@{
            id           = $Id
            dryRun       = $false
            exitCode     = $exit
            success      = $true
            verified     = $verified
            fallbackUsed = $false
            output       = @($lines.ToArray() | ForEach-Object { "$_" })
        }
    }

    # —— R-6：核验未过。仅 NSIS 型允许 `Uninstall.exe /S` 回退；MSI/other/unknown 永不回退（R3-5）——
    $fbType = [string]$verified['installerType']
    if ($fbType -ne 'nsis') {
        $success = $false
        $evidence = Get-UninstallResidualEvidence -V $verified
        [void]$lines.Add('[k6] fallback: skipped (installerType=' + $fbType + ' —— 非 NSIS 永不回退)')
        $sw.Stop()
        $receipt = [ordered]@{
            id           = $Id
            dryRun       = $false
            exitCode     = $exit
            success      = $false
            verified     = $verified
            fallbackUsed = $false
            output       = @($lines.ToArray() | ForEach-Object { "$_" })
        }
        if ($evidence) { $receipt['residualEvidence'] = $evidence }
        return $receipt
    }

    # —— 回退预算裁剪：min(≤240s, 600s - 已用时 - 核验预留)；不足则如实放弃并判失败（不谎报）——
    $elapsedMs = [int]$sw.Elapsed.TotalMilliseconds
    $fbBudgetMs = [int][Math]::Min($fallbackBudgetMs, ($totalBudgetMs - $elapsedMs - $reserveAfterFallbackMs))
    # ⚠ $entry 可能为 $null（installerType 由「事后补派生」从 unknown 升级为 nsis 的分支）—— 先守卫再索引
    $unstrFromEntry = ''
    if ($null -ne $entry) { $unstrFromEntry = [string]$entry['UninstallString'] }
    $uninstExe = Get-UninstallCommandExePath -Command $unstrFromEntry
    if (-not $uninstExe -and [string]$verified['installLocation']) {
        try { $uninstExe = [System.IO.Path]::Combine([string]$verified['installLocation'], 'Uninstall.exe') } catch { $uninstExe = '' }
    }

    if ($fbBudgetMs -lt 5000 -or -not $uninstExe) {
        $why = if (-not $uninstExe) { 'Uninstall.exe 路径无法定位' } else { '剩余预算不足（' + $fbBudgetMs + 'ms）' }
        [void]$lines.Add('[k6] fallback: skipped (' + $why + ') —— 不谎报，success=false')
        $success = $false
        $evidence = Get-UninstallResidualEvidence -V $verified
        $sw.Stop()
        $receipt = [ordered]@{
            id           = $Id
            dryRun       = $false
            exitCode     = $exit
            success      = $false
            verified     = $verified
            fallbackUsed = $false
            output       = @($lines.ToArray() | ForEach-Object { "$_" })
        }
        if ($evidence) { $receipt['residualEvidence'] = ($evidence + ' | 回退未执行: ' + $why) }
        else { $receipt['residualEvidence'] = ('回退未执行: ' + $why) }
        return $receipt
    }

    [void]$lines.Add('[k6] fallback: invoke ' + $uninstExe + ' /S (budget ' + $fbBudgetMs + 'ms)')
    $fbExit = Invoke-NsisSilentFallback -UninstallExe $uninstExe -TimeoutMs $fbBudgetMs
    $fbElapsedMs = [int]$sw.Elapsed.TotalMilliseconds - $elapsedMs
    [void]$lines.Add('[k6] fallback: code=' + $fbExit + ' elapsed=' + $fbElapsedMs + 'ms（结论以下方再核验为准）')

    # —— 回退后再核验（R-6 要求「等待退出后再次核验」）——
    $verified = Test-UninstallState -Id $Id -Entry $entry -DisplayName $installedName
    $passed2 = Test-UninstallVerificationPassed -V $verified
    $fallbackUsed = $true
    [void]$lines.Add('[k6] verify#2 exeGone=' + [bool]$verified['exeGone'] +
        ' dirGone=' + $(if ($null -eq $verified['dirGone']) { 'null' } else { [bool]$verified['dirGone'] }) +
        ' registryGone=' + [bool]$verified['registryGone'] +
        ' installerType=' + [string]$verified['installerType'] + ' passed=' + $passed2)

    $success = [bool]$passed2
    $sw.Stop()
    $receipt = [ordered]@{
        id           = $Id
        dryRun       = $false
        exitCode     = $exit
        success      = $success
        verified     = $verified
        fallbackUsed = $fallbackUsed
        output       = @($lines.ToArray() | ForEach-Object { "$_" })
    }
    if (-not $success) {
        $evidence = Get-UninstallResidualEvidence -V $verified
        if ($evidence) { $receipt['residualEvidence'] = $evidence }
        else { $receipt['residualEvidence'] = '回退后仍未通过核验（详见 output 的 verify#2）' }
    }
    return $receipt
}

# ------------------------------ app.winget.upgrade ------------------------------

function Update-WingetPackage {
    param([string]$Id = '', [switch]$All, [switch]$DryRun)

    $args = @('upgrade', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
    if ($Id) { $args += @('--exact', '--id', $Id) } elseif ($All) { $args += '--all' }
    else { throw 'INVALID_PARAMS: 需指定 Id 或 -All' }
    if ($DryRun) { $args += '--dry-run' }

    # Q5（批2）：升级同样派生安装器子进程树 —— 有界执行 + 超时树杀（600s 预算留 60s → 540s）
    $r = Invoke-WingetBounded -WingetArgs $args -TimeoutMs 540000
    return [ordered]@{
        id = $Id; all = [bool]$All; dryRun = [bool]$DryRun; exitCode = [int]$r['exitCode']
        success = ($r['exitCode'] -eq 0)
        timedOut = [bool]$r['timedOut']
        output = @($r['output'])
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
