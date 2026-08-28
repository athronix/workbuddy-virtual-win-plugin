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

function Get-AppOpState {
    param(
        [string]$AppName = '',
        [switch]$IncludeDocuments
    )

    $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
    if ($AppName) { $procs = $procs | Where-Object { $_.ProcessName -like "*$AppName*" -or $_.MainWindowTitle -like "*$AppName*" } }

    $list = @($procs | ForEach-Object {
        [ordered]@{
            processId      = $_.Id
            processName    = $_.ProcessName
            windowTitle    = $_.MainWindowTitle
            responsive     = (-not $_.HasExited)
        }
    })

    $result = [ordered]@{
        count   = $list.Count
        apps    = $list
        scannedAt = (Get-Date).ToUniversalTime().ToString('o')
    }

    if ($IncludeDocuments) {
        # 启发式：收集前台可见窗口标题，作为"打开的文档/项目"线索
        $docs = @($list | Where-Object { $_.windowTitle } | ForEach-Object { $_.windowTitle })
        $result['openDocuments'] = $docs
    }

    return $result
}

# ------------------------------ appops.cli.invoke ------------------------------

function Invoke-AppCli {
    param(
        [Parameter(Mandatory)][string]$App,
        [Parameter(Mandatory)][string]$Command,
        [string]$Arguments = '',
        [string]$WorkingDirectory = '',
        [string]$OutputDirectory = ''
    )

    $map = @{
        'ffmpeg'  = 'ffmpeg.exe'
        'magick'  = 'magick.exe'
        'soffice' = 'soffice.exe'
        'pandoc'  = 'pandoc.exe'
        'node'    = 'node.exe'
        'python'  = 'python.exe'
        'custom'  = $Command
    }

    if (-not $map.ContainsKey($App)) { throw "UNSUPPORTED_APP: 不支持的应用 CLI：$App（支持 ffmpeg/magick/soffice/pandoc/node/python/custom）" }

    $exe = $map[$App]
    if ($App -ne 'custom' -and -not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        throw "CLI_NOT_FOUND: 未找到 $exe，请确认该应用已安装且其目录在 PATH 中"
    }

    if ($OutputDirectory) {
        if (-not (Test-Path -LiteralPath $OutputDirectory)) { New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null }
    }

    $psi = [ordered]@{ FilePath = $exe }
    if ($App -ne 'custom' -and $Arguments) { $psi['ArgumentList'] = $Arguments }
    if ($WorkingDirectory) { $psi['WorkingDirectory'] = $WorkingDirectory }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $out = & $exe @(if ($App -ne 'custom') { $Arguments -split '\s+' | Where-Object { $_ } } else { @() }) 2>&1
    $exit = $LASTEXITCODE
    $sw.Stop()

    return [ordered]@{
        app        = $App
        command    = $Command
        arguments  = $Arguments
        exitCode   = $exit
        success    = ($exit -eq 0)
        durationMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
        output     = @($out | ForEach-Object { "$_" })
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
