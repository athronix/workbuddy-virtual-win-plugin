<#
.SYNOPSIS
    WinVM Bridge —— ps-bridge 常驻 PowerShell 宿主进程

.DESCRIPTION
    通过 NDJSON over stdio 与 Node 侧通信（单行 JSON，UTF-8）。
    常驻进程避免了每次调用 ~500ms~1s 的 powershell.exe 冷启动开销（NFR-503）。

    帧协议：
      请求：{"id":"r1","module":"system","function":"Get-ServiceInfo","params":{...},"timeoutMs":30000}
      响应：{"id":"r1","ok":true,"data":{...},"warnings":[],"durationMs":123}
      失败：{"id":"r1","ok":false,"error":{"code":"...","message":"...","details":{...}},"durationMs":12}
      心跳：{"type":"heartbeat"}        （每 15s 一行）

    纪律：stdout **只能**出现协议 JSON；任何诊断信息一律写 stderr。

.NOTES
    运行环境要求：
      - Windows PowerShell 5.1+ 或 PowerShell 7+
      - **必须运行在交互式用户会话内**（WinSta0\Default，Session >= 1）
        才能使用 GUI 能力；以系统服务方式运行会导致截图黑屏与 SendInput 拒绝访问。
#>

[CmdletBinding()]
param(
    [int]$HeartbeatIntervalMs = 15000,
    [switch]$NoHeartbeat
)

# ⚠ StrictMode 选 Version 1 而非 Latest：保留「未初始化变量 / 调用缺参」校验（开发期防错），
# 但**不启用 Version 3 的「访问不存在的对象属性即报错」**——注册表卸载键等对象的可选属性
# （如 InstallDate / DisplayVersion）常不存在，Latest 会令整类能力抛「找不到属性」而失败。
# 若需更严属性校验，请在具体函数内局部 Set-StrictMode -Version Latest，而非全局开启。
Set-StrictMode -Version 1
$ErrorActionPreference = 'Stop'

# —— 编码与输出纪律 ——
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::InputEncoding  = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8

$script:ModulesRoot = Join-Path $PSScriptRoot ''
$script:LoadedModules = @{}

# ------------------------------ R-4 版本指纹（Phase 3 批2） ------------------------------
# 病灶：改 psmode/*.ps1 不重启即静默不生效（ps-bridge 不可热更，K-7 铁律），且 /health 的
# psBridge 只有 uptime，无法证明"VM 里跑的是哪一版模块"。
# 方案：**启动期**对各 .ps1 文件算 SHA256 存为快照（进程存活期间不变）——deploy 推新文件后
# 若未 kill-restart，进程报的还是启动期旧哈希，宿主侧比对源仓哈希即可显形"漂移未生效"。
# 真值口径：Get-FileHash SHA256 对小写 hex；与宿主 Node createHash('sha256') 逐字节一致
#（实测：VM 与源仓 psmode 文件经 tar 分发保持字节相同，无 CRLF 改写）。
$script:PsmodFiles = [ordered]@{}
foreach ($f in (Get-ChildItem -Path $PSScriptRoot -Filter '*.ps1' -File | Sort-Object -Property { $_.Name })) {
    try {
        $script:PsmodFiles[$f.Name] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
    } catch {
        # 单文件哈希失败不拖垮指纹：记空串，宿主比对会把它显形成 FAIL 项（宁可 loud）
        $script:PsmodFiles[$f.Name] = ''
    }
}
$script:FingerprintCapturedAt = [datetime]::UtcNow.ToString('o')

function Get-PsmodFingerprint {
    return [ordered]@{
        files      = $script:PsmodFiles
        capturedAt = $script:FingerprintCapturedAt
        pid        = $PID
    }
}

