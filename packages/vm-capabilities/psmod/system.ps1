<#
.SYNOPSIS
    WinVM Bridge —— system 能力域（系统管理，FR-201）

.NOTES
    所有函数**只返回结果对象**，禁止直接 Write-Output 到 stdout：
    stdout 是 ps-bridge 的 NDJSON 协议通道，任何杂散输出都会破坏帧。
    诊断信息请写 Write-Warning / Write-Verbose（会被 ps-bridge 收集为 warnings）。
#>

# ------------------------------ system.info.get ------------------------------

function Get-SystemInfo {
    [OutputType([hashtable])]
    param()

    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem
    $cpu = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1

    $bootTime = $null
    if ($os.LastBootUpTime) { $bootTime = $os.LastBootUpTime.ToString('o') }

    return [ordered]@{
        computerName    = $env:COMPUTERNAME
        userName        = "$env:USERDOMAIN\$env:USERNAME"
        caption         = $os.Caption
        version         = $os.Version
        buildNumber     = $os.BuildNumber
        architecture    = $os.OSArchitecture
        totalMemoryMB   = [math]::Round($os.TotalVisibleMemorySize / 1KB, 0)
        freeMemoryMB    = [math]::Round($os.FreePhysicalMemory / 1KB, 0)
        cpu             = $cpu.Name
        cores           = $cs.NumberOfLogicalProcessors
        domain          = $cs.Domain
        partOfDomain    = [bool]$cs.PartOfDomain
        lastBootUpTime  = $bootTime
        sessionId       = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        powershellVer   = $PSVersionTable.PSVersion.ToString()
        isAdmin         = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
                            ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
}

# ------------------------------ system.service.list ------------------------------

function Get-ServiceList {
    param(
        [string]$Name = '',
        [string]$Status = ''
    )

    # D6：一次性取全部服务的启动模式建 Name→StartMode 字典，O(1) 查表。
    # 旧实现对每个服务各跑一次 Get-CimInstance -Filter（N≈数百次 WMI 往返），
    # 无 name 过滤时必超时（实测 30s 超时）。现在只 1 次 CIM 查询。
    $startMap = @{}
    try {
        foreach ($s in (Get-CimInstance -ClassName Win32_Service -ErrorAction SilentlyContinue)) {
            $startMap[$s.Name] = $s.StartMode
        }
    }
    catch { }

    $svc = Get-Service
    if ($Name)   { $svc = $svc | Where-Object { $_.Name -like "*$Name*" -or $_.DisplayName -like "*$Name*" } }
    if ($Status) { $svc = $svc | Where-Object { $_.Status -eq $Status } }

    # D10：列表语义 —— 空/单元素由 provider 端按 output.array 强制保形为数组，
    # 这里直接返回集合即可（PowerShell 的 return @() 展开行为不再影响外部契约）。
    $list = @($svc | ForEach-Object {
        $st = ''
        if ($startMap.ContainsKey($_.Name) -and $null -ne $startMap[$_.Name]) { $st = [string]$startMap[$_.Name] }
        [ordered]@{
            name        = $_.Name
            displayName = $_.DisplayName
            status      = $_.Status.ToString()
            startType   = $st
        }
    })
    return $list
}

# ------------------------------ system.service.control ------------------------------

function Invoke-ServiceControl {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('start', 'stop', 'restart')][string]$Action
    )

    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { throw "SERVICE_NOT_FOUND: 服务不存在 —— $Name" }

    switch ($Action) {
        'start'   { Start-Service -Name $Name -ErrorAction Stop }
        'stop'    { Stop-Service -Name $Name -Force -ErrorAction Stop }
        'restart' { Restart-Service -Name $Name -Force -ErrorAction Stop }
    }

    $after = Get-Service -Name $Name
    return [ordered]@{
        name      = $after.Name
        action    = $Action
        status    = $after.Status.ToString()
        changedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

# ------------------------------ system.service.configure ------------------------------

function Set-ServiceConfig {
    param(
        [Parameter(Mandatory)][string]$Name,
        [ValidateSet('Automatic', 'Manual', 'Disabled', 'AutomaticDelayedStart')][string]$StartType = ''
    )

    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { throw "SERVICE_NOT_FOUND: 服务不存在 —— $Name" }

    if ($StartType) { Set-Service -Name $Name -StartupType $StartType -ErrorAction Stop }

    $cim = Get-CimInstance -ClassName Win32_Service -Filter "Name='$Name'"
    return [ordered]@{
        name      = $Name
        startType = $cim.StartMode
        status    = (Get-Service -Name $Name).Status.ToString()
    }
}

# ------------------------------ system.process.list ------------------------------

function Get-ProcessList {
    param(
        [string]$Name = '',
        [int]$Top = 0,
        [string]$SortBy = 'Cpu'
    )

    $procs = Get-CimInstance -ClassName Win32_Process
    if ($Name) { $procs = $procs | Where-Object { $_.Name -like "*$Name*" } }

    $list = @($procs | ForEach-Object {
        [ordered]@{
            processId   = $_.ProcessId
            name        = $_.Name
            sessionId   = $_.SessionId
            # 注意：`??` 是 PowerShell 7+ 语法，Windows PowerShell 5.1 不支持。
            # 用 [double] 强转处理 null（$null 转 double 得 0），保证 5.1 兼容。
            workingSetMB = [math]::Round(([double]$_.WorkingSetSize) / 1MB, 1)
            commandLine = $_.CommandLine
        }
    })

    # ⚠ PS 5.1 陷阱（CL-017 N2 同类）：[ordered]@{} 列表上 `-Property workingSetMB` 静默不排序 → Top-N 失真。
    #   改用脚本块访问器 + [double] 强转，保证按内存占用严格降序。切勿改回 `-Property workingSetMB`。
    if ($SortBy -eq 'Cpu') { $list = $list | Sort-Object -Property { [double]$_.workingSetMB } -Descending }
    if ($Top -gt 0) { $list = $list | Select-Object -First $Top }
    return $list
}

# ------------------------------ system.process.terminate ------------------------------

function Stop-ProcessTree {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [switch]$Force
    )

    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { throw "PROCESS_NOT_FOUND: 进程不存在 —— PID $ProcessId" }

    $protected = @('lsass', 'csrss', 'winlogon', 'services', 'smss', 'wininit', 'system')
    if ($protected -contains ($proc.ProcessName.ToLowerInvariant())) {
        throw "PROTECTED_PROCESS: 受保护进程，禁止终止 —— $($proc.ProcessName)"
    }

    $children = Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ParentProcessId -eq $ProcessId }
    foreach ($c in $children) {
        try { Stop-ProcessTree -ProcessId $c.ProcessId -Force:$Force } catch { }
    }

    if ($Force) { Stop-Process -Id $ProcessId -Force -ErrorAction Stop }
    else { Stop-Process -Id $ProcessId -ErrorAction Stop }

    return [ordered]@{ processId = $ProcessId; terminated = $true; at = (Get-Date).ToUniversalTime().ToString('o') }
}

