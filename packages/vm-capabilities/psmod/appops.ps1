<#
.SYNOPSIS
    WinVM Bridge —— appops 能力域（应用生产操作，FR-205）

.DESCRIPTION
    本域回答"在 VM 里用某个桌面软件把活干出来"，与 app 域（应用**管理**/安装卸载）区分。
    提供四类生产原语：
      1) appops.state.query      —— 查应用生产上下文（运行中的应用/打开的文档/活动窗口）
      2) appops.cli.invoke     —— 调应用自带 CLI/脚本接口（ffmpeg / magick / soffice / pandoc ...）
      3) appops.workflow.run   —— 运行 VM 内已登记的"生产型工作流"（封装具体应用的 CLI/API/宏）
      4) appops.com.automate   —— 通过 COM 自动化驱动支持 COM 的桌面应用（Office 等）
      5) appops.gui.produce —— 基于 GUI 自动化的多步生产（打开→导入→操作→导出），步骤序列由 Skill 提供

    工作流目录默认：%USERPROFILE%\WinVMWorkspace\workflows 与 C:\WinVMWorkspace\workflows
    产物目录默认：      %USERPROFILE%\WinVMWorkspace\out        与 C:\WinVMWorkspace\out
    （路径受 capability 策略 pathAllowlist 约束）
#>

# ------------------------------ appops.state.query ------------------------------
#
# CL-018 C4：原先「所有有窗口的进程」都算"应用生产上下文"，结果被安装器临时窗口
# （`*tmp Setup*`）、通知助手（`NotifyHelper`）、空标题框架宿主（`ApplicationFrameHost`
# 承载 UWP 时短暂出现的空白框架窗）污染。
#
# 关键取舍（**AC4.2 无真实应用被误杀 优先于 AC4.1 过滤**）：
#   * **绝不**按进程名整体排除 `ApplicationFrameHost` —— 真机实测它承载真实 UWP 应用
#     （如「设置」，MainWindowTitle='设置'），整体排除会误杀真实应用；
#   * 判定依据是"窗口是否具备生产型内容"：有真实标题的框架窗**保留**，**空标题**框架窗排除；
#   * `ShellExperienceHost` / `RuntimeBroker` / `TextInputHost` / `SearchHost` 属灰名单，
#     逐个按"有无真实标题"判定，不整体排除；
#   * 名单**数据驱动**：内置默认 + env 追加（`WINVM_APPOPS_EXCLUDE_PROCS` /
#     `WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS` / `WINVM_APPOPS_EXCLUDE_PROC_PATTERNS`），
#     部署侧可按现场补充而无需改代码。
#   * **进程名级**排除（`procDeny`，CL-018 R2 补齐）：覆盖「进程名含 installer 但标题不含」的
#     安装器（真机样本 `Doubao_installer`/标题「豆包」）；模式**锚定**（`_installer$` / `^setup`），
#     避免误杀名字恰好含 installer 的正常程序（AC4.2 优先）。

