Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$lines = @()
$lines += ("NOW=" + (Get-Date).ToString('o'))

# 自身会话
$mySess = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$lines += ("MY_SESSION=" + $mySess)

# 映射 powershell 进程 -> 父进程 -> 会话，定位运行中的 ps-bridge
try {
    $psProcs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'"
    $nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
    $nodePids = @($nodeProcs | ForEach-Object { $_.ProcessId })
    foreach ($p in $psProcs) {
        $isChild = $nodePids -contains $p.ParentProcessId
        $lines += ("PS PID=" + $p.ProcessId + " Sess=" + $p.SessionId + " Parent=" + $p.ParentProcessId + " ChildOfNode=" + $isChild)
    }
} catch { $lines += ("CIM_ERR=" + $_.Exception.Message) }

# 复现 ps-bridge 的调用：dot-source gui.ps1（同 strict 上下文）后 Get-SessionHealth
try {
    . "C:\WinVMBridge\packages\vm-capabilities\psmod\gui.ps1"
    $r = Get-SessionHealth
    $lines += ("GUI_RAW=" + ($r | ConvertTo-Json -Compress -Depth 5))
    $lines += ("GUI_SESSION_ID=" + $r.sessionId)
    $lines += ("GUI_STATE=" + $r.state)
    $lines += ("GUI_WS=" + $r.windowStation)
    $lines += ("GUI_INTERACTIVE=" + $r.interactive)
} catch {
    $lines += ("GUI_EXCEPTION=" + $_.Exception.Message)
    $lines += ("GUI_STACK=" + $_.ScriptStackTrace)
}
$lines | Out-File -FilePath "C:\WinVMBridge\.diag-session.out" -Encoding utf8