# ------------------------------ system.task.scheduled ------------------------------

function Get-ScheduledTaskInfo {
    param([string]$Name = '')

    $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue
    if ($Name) { $tasks = $tasks | Where-Object { $_.TaskName -like "*$Name*" } }

    return @($tasks | ForEach-Object {
        $info = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
        [ordered]@{
            name         = $_.TaskName
            path         = $_.TaskPath
            state        = $_.State.ToString()
            lastRunTime  = if ($info -and $info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }
            nextRunTime  = if ($info -and $info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }
            lastResult   = if ($info) { $info.LastTaskResult } else { $null }
        }
    })
}

# ------------------------------ system.registry.read / write ------------------------------

# D9：注册表路径必须带根键冒号（`HKLM:\...`）。用户凭 Windows 习惯常写 `HKLM\...`（无冒号），
# PowerShell 会把它当成相对驱动器路径 → Test-Path/Get-ItemProperty 失败（真机表现为
# 「REG_PATH_NOT_FOUND」）。这里统一补冒号，使 `HKLM\SOFTWARE\...` 与 `HKLM:\SOFTWARE\...` 等价。
# 与策略层 core/policy/engine.ts 的 normalizeRegistryPath() 保持一致（双端同样宽松）。
function ConvertTo-RegistryPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
    if ($Path -match '^(HK[A-Z_]+|HKEY_[A-Z_]+)(?!:)([\\/].*)?$') {
        return (($Matches[1] + ':' + $Matches[2]) -replace '/', '\')
    }
    return $Path
}