function Get-AppOpsWindowPolicy {
    # 明确非生产型进程名（**永不承载生产型应用内容**的系统壳/助手/安装器）——逐个显式登记
    # （「逐个判定」而非一刀切；`ApplicationFrameHost` 故意**不在**此处，见下 frameHosts 灰名单）。
    $hardExclude = @(
        'NotifyHelper', 'InstallHelper', 'updater', 'dwm', 'sihost', 'ctfmon', 'LockApp',
        'ShellHost', 'Widgets', 'WidgetService', 'MoNotificationUx', 'backgroundTaskHost',
        'DataExchangeHost', 'UserOOBroker'
    )
    if ($env:WINVM_APPOPS_EXCLUDE_PROCS) {
        $hardExclude += @($env:WINVM_APPOPS_EXCLUDE_PROCS -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }

    # 标题级排除：空标题（frame-only 窗 / explorer 壳窗）、安装器/临时安装标题、隐藏消息窗、卸载程序
    $titleDeny = @(
        '^\s*$',
        '(?i)tmp\s*setup',
        '(?i)\bsetup\b',
        '(?i)installer',
        '(?i)安装程序',
        '(?i)卸载',
        '^ShellMsgGetMessageWindow$'
    )
    if ($env:WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS) {
        $titleDeny += @($env:WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }

    # 进程名级排除（CL-018 R2 补齐）：**仅锚定**的后缀/前缀模式，用于覆盖「进程名含 installer、
    # 但标题不含 installer」的安装器（真机样本 `5000517—Doubao_installer`，标题「豆包」）。
    #
    # 取舍（**AC4.2 不误杀 优先于 AC4.1 过滤**）：模式必须**窄**（后缀 `_installer$` / 前缀 `^setup`），
    # **绝不**写宽松的 `(?i)installer` —— 那会误杀一切名字带 installer 字样的正常程序。
    $procDeny = @(
        '(?i)_installer$',
        '(?i)^setup'
    )
    if ($env:WINVM_APPOPS_EXCLUDE_PROC_PATTERNS) {
        $procDeny += @($env:WINVM_APPOPS_EXCLUDE_PROC_PATTERNS -split '[,;]' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }

    # 框架宿主（灰名单）：需"有真实标题"才算生产型，**不按进程名整体排除**
    # —— `ApplicationFrameHost` 承载真实 UWP 应用（实测标题「设置」），整体排除会误杀（违 AC4.2）。
    $frameHosts = @(
        'ApplicationFrameHost', 'ShellExperienceHost', 'RuntimeBroker', 'TextInputHost',
        'SearchHost', 'StartMenuExperienceHost', 'SearchApp', 'SearchUI', 'appstore'
    )

    return [ordered]@{
        hardExclude = @($hardExclude)
        titleDeny   = @($titleDeny)
        procDeny    = @($procDeny)
        frameHosts  = @($frameHosts)
    }
}

# 判定单个窗口是否"生产型" → [ordered]@{ productive = bool; reason = string }
function Test-AppOpsWindowProductive {
    param(
        [string]$ProcessName,
        [string]$WindowTitle,
        [object]$Policy
    )

    if ($Policy.hardExclude -contains $ProcessName) {
        return [ordered]@{ productive = $false; reason = 'NON_PRODUCTIVE_PROC' }
    }
    # 进程名级模式（CL-018 R2）：锚定模式，仅淘汰安装器类进程名（如 `Doubao_installer`）
    foreach ($pat in $Policy.procDeny) {
        if ($ProcessName -match $pat) {
            return [ordered]@{ productive = $false; reason = 'DENY_PROC_PATTERN' }
        }
    }
    foreach ($pat in $Policy.titleDeny) {
        if ($WindowTitle -match $pat) {
            return [ordered]@{ productive = $false; reason = 'DENY_TITLE_PATTERN' }
        }
    }
    # 灰名单框架宿主：仅当**没有真实标题**时排除（保留承载真实应用的框架窗，如「设置」）
    if (($Policy.frameHosts -contains $ProcessName) -and [string]::IsNullOrWhiteSpace($WindowTitle)) {
        return [ordered]@{ productive = $false; reason = 'EMPTY_TITLE_FRAME_HOST' }
    }
    return [ordered]@{ productive = $true; reason = 'OK' }
}

function Get-AppOpState {
    param(
        [string]$AppName = '',
        [switch]$IncludeDocuments
    )

    $policy = Get-AppOpsWindowPolicy
    $withWindow = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })

    $list = New-Object System.Collections.ArrayList
    $filtered = New-Object System.Collections.ArrayList
    foreach ($p in $withWindow) {
        $title = ''
        try { $title = [string]$p.MainWindowTitle } catch { $title = '' }
        $verdict = Test-AppOpsWindowProductive -ProcessName $p.ProcessName -WindowTitle $title -Policy $policy
        if (-not $verdict.productive) {
            # 被过滤项**保留在 filtered 清单**（含原因），供审计核对"未误杀真实应用"
            [void]$filtered.Add([ordered]@{
                processId   = $p.Id
                processName = $p.ProcessName
                windowTitle = $title
                reason      = $verdict.reason
            })
            continue
        }
        [void]$list.Add([ordered]@{
            processId   = $p.Id
            processName = $p.ProcessName
            windowTitle = $title
            responsive  = (-not $p.HasExited)
        })
    }

    # 应用名过滤：在"生产型"集合内检索（避免空框架窗被当作命中）
    $apps = @($list.ToArray())
    if ($AppName) {
        $apps = @($apps | Where-Object { $_.processName -like "*$AppName*" -or $_.windowTitle -like "*$AppName*" })
    }

    $result = [ordered]@{
        count         = $apps.Count
        apps          = $apps
        scannedAt     = (Get-Date).ToUniversalTime().ToString('o')
        # CL-018 C4（纯附加）：被过滤的非生产型窗口清单/原因（透明可审计）
        filteredCount = $filtered.Count
        filtered      = @($filtered.ToArray())
        policy        = [ordered]@{
            hardExclude = @($policy.hardExclude)
            titleDeny   = @($policy.titleDeny)
            procDeny    = @($policy.procDeny)
            frameHosts  = @($policy.frameHosts)
        }
    }

    if ($IncludeDocuments) {
        # 启发式：收集前台可见窗口标题，作为"打开的文档/项目"线索
        $docs = @($apps | Where-Object { $_.windowTitle } | ForEach-Object { $_.windowTitle })
        $result['openDocuments'] = $docs
    }

    return $result
}

# ------------------------------ appops.cli.invoke ------------------------------
#
# D3 修复背景（真机确诊）：
#   旧实现 `& $exe @(if ($App -ne 'custom') { $Arguments -split '\s+' } else { @() })`
#   —— `command` 参数（除 custom 外）**完全未使用**，`arguments` 缺省为 '' → 零参启动
#   node.exe/python.exe → 进入 REPL 并阻塞读取 **ps-bridge 的 stdin 管道** → 全桥死锁（51s 无响应）。
#   新实现要点：
#     ① 参数来源以 Command 为准（skill 示例 `{app:'ffmpeg',command:'ffmpeg -i ...'}` 即此形态），
#        若 Command 以可执行名/App 名开头则剥掉前缀，再追加显式 Arguments；
#     ② 子进程强制 RedirectStandardInput 并**立即 Close()**（绝不继承 ps-bridge 管道）；
#     ③ 硬超时（默认 120s）到点 kill 进程树并返回 TIMEOUT，单次调用无法拖死桥；
#     ④ node/python 空参明确报 INVALID_ARGUMENT，禁止静默零参启动。

# 把命令行文本切分为参数数组（支持双引号包裹的含空格参数）
function ConvertTo-AppCliArgumentList {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
    return @([regex]::Matches($Text, '"([^"]*)"|(\S+)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
}

# 为 ProcessStartInfo.Arguments 拼接单参数：含空白/引号才加引号并转义内部引号
function ConvertTo-AppCliQuotedArg {
    param([string]$Arg)
    if ($null -eq $Arg) { return '""' }
    if ($Arg.Length -eq 0) { return '""' }
    if ($Arg -notmatch '[\s"]') { return $Arg }
    return '"' + ($Arg -replace '"', '\"') + '"'
}

function Invoke-AppCli {
    param(
        [Parameter(Mandatory)][string]$App,
        [Parameter(Mandatory)][string]$Command,
        [string]$Arguments = '',
        [string]$WorkingDirectory = '',
        [string]$OutputDirectory = '',
        [int]$TimeoutMs = 120000
    )

    $map = @{
        'ffmpeg'  = 'ffmpeg.exe'
        'magick'  = 'magick.exe'
        'soffice' = 'soffice.exe'
        'pandoc'  = 'pandoc.exe'
        'node'    = 'node.exe'
        'python'  = 'python.exe'
    }

    if ($App -ne 'custom' -and -not $map.ContainsKey($App)) {
        throw "UNSUPPORTED_APP: 不支持的应用 CLI：$App（支持 ffmpeg/magick/soffice/pandoc/node/python/custom）"
    }

    # —— 解析可执行文件与参数 ——
    $exe = ''
    $argList = @()

    if ($App -eq 'custom') {
        # custom：Command 为完整命令行，首词为可执行文件
        $tokens = ConvertTo-AppCliArgumentList $Command
        if ($tokens.Count -eq 0) { throw 'INVALID_ARGUMENT: custom 模式下 command 不能为空（应为 "<exe> [args...]"）' }
        $exe = $tokens[0]
        if ($tokens.Count -gt 1) { $argList = @($tokens[1..($tokens.Count - 1)]) }
        if ($Arguments) { $argList += (ConvertTo-AppCliArgumentList $Arguments) }
    }
    else {
        $exe = $map[$App]
        $argString = $Command.Trim()

        # 剥掉可执行名前缀（`ffmpeg ...` / `ffmpeg.exe ...` / 带目录的路径），避免把它当参数传给自身
        $prefixes = @($exe, $App, [System.IO.Path]::GetFileNameWithoutExtension($exe))
        foreach ($pre in ($prefixes | Where-Object { $_ })) {
            $re = '^(?:"[^"]*[\\/])?' + [Regex]::Escape($pre) + '(?:\.exe)?(?=\s|$)'
            if ($argString -match $re) {
                $argString = ($argString -replace $re, '').Trim()
                break
            }
        }
        if ($Arguments) { $argString = ("$argString $Arguments").Trim() }
        $argList = ConvertTo-AppCliArgumentList $argString

        # 兜底：node/python 空参启动会进入 REPL 阻塞 stdin → 明确拒绝（而非静默零参启动）
        if ($argList.Count -eq 0 -and ($App -eq 'node' -or $App -eq 'python')) {
            throw "INVALID_ARGUMENT: $App 需要显式参数（如 command='$App -v'）；空参启动会进入 REPL 并阻塞 ps-bridge"
        }
    }

    # 解析可执行文件的绝对路径
    $exeFull = $exe
    if (-not [System.IO.Path]::IsPathRooted($exe)) {
        $cmdInfo = Get-Command $exe -ErrorAction SilentlyContinue
        if (-not $cmdInfo) {
            throw "CLI_NOT_FOUND: 未找到 $exe，请确认该应用已安装且其目录在 PATH 中"
        }
        $exeFull = $cmdInfo.Source
    }
    elseif (-not (Test-Path -LiteralPath $exeFull)) {
        throw "CLI_NOT_FOUND: 可执行文件不存在 —— $exeFull"
    }

    if ($OutputDirectory) {
        if (-not (Test-Path -LiteralPath $OutputDirectory)) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exeFull
    $psi.Arguments = (($argList | ForEach-Object { ConvertTo-AppCliQuotedArg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    if ($WorkingDirectory -and (Test-Path -LiteralPath $WorkingDirectory)) { $psi.WorkingDirectory = $WorkingDirectory }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try { [void]$proc.Start() }
    catch {
        $sw.Stop()
        throw "CLI_NOT_FOUND: 无法启动 $exeFull（$($_.Exception.Message)）"
    }
    $procId = $proc.Id

    # 关键：立即关闭子进程 stdin，杜绝其读取并继承 ps-bridge 的输入管道（D3 死锁根因）
    try { $proc.StandardInput.Close() } catch { }

    # 异步读取 stdout/stderr，避免管道缓冲写满导致 WaitForExit 死锁
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    $timedOut = -not $proc.WaitForExit($TimeoutMs)
    if ($timedOut) {
        # 硬超时：kill 进程树（PS 5.1 无 Kill($true)，用 taskkill /T 兜底）
        try { $proc.Kill() } catch { }
        try { & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null } catch { }
        try { [void]$proc.WaitForExit(5000) } catch { }
    }

    $outText = ''
    $errText = ''
    try { $outText = $stdoutTask.Result } catch { }
    try { $errText = $stderrTask.Result } catch { }
    $sw.Stop()
    $exit = if ($timedOut) { -1 } else { $proc.ExitCode }
    try { $proc.Dispose() } catch { }

    if ($timedOut) {
        throw "TIMEOUT: $App 调用超过 ${TimeoutMs}ms 未结束，已终止进程树（command=$Command）"
    }

    $output = @()
    if ($outText) { $output += @($outText -split "`r?`n") }
    if ($errText) { $output += @($errText -split "`r?`n") }
    $output = @($output | Where-Object { $_ -ne '' })

    return [ordered]@{
        app             = $App
        command         = $Command
        arguments       = ($argList -join ' ')
        exitCode        = $exit
        success         = ($exit -eq 0)
        timedOut        = $false
        durationMs      = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
        output          = $output
        outputDirectory = if ($OutputDirectory) { $OutputDirectory } else { $null }
    }
}

# ------------------------------ appops.workflow.run ------------------------------

function Start-AppOpWorkflow {
    param(
        [Parameter(Mandatory)][string]$Workflow,
        [object]$Params = $null,
        [string]$InputPath = '',
        [string]$OutputDirectory = ''
    )

    $roots = @(
        (Join-Path $env:USERPROFILE 'WinVMWorkspace\workflows'),
        'C:\WinVMWorkspace\workflows'
    )

    $scriptPath = $null
    foreach ($r in $roots) {
        # 允许 .ps1 / .js / .py 三种形态
        foreach ($ext in @('.ps1', '.js', '.py')) {
            $cand = Join-Path $r "$Workflow$ext"
            if (Test-Path -LiteralPath $cand) { $scriptPath = $cand; break }
        }
        if ($scriptPath) { break }
    }

    if (-not $scriptPath) {
        return [ordered]@{
            ok        = $false
            workflow  = $Workflow
            error     = [ordered]@{ code = 'WORKFLOW_NOT_FOUND'; message = "未找到工作流「$Workflow」。请先在 VM 的 workflows 目录预置，或升级 provider 为 LLM Agent 以动态生成。" }
            searched  = $roots
        }
    }

    if ($OutputDirectory -and -not (Test-Path -LiteralPath $OutputDirectory)) {
        New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    }

    # 把参数以 JSON 形式注入环境变量，工作流脚本自行读取 WINVM_WORKFLOW_PARAMS
    $paramJson = if ($null -eq $Params) { '{}' } else { ($Params | ConvertTo-Json -Depth 20 -Compress) }
    $env:WINVM_WORKFLOW_PARAMS = $paramJson
    if ($InputPath)     { $env:WINVM_WORKFLOW_INPUT = $InputPath }
    if ($OutputDirectory) { $env:WINVM_WORKFLOW_OUT = $OutputDirectory }

    $ext = [System.IO.Path]::GetExtension($scriptPath).ToLowerInvariant()
    $interp = switch ($ext) {
        '.ps1' { @('powershell.exe', @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath)) }
        '.js'  { @('node.exe', @($scriptPath)) }
        '.py'  { @('python.exe', @($scriptPath)) }
        default { throw "UNSUPPORTED_WORKFLOW_TYPE: 不支持的工作流类型：$ext" }
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $raw = & $interp[0] $interp[1] 2>&1
    $exit = $LASTEXITCODE
    $sw.Stop()

    # 收集产物目录下的新文件作为 artifact 线索
    $artifacts = @()
    if ($OutputDirectory -and (Test-Path -LiteralPath $OutputDirectory)) {
        $artifacts = @(Get-ChildItem -Path $OutputDirectory -File | ForEach-Object { $_.FullName })
    }

    return [ordered]@{
        ok              = ($exit -eq 0)
        workflow        = $Workflow
        scriptPath      = $scriptPath
        exitCode        = $exit
        durationMs      = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
        output          = @($raw | ForEach-Object { "$_" })
        outputDirectory = if ($OutputDirectory) { $OutputDirectory } else { $null }
        artifacts       = $artifacts
    }
}

# ------------------------------ appops.com.automate ------------------------------

function Invoke-AppComAutomation {
    param(
        [Parameter(Mandatory)][string]$ProgId,
        [Parameter(Mandatory)][string]$Script,
        [string]$DocumentPath = '',
        [string]$OutputPath = ''
    )

    try {
        $app = New-Object -ComObject $ProgId -ErrorAction Stop
    }
    catch {
        throw "COM_NOT_FOUND: 无法创建 COM 对象 $ProgId（$( $_.Exception.Message )）"
    }

    try {
        # 把常用上下文注入脚本作用域
        $sb = [scriptblock]::Create($Script)
        $result = & $sb
        return [ordered]@{
            ok         = $true
            progId     = $ProgId
            outputPath = if ($OutputPath) { $OutputPath } else { $null }
            result     = if ($null -ne $result) { "$result" } else { $null }
        }
    }
    catch {
        throw "COM_AUTOMATION_FAILED: $($_.Exception.Message)"
    }
    finally {
        try { if ($app -and ($app.PSObject.Methods['Quit'])) { $app.Quit() | Out-Null } } catch { }
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null } catch { }
        [System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
    }
}

# ------------------------------ appops.gui.produce ------------------------------
#
# 基于 GUI 自动化的"生产型"多步操作。步骤序列由 Skill 提供（应用专属点击序列），
# 本函数负责按 kind 分发到已加载的 gui.* 原语（同进程脚本作用域可见）。

function Invoke-AppGuiProduction {
    param(
        [Parameter(Mandatory)][string]$App,
        [string]$OpenTarget = '',
        [Parameter(Mandatory)][array]$Steps,
        [string]$OutputPath = ''
    )

    if ($OpenTarget) {
        Start-Process -FilePath $OpenTarget -ErrorAction Stop | Out-Null
    }

    $trace = New-Object System.Collections.ArrayList
    foreach ($step in $Steps) {
        $kind = [string]$step.kind
        $target = if ($null -ne $step.target) { [string]$step.target } else { '' }
        $value = if ($null -ne $step.value) { [string]$step.value } else { '' }
        $timeout = if ($null -ne $step.timeoutMs) { [int]$step.timeoutMs } else { 15000 }

        $entry = [ordered]@{ kind = $kind; target = $target; status = 'pending' }
        try {
            switch ($kind) {
                'click' {
                    # 优先按 UIA Name，其次 AutomationId
                    $invoked = $false
                    if ($target) {
                        try { Invoke-UiaElement -WindowTitle $App -Name $target -Action invoke -ErrorAction Stop; $invoked = $true } catch { }
                        if (-not $invoked) { Invoke-UiaElement -WindowTitle $App -AutomationId $target -Action invoke -ErrorAction Stop }
                    }
                }
                'type' { Send-KeyboardInput -Text $value }
                'menu' { Invoke-UiaElement -WindowTitle $App -Name $target -Action invoke -ErrorAction Stop }
                'hotkey' {
                    $keys = $value -split '\+' | ForEach-Object { $_.Trim().ToLowerInvariant() }
                    Send-KeyboardInput -Keys $keys
                }
                'waitWindow' { Wait-GuiCondition -Condition windowExists -WindowTitle $target -TimeoutMs $timeout }
                'waitStable' { Wait-GuiCondition -Condition screenStable -TimeoutMs $timeout }
                'screenshot' {
                    $cap = Get-ScreenCapture -AsBase64
                    $entry['screenshotBytes'] = $cap.bytes
                    if ($OutputPath) {
                        $b64 = $cap.data
                        $bytes = [Convert]::FromBase64String($b64)
                        $p = if ($target) { Join-Path $OutputPath "$target.png" } else { Join-Path $OutputPath "step_$(Get-Date -Format 'yyyyMMddHHmmss').png" }
                        [System.IO.File]::WriteAllBytes($p, $bytes)
                        $entry['savedTo'] = $p
                    }
                }
                default { throw "UNKNOWN_STEP_KIND: 未知步骤类型：$kind" }
            }
            $entry['status'] = 'ok'
        }
        catch {
            $entry['status'] = 'failed'
            $entry['error'] = $_.Exception.Message
            [void]$trace.Add($entry)
            return [ordered]@{
                ok      = $false
                app     = $App
                failedAt = $trace.Count
                trace   = @($trace.ToArray())
                error   = [ordered]@{ code = 'GUI_PRODUCTION_FAILED'; message = $_.Exception.Message }
            }
        }
        [void]$trace.Add($entry)
    }

    return [ordered]@{
        ok      = $true
        app     = $App
        steps   = $trace.Count
        trace   = @($trace.ToArray())
        outputPath = if ($OutputPath) { $OutputPath } else { $null }
    }
}
