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

    $svc = Get-Service
    if ($Name)   { $svc = $svc | Where-Object { $_.Name -like "*$Name*" -or $_.DisplayName -like "*$Name*" } }
    if ($Status) { $svc = $svc | Where-Object { $_.Status -eq $Status } }

    return @($svc | ForEach-Object {
        $startType = ''
        try { $startType = (Get-CimInstance -ClassName Win32_Service -Filter "Name='$($_.Name)'").StartMode } catch { }
        [ordered]@{
            name        = $_.Name
            displayName = $_.DisplayName
            status      = $_.Status.ToString()
            startType   = $startType
        }
    })
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

    if ($SortBy -eq 'Cpu') { $list = $list | Sort-Object -Property workingSetMB -Descending }
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

function Read-RegistryValue {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Name = ''
    )

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

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -Path $Path -Force -ErrorAction Stop | Out-Null
    }
    Set-ItemProperty -LiteralPath $Path -Name $Name -Value $Value -Type $Type -Force -ErrorAction Stop
    $after = (Get-ItemProperty -LiteralPath $Path).$Name
    return [ordered]@{ path = $Path; name = $Name; value = $after; changedAt = (Get-Date).ToUniversalTime().ToString('o') }
}

# ------------------------------ system.network.config ------------------------------

function Get-NetworkConfig {
    param([switch]$IncludeRoutes)

    $adapters = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | ForEach-Object {
        [ordered]@{
            interfaceAlias = $_.InterfaceAlias
            interfaceIndex = $_.InterfaceIndex
            ipv4Address    = @($_.IPv4Address | ForEach-Object { $_.IPAddress })
            ipv6Address    = @($_.IPv6Address | ForEach-Object { $_.IPAddress })
            gateway        = $_.IPv4DefaultGateway
            dnsServers     = @($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses })
        }
    })

    $result = [ordered]@{ adapters = $adapters }
    if ($IncludeRoutes) {
        $result['routes'] = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Select-Object -First 30 |
            ForEach-Object { [ordered]@{ destination = $_.DestinationPrefix; nextHop = $_.NextHop; metric = $_.RouteMetric } })
    }
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
    if ($Level) { $filter['LevelDisplayName'] = $Level }

    $events = Get-WinEvent -FilterHashtable $filter -MaxEvents $MaxEvents -ErrorAction SilentlyContinue
    return @($events | ForEach-Object {
        [ordered]@{
            timeCreated = $_.TimeCreated.ToString('o')
            provider    = $_.ProviderName
            id          = $_.Id
            level       = $_.LevelDisplayName
            message     = ($_.Message -replace "`r?`n", ' ').Substring(0, [Math]::Min(500, $_.Message.Length))
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