function Read-RegistryValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Name = ''
    )

    $Path = ConvertTo-RegistryPath $Path
    if (-not (Test-Path -LiteralPath $Path)) { throw "REG_PATH_NOT_FOUND: 注册表路径不存在 —— $Path" }

    $item = Get-ItemProperty -LiteralPath $Path -ErrorAction Stop
    if ($Name) {
        return [ordered]@{ path = $Path; name = $Name; value = $item.$Name }
    }
    # 去掉 PS 自动属性后返回
    $skip = @('PSPath', 'PSParentPath', 'PSChildName', 'PSDrive', 'PSProvider')
    $out = [ordered]@{}
    foreach ($p in $item.PSObject.Properties) {
        if ($skip -contains $p.Name) { continue }
        $out[$p.Name] = $p.Value
    }
    return [ordered]@{ path = $Path; values = $out }
}

function Write-RegistryValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)]$Value,
        [string]$Type = 'String'
    )

    $Path = ConvertTo-RegistryPath $Path
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -Path $Path -Force -ErrorAction Stop | Out-Null
    }
    Set-ItemProperty -LiteralPath $Path -Name $Name -Value $Value -Type $Type -Force -ErrorAction Stop
    $after = (Get-ItemProperty -LiteralPath $Path).$Name
    return [ordered]@{ path = $Path; name = $Name; value = $after; changedAt = (Get-Date).ToUniversalTime().ToString('o') }
}

# ------------------------------ system.network.config (CL-018 C5) ------------------------------
#
# 背景：网络配置采集冷调用 5–8s（WMI/CIM 首次装载 + DNS 枚举），是宿主 system.* 调用的长尾。
# 方案：**进程内 TTL 缓存**（默认 45s，env `WINVM_NETCFG_TTL_MS` 可覆盖）：
#   * 命中（未过期且非 refresh）→ 直接返回缓存，附 `cached=true` / `cacheAgeMs` / `collectedAt`；
#   * `refresh=true` → **绕过缓存**强制重新采集（AC5）；
#   * vm-service 启动时**异步预热**一次 → 使"服务重启后的首次调用"也命中缓存（AC5 冷启动 ≤3s）。
# 缓存挂在 ps-bridge 常驻进程的**脚本作用域**（跨调用复用），进程重启即自然失效。
# 缓存键含 IncludeRoutes（两种载荷不同），避免互相覆盖。

# ⚠ StrictMode 陷阱：ps-bridge 以 `Set-StrictMode -Version 1` 运行 —— **引用未初始化变量会抛错**。
#   故这里用**无条件赋值**初始化缓存（本文件在 ps-bridge 启动时 dot-source 一次）。
#   切勿写成 `if ($null -eq $script:NetCfgCache) { ... }`：对未初始化变量的读取会抛错，
#   导致整个 system 模块 dot-source 失败（表现为所有 system.* 能力报 MODULE_NOT_PRELOADED）。
$script:NetCfgCache = @{}

# TTL 解析：非法值（NaN/≤0）回退默认 —— 服务不得因坏 env 失败
function Get-NetCfgTtlMs {
    $raw = $env:WINVM_NETCFG_TTL_MS
    if ($raw) {
        $n = 0
        if ([int]::TryParse($raw, [ref]$n) -and $n -gt 0) { return $n }
    }
    return 45000
}