function Write-ProtocolLine {
    param([Parameter(Mandatory)][object]$Object)
    $json = $Object | ConvertTo-Json -Depth 30 -Compress
    # 单行输出，避免任何换行破坏 NDJSON 帧
    $json = ($json -replace "`r", ' ') -replace "`n", ' '
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Write-Diagnostic {
    param([string]$Message)
    [Console]::Error.WriteLine("[ps-bridge] $Message")
}

# 判定异常链中是否含 PowerShell **参数绑定异常**（缺必填 / 类型转换失败 / ValidateSet 违规 …）。
#
# 依据（真机实测）：这些失败的**顶级异常类型**均为 `System.Management.Automation.ParameterBindingException`
# 或其派生类 —— `ParameterBindingArgumentTransformationException`（类型转换）、
# `ParameterBindingValidationException`（ValidateSet/ValidatePattern 等）—— 故**只按类型判定**。
# 故意**不做**「消息含 parameter 字样」之类的模糊匹配：跨语言/本地化消息不可靠，易误判。
function Test-ParameterBindingException {
    param([Exception]$Exception)
    $e = $Exception
    $depth = 0
    while ($null -ne $e -and $depth -lt 8) {
        if ($e -is [System.Management.Automation.ParameterBindingException]) { return $true }
        $e = $e.InnerException
        $depth++
    }
    return $false
}

function Invoke-ErrorEnvelope {
    param(
        [string]$Id,
        [string]$Code,
        [string]$Message,
        [object]$Details = $null,
        [double]$DurationMs = 0
    )
    $env = [ordered]@{
        id         = $Id
        ok         = $false
        error      = [ordered]@{ code = $Code; message = $Message }
        durationMs = [math]::Round($DurationMs, 1)
    }
    if ($null -ne $Details) { $env.error['details'] = $Details }
    return $env
}

# ------------------------------ 模块加载 ------------------------------

function Import-CapabilityModule {
    param([Parameter(Mandatory)][string]$Name)

    if ($script:LoadedModules.ContainsKey($Name)) { return $true }

    $path = Join-Path $PSScriptRoot "$Name.ps1"
    if (-not (Test-Path -LiteralPath $path)) {
        throw "MODULE_NOT_FOUND: 找不到能力模块 $Name ($path)"
    }
    throw "MODULE_NOT_PRELOADED: 模块 $Name 未在启动时加载，请重启 ps-bridge"
}

# ------------------------------ 元能力 ------------------------------

function Invoke-MetaCapability {
    param([string]$Function, [hashtable]$Params)

    switch ($Function) {
        'ping' {
            return [ordered]@{
                ok        = $true
                module    = '__meta'
                function  = 'ping'
                pid       = $PID
                sessionId = (Get-CurrentSessionId)
                psVersion = $PSVersionTable.PSVersion.ToString()
                loaded    = @($script:LoadedModules.Keys)
                # R-4：ping 也带指纹摘要（宿主高频面零额外成本拿到版本事实）
                fingerprint = (Get-PsmodFingerprint)
            }
        }
        'fingerprint' {
            # R-4：显式指纹查询面（漂移比对工具用这条，语义单一）
            $fp = Get-PsmodFingerprint
            return [ordered]@{
                ok            = $true
                module        = '__meta'
                function      = 'fingerprint'
                bridgeScript  = $PSCommandPath
                modulesRoot   = $PSScriptRoot
                files         = $fp.files
                capturedAt    = $fp.capturedAt
                pid           = $fp.pid
                psVersion     = $PSVersionTable.PSVersion.ToString()
                # 启动期加载失败的模块点名（arch3 D-3："ping 不点名失败模块"缺口）
                failedLoads   = @((Get-ChildItem -Path $PSScriptRoot -Filter '*.ps1' -File |
                    Where-Object { $_.Name -ne 'ps-bridge.ps1' -and -not $script:LoadedModules.ContainsKey($_.BaseName) } |
                    ForEach-Object { $_.BaseName }))
            }
        }
        'listModules' {
            $mods = Get-ChildItem -Path $PSScriptRoot -Filter '*.ps1' -File |
                Where-Object { $_.Name -ne 'ps-bridge.ps1' } |
                ForEach-Object { $_.BaseName }
            return [ordered]@{ ok = $true; modules = @($mods) }
        }
        default {
            return [ordered]@{ ok = $false; error = [ordered]@{ code = 'UNKNOWN_META_FUNCTION'; message = "未知的元函数：$Function" } }
        }
    }
}

function Get-CurrentSessionId {
    try {
        return [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    }
    catch { return -1 }
}

# ------------------------------ 请求分发 ------------------------------

function Invoke-BridgeRequest {
    param([Parameter(Mandatory)]$Request)

    $id = [string]$Request.id
    $module = [string]$Request.module
    $fn = [string]$Request.function
    $params = $Request.params
    if ($null -eq $params) { $params = @{} }
    # ConvertTo-Json 反序列化出来的是 PSCustomObject，转成 hashtable 便于 splatting
    $ht = @{}
    foreach ($p in $params.PSObject.Properties) { $ht[$p.Name] = $p.Value }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        if ($module -eq '__meta') {
            $result = Invoke-MetaCapability -Function $fn -Params $ht
            $sw.Stop()
            $env = [ordered]@{ id = $id; ok = [bool]$result.ok; durationMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
            if ($result.Contains('error')) { $env['error'] = $result['error'] } else { $env['data'] = $result }
            return $env
        }

        Import-CapabilityModule -Name $module | Out-Null

        $cmd = Get-Command -Name $fn -CommandType Function -ErrorAction SilentlyContinue
        if (-not $cmd) {
            $sw.Stop()
            return Invoke-ErrorEnvelope -Id $id -Code 'UNKNOWN_FUNCTION' `
                -Message "模块 $module 中不存在函数 $fn" -DurationMs $sw.Elapsed.TotalMilliseconds
        }

        $warnings = New-Object System.Collections.ArrayList
        $result = & $cmd @ht 4>&1 | Where-Object {
            if ($_ -is [System.Management.Automation.WarningRecord]) {
                [void]$warnings.Add($_.Message); $false
            }
            else { $true }
        }

        $sw.Stop()
        return [ordered]@{
            id         = $id
            ok         = $true
            data       = $result
            warnings   = @($warnings.ToArray())
            durationMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
        }
    }
    catch {
        $sw.Stop()
        $ex = $_.Exception
        $code = 'EXECUTION_FAILED'
        # ① 领域码优先：psmod 内 `throw "UPPER_SNAKE: msg"`（如 FILE_NOT_FOUND / CLI_NOT_FOUND）
        if ($ex.Message -match '^([A-Z_]+):') {
            $code = $Matches[1]
        }
        # ② 纵深防御（CL-017 D25-②）：PowerShell **参数绑定失败** → 归一为领域码 INVALID_ARGUMENT。
        #    只按**异常类型**判定（见 Test-ParameterBindingException）；**不新增领域码** ——
        #    Node 侧 `DOMAIN_CODE_TO_BASE['INVALID_ARGUMENT'] = 'INVALID_PARAMS'` 已存在，对外即为
        #    `INVALID_PARAMS` + `reason='INVALID_ARGUMENT'`，与 D24/D26 完全同形（调用方无须学第二套语义）。
        #    与 D24/D26 的分工：adapter 侧已**前置**拦截「未知参数名 / 缺必填」（D24，仅对声明了 required 的
        #    能力生效）与「值非法：类型不符 / 枚举越界」（D26，按注册表 schema 的 type/enum 判定）。本分支是
        #    **纵深防御**，覆盖 D24/D26 够不到的形态 —— schema 未声明、只有 PS 侧绑定才拦得下的值层面的失败
        #    （类型不符 / 枚举越界），与能力是否声明 `required` 无关。
        elseif (Test-ParameterBindingException -Exception $ex) {
            $code = 'INVALID_ARGUMENT'
        }
        # 统一为 `CODE: message` 形态（领域码约定），便于日志与人工排查；
        # ① 分支的 message 本就带前缀，此处只补 ② 分支。
        $msg = $ex.Message
        if ($code -eq 'INVALID_ARGUMENT' -and $msg -notmatch '^INVALID_ARGUMENT:') {
            $msg = 'INVALID_ARGUMENT: ' + $msg
        }
        return Invoke-ErrorEnvelope -Id $id -Code $code -Message $msg `
            -Details @{ exceptionType = $ex.GetType().FullName } -DurationMs $sw.Elapsed.TotalMilliseconds
    }
}

# ------------------------------ 启动时预加载能力模块 ------------------------------
#
# ⚠ 关键：必须在**脚本作用域**（而非任何函数内部）dot-source。
# PowerShell 函数作用域规则：在函数内 dot-source 进来的函数属于该函数的局部作用域，
# 函数返回后即消失 —— 这会导致"模块已加载但找不到函数"的诡异故障。

foreach ($mod in (Get-ChildItem -Path $PSScriptRoot -Filter '*.ps1' -File |
                  Where-Object { $_.Name -ne 'ps-bridge.ps1' })) {
    try {
        . $mod.FullName
        $script:LoadedModules[$mod.BaseName] = $true
        Write-Diagnostic "已加载能力模块：$($mod.BaseName)"
    }
    catch {
        # 单个模块失败不应拖垮整个 bridge，记为未加载，调用时明确报错
        Write-Diagnostic "模块加载失败 $($mod.BaseName)：$($_.Exception.Message)"
    }
}

# ------------------------------ 主循环 ------------------------------

Write-Diagnostic "ps-bridge 启动（PID=$PID, SessionId=$(Get-CurrentSessionId), PS=$($PSVersionTable.PSVersion), 已加载模块数=$($script:LoadedModules.Count)）"

$lastHeartbeat = [datetime]::UtcNow
$pending = $null

try {
    while ($true) {
        # 异步读，便于在阻塞期间仍然发出心跳
        if ($null -eq $pending) { $pending = [Console]::In.ReadLineAsync() }

        if ($pending.Wait(1000)) {
            $line = $pending.GetAwaiter().GetResult()
            $pending = $null

            if ($null -eq $line) { break }          # stdin 关闭 → 退出
            $line = $line.Trim()
            if ([string]::IsNullOrWhiteSpace($line)) { continue }

            try {
                $req = $line | ConvertFrom-Json
            }
            catch {
                Write-ProtocolLine (Invoke-ErrorEnvelope -Id '' -Code 'INVALID_JSON' -Message '无法解析请求 JSON')
                continue
            }

            $resp = Invoke-BridgeRequest -Request $req
            Write-ProtocolLine $resp
        }

        if (-not $NoHeartbeat) {
            $elapsed = ([datetime]::UtcNow - $lastHeartbeat).TotalMilliseconds
            if ($elapsed -ge $HeartbeatIntervalMs) {
                Write-ProtocolLine @{ type = 'heartbeat'; ts = [datetime]::UtcNow.ToString('o') }
                $lastHeartbeat = [datetime]::UtcNow
            }
        }
    }
}
catch {
    Write-Diagnostic "主循环异常：$($_.Exception.Message)"
}
finally {
    Write-Diagnostic 'ps-bridge 退出'
}