function Get-NetworkConfig {
    param(
        [switch]$IncludeRoutes,
        [switch]$Refresh
    )

    $ttlMs = Get-NetCfgTtlMs
    $ttlTicks = [int64]$ttlMs * 10000          # ms → 100ns ticks（避免依赖 .NET 时间 API 版本）
    $nowTicks = (Get-Date).ToUniversalTime().Ticks
    $key = 'adapters'
    if ($IncludeRoutes) { $key = 'adapters+routes' }

    # —— 命中缓存（未过期且非 refresh）——
    if (-not $Refresh -and $script:NetCfgCache.ContainsKey($key)) {
        $entry = $script:NetCfgCache[$key]
        $ageTicks = $nowTicks - [int64]$entry.atTicks
        if ($ageTicks -lt $ttlTicks) {
            $hit = [ordered]@{}
            foreach ($k in $entry.data.Keys) { $hit[$k] = $entry.data[$k] }
            $hit['cached']      = $true
            $hit['cacheAgeMs']  = [int64][math]::Floor($ageTicks / 10000)
            $hit['collectedAt'] = $entry.collectedAt
            return $hit
        }
    }

    # —— 冷采集 ——
    # D12：必须把 CIM 对象**投影**为纯数据（gateway 直接回 CimInstance 会递归带 CimClass 元数据、
    # 载荷膨胀；DNS 需去重）。
    $adapters = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | ForEach-Object {
        [ordered]@{
            interfaceAlias = $_.InterfaceAlias
            interfaceIndex = $_.InterfaceIndex
            ipv4Address    = @($_.IPv4Address | ForEach-Object { $_.IPAddress })
            ipv6Address    = @($_.IPv6Address | ForEach-Object { $_.IPAddress })
            gateway        = @($_.IPv4DefaultGateway | ForEach-Object {
                [ordered]@{ nextHop = $_.NextHop; routeMetric = $_.RouteMetric }
            })
            dnsServers     = @($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } |
                ForEach-Object { $_.ServerAddresses } | Select-Object -Unique)
        }
    })

    $collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    $data = [ordered]@{ adapters = $adapters }
    if ($IncludeRoutes) {
        # CL-019 项②：字段名统一 —— 原 `metric` 与 `adapters[].gateway[].routeMetric` 同源不同名，
        # 违反 CL-017/CL-018 契约（S15 写明 routes 投影 `[{nextHop, routeMetric}]`）。现统一为 `routeMetric`。
        $data['routes'] = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Select-Object -First 30 |
            ForEach-Object { [ordered]@{ destination = $_.DestinationPrefix; nextHop = $_.NextHop; routeMetric = $_.RouteMetric } })
    }

    # 写入缓存（仅缓存**纯采集数据**，绝不把 cached 标志写进缓存）
    $script:NetCfgCache[$key] = [ordered]@{ atTicks = $nowTicks; collectedAt = $collectedAt; data = $data }

    $result = [ordered]@{}
    foreach ($k in $data.Keys) { $result[$k] = $data[$k] }
    $result['cached']      = $false
    $result['cacheAgeMs']  = 0
    $result['collectedAt'] = $collectedAt
    return $result
}

# ------------------------------ system.user.manage ------------------------------

function Get-LocalUserInfo {
    param([string]$Name = '')

    $users = Get-LocalUser -ErrorAction SilentlyContinue
    if ($Name) { $users = $users | Where-Object { $_.Name -like "*$Name*" } }

    return @($users | ForEach-Object {
        [ordered]@{
            name        = $_.Name
            enabled     = [bool]$_.Enabled
            description = $_.Description
            lastLogon   = if ($_.LastLogon) { $_.LastLogon.ToString('o') } else { $null }
        }
    })
}

# ------------------------------ system.env.manage ------------------------------

function Get-EnvironmentVariableInfo {
    param([string]$Name = '', [string]$Target = 'User')

    if ($Name) {
        $v = [Environment]::GetEnvironmentVariable($Name, $Target)
        return [ordered]@{ name = $Name; target = $Target; value = $v }
    }

    $scope = if ($Target -eq 'Machine') { 'Machine' } else { 'User' }
    $regPath = "HKCU:\Environment"
    if ($scope -eq 'Machine') { $regPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' }

    $out = [ordered]@{}
    if (Test-Path -LiteralPath $regPath) {
        $item = Get-ItemProperty -LiteralPath $regPath
        $skip = @('PSPath', 'PSParentPath', 'PSChildName', 'PSDrive', 'PSProvider')
        foreach ($p in $item.PSObject.Properties) {
            if ($skip -contains $p.Name) { continue }
            $out[$p.Name] = $p.Value
        }
    }
    return [ordered]@{ target = $Target; variables = $out }
}

function Set-EnvironmentVariableInfo {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string]$Value = '',
        [ValidateSet('User', 'Machine')][string]$Target = 'User'
    )

    [Environment]::SetEnvironmentVariable($Name, $Value, $Target)
    return [ordered]@{ name = $Name; value = $Value; target = $Target; changedAt = (Get-Date).ToUniversalTime().ToString('o') }
}

# ------------------------------ system.eventlog.query ------------------------------

function Get-EventLogEntries {
    param(
        [string]$LogName = 'System',
        [int]$MaxEvents = 50,
        [string]$Level = ''
    )

    $filter = @{ LogName = $LogName }
    if ($Level) {
        # D7：Get-WinEvent 的 FilterHashtable 不接受 `LevelDisplayName`（Windows PowerShell 5.1 非法键，
        #     任何取值都查不到 → level 恒空）。合法键是数字 `Level`，故把级别名映射为数字。
        # 同时接受中英文别名（Error/错误、Warning/警告、Information/信息、Critical/严重、Verbose/详细）。
        $levelMap = @{
            'critical' = 1; '严重' = 1; 'crit' = 1
            'error' = 2; '错误' = 2
            'warning' = 3; '警告' = 3; 'warn' = 3
            'information' = 4; '信息' = 4; 'info' = 4
            'verbose' = 5; '详细' = 5
        }
        $key = $Level.Trim().ToLowerInvariant()
        if ($levelMap.ContainsKey($key)) {
            $filter['Level'] = $levelMap[$key]
        }
        else {
            # 未识别：接受纯数字（1-5），否则明确报错而非静默返回空
            $num = 0
            if ([int]::TryParse($key, [ref]$num) -and $num -ge 1 -and $num -le 5) {
                $filter['Level'] = $num
            }
            else {
                throw "INVALID_ARGUMENT: 无法识别的事件级别「$Level」。可用：Critical/Error/Warning/Information/Verbose（或 1-5）"
            }
        }
    }

    $events = Get-WinEvent -FilterHashtable $filter -MaxEvents $MaxEvents -ErrorAction SilentlyContinue
    return @($events | ForEach-Object {
        # 注意：必须先在**替换后**的字符串上取长度再 Substring。
        # `-replace "\r?\n"` 会把 2 个字符压成 1 个，若用原始 Length 去 Substring 会越界
        # （真机报「索引和长度必须引用该字符串内的位置」）。Message 也可能为 $null。
        $msg = "$($_.Message)"
        $msg = ($msg -replace "`r?`n", ' ')
        $msg = $msg.Substring(0, [Math]::Min(500, $msg.Length))
        [ordered]@{
            timeCreated = $_.TimeCreated.ToString('o')
            provider    = $_.ProviderName
            id          = $_.Id
            level       = $_.LevelDisplayName
            message     = $msg
        }
    })
}

# ------------------------------ system.power.control (L3) ------------------------------

function Invoke-PowerControl {
    param(
        [Parameter(Mandatory)][ValidateSet('shutdown', 'restart', 'hibernate', 'sleep')][string]$Action,
        [int]$DelaySeconds = 30,
        [switch]$DryRun
    )

    $plan = [ordered]@{ action = $Action; delaySeconds = $DelaySeconds; dryRun = [bool]$DryRun }
    if ($DryRun) {
        return [ordered]@{ ok = $true; dryRun = $true; plan = $plan; note = '未实际执行（dry-run）' }
    }

    switch ($Action) {
        'shutdown'  { shutdown.exe /s /t $DelaySeconds /c 'WinVM Bridge scheduled shutdown' }
        'restart'   { shutdown.exe /r /t $DelaySeconds /c 'WinVM Bridge scheduled restart' }
        'hibernate' { shutdown.exe /h }
        'sleep'     { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false) }
    }
    return [ordered]@{ ok = $true; scheduled = $true; plan = $plan }
}
