<#
.SYNOPSIS
    WinVM Bridge —— gui 能力域（图形化与桌面自动化，FR-204）

.NOTES
    ⚠ 铁律：本模块的函数**必须运行在交互式用户会话**（WinSta0\Default，Session >= 1）。
    以 Windows 服务方式运行（Session 0）会导致：
      - 截图全黑（因为 Session 0 没有可视桌面）
      - SendInput 返回 Access denied（UIPI / 桌面隔离）
    因此 ps-bridge 必须在用户登录会话内启动，绝不能注册为服务。
#>

# ------------------------------ 会话健康（gui.session.status） ------------------------------

function Get-SessionHealth {
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId

    $explorer = Get-Process -Name explorer -ErrorAction SilentlyContinue
    $explorerAlive = ($null -ne $explorer)

    # 锁屏检测：LogonUI 存在且占据前台通常表示锁屏
    $locked = ($null -ne (Get-Process -Name LogonUI -ErrorAction SilentlyContinue))

    # 窗口站 / 桌面判定
    # 修复：原 GetUserObjectInformationW(UOI_NAME) 经 StringBuilder 在本机实测读出 "W"（应为 "WinSta0"），
    # 使 $ws -eq 'WinSta0' 恒成立 false → 误判非交互、GUI 能力被门禁（即便进程确在交互会话）。
    # 改以 OpenWindowStationW 实测当前进程能否以 READ 权限打开交互式窗口站 WinSta0
    # （仅交互会话内进程可成功，session 0 服务返回 NULL），该判定不依赖字符串读取，规避编码/封送假值。
    $ws = 'unknown'; $desktop = 'unknown'; $canReachInteractive = $false
    try {
        # 防御：常驻 ps-bridge 进程会多次调用本函数，Add-Type 重复定义同名类型会抛错；
        # 先判存在再定义（与 Initialize-InputApi 同一惯用法），规避 Suppressed 错误与竞态。
        if (-not ('WinVM.SessionNative' -as [type])) {
            Add-Type -Namespace WinVM -Name SessionNative -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)] public static extern System.IntPtr OpenWindowStationW([System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string lpszWinSta, bool fInherit, uint dwDesiredAccess);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool CloseWindowStation(System.IntPtr h);
'@ -ErrorAction SilentlyContinue
        }

        $hws = [WinVM.SessionNative]::OpenWindowStationW('WinSta0', $false, 0x0002)  # WINSTA_READATTRIBUTES
        if ($hws -ne [System.IntPtr]::Zero) {
            # ⚠ 必须用 [void] 吸收返回值：CloseWindowStation 返回 bool，作为裸语句会泄漏到成功输出流，
            # 与末尾 `return [ordered]@{}` 合并成 [$true, 哈希表] 数组，导致 ps-bridge 序列化后
            # index.ts 取 raw['windowStation'] 为 undefined → state 恒为 unavailable（真根因，2026-09-17 确诊）。
            [void][WinVM.SessionNative]::CloseWindowStation($hws)
            $canReachInteractive = $true
            $ws = 'WinSta0'
            $desktop = 'Default'
        }
    }
    catch { }

    $interactive = ($sessionId -ge 1) -and $canReachInteractive -and $explorerAlive

    # 黑屏检测
    $blackScreen = $false
    if ($interactive) {
        try {
            $probe = Test-ScreenBlack -Threshold 2.0
            $blackScreen = [bool]$probe.isBlack
        }
        catch { $blackScreen = $false }
    }

    $state = 'healthy'
    if ($blackScreen) { $state = 'black-screen' }
    elseif (-not $interactive) { $state = if ($sessionId -eq 0) { 'unavailable' } else { 'degraded' } }
    elseif ($locked) { $state = 'degraded' }

    return [ordered]@{
        sessionId     = $sessionId
        windowStation = $ws
        desktop       = $desktop
        interactive   = $interactive
        locked        = $locked
        blackScreen   = $blackScreen
        explorerAlive = $explorerAlive
        state         = $state
        detail        = switch ($state) {
            'healthy'      { '会话健康，GUI 能力可用' }
            'degraded'     { '会话降级（锁屏或 Explorer 未运行），GUI 能力不可用' }
            'black-screen' { '检出黑屏：进程很可能运行在 Session 0 或会话已挂起' }
            'unavailable'  { '无交互式会话（Session 0），GUI 能力不可用' }
        }
    }
}

# ------------------------------ 截图（gui.screen.capture） ------------------------------

function Get-ScreenCapture {
    param(
        [int]$X = 0, [int]$Y = 0, [int]$Width = 0, [int]$Height = 0,
        [string]$WindowTitle = '',
        [switch]$AsBase64
    )

    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms

    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $rect = $bounds

    if ($WindowTitle) {
        $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$WindowTitle*" } | Select-Object -First 1
        if (-not $proc) { throw "WINDOW_NOT_FOUND: 未找到标题包含「$WindowTitle」的窗口" }
        Add-Type -Namespace WinVM -Name RectApi -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
'@ -ErrorAction SilentlyContinue
        $r = New-Object WinVM.RectApi+RECT
        [void][WinVM.RectApi]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
        $rect = [System.Drawing.Rectangle]::FromLTRB($r.Left, $r.Top, $r.Right, $r.Bottom)
    }
    elseif ($Width -gt 0 -and $Height -gt 0) {
        $rect = [System.Drawing.Rectangle]::new($X, $Y, $Width, $Height)
    }

    if ($rect.Width -le 0 -or $rect.Height -le 0) { throw 'INVALID_RECT: 截图区域无效' }

    $bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
    }
    finally { $g.Dispose() }

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()

    if ($AsBase64) {
        return [ordered]@{
            encoding = 'base64'; mimeType = 'image/png'
            data = [Convert]::ToBase64String($bytes)
            width = $rect.Width; height = $rect.Height; bytes = $bytes.Length
            capturedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
    }

    # D17：非 base64 形态必须**落盘**并回传路径 —— 旧实现只回 {width,height,bytes}，
    # 调用方拿不到任何图像内容/路径，等于「截了等于没截」。产物统一写到约定工作目录。
    $outDir = Join-Path $env:USERPROFILE 'WinVMWorkspace\out'
    if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
    $file = Join-Path $outDir "screen_$stamp.png"
    [System.IO.File]::WriteAllBytes($file, $bytes)

    return [ordered]@{
        width      = $rect.Width
        height     = $rect.Height
        bytes      = $bytes.Length
        mimeType   = 'image/png'
        path       = $file
        savedTo    = $file
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

# ------------------------------ 黑屏检测（gui.screen.analyze） ------------------------------

function Test-ScreenBlack {
    param([double]$Threshold = 2.0)

    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms

    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $w = [Math]::Min(320, $bounds.Width)
    $h = [Math]::Min(240, $bounds.Height)

    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size) } finally { $g.Dispose() }

    # 采样计算灰度方差：纯黑/纯色屏方差趋近 0
    $samples = New-Object System.Collections.ArrayList
    for ($x = 0; $x -lt $w; $x += 8) {
        for ($y = 0; $y -lt $h; $y += 8) {
            $c = $bmp.GetPixel($x, $y)
            [void]$samples.Add([double](0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B))
        }
    }
    $bmp.Dispose()

    if ($samples.Count -eq 0) { return [ordered]@{ isBlack = $true; variance = 0; note = '无采样点' } }

    $mean = ($samples | Measure-Object -Average).Average
    $var = ($samples | ForEach-Object { [Math]::Pow($_ - $mean, 2) } | Measure-Object -Average).Average

    return [ordered]@{
        isBlack  = ($var -lt $Threshold)
        variance = [math]::Round($var, 3)
        meanGray = [math]::Round($mean, 2)
        samples  = $samples.Count
        threshold = $Threshold
    }
}

# ------------------------------ 窗口枚举（gui.window.list） ------------------------------

function Get-WindowList {
    param([string]$Title = '', [switch]$VisibleOnly)

    $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
    if ($Title) { $procs = $procs | Where-Object { $_.MainWindowTitle -like "*$Title*" } }

    return @($procs | ForEach-Object {
        [ordered]@{
            handle      = $_.MainWindowHandle.ToInt64()
            title       = $_.MainWindowTitle
            processName = $_.ProcessName
            processId   = $_.Id
        }
    })
}

# ------------------------------ 窗口控制（gui.window.control） ------------------------------

function Set-WindowState {
    param(
        [Parameter(Mandatory)][string]$Title,
        [ValidateSet('minimize', 'maximize', 'restore', 'close', 'activate')][string]$State = 'activate'
    )

    $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
    if (-not $proc) { throw "WINDOW_NOT_FOUND: 未找到标题包含「$Title」的窗口" }

    Add-Type -Namespace WinVM -Name WinApi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool CloseWindow(System.IntPtr hWnd);
'@ -ErrorAction Stop

    $h = $proc.MainWindowHandle
    switch ($State) {
        'minimize'  { [void][WinVM.WinApi]::ShowWindowAsync($h, 2) }
        'maximize'  { [void][WinVM.WinApi]::ShowWindowAsync($h, 3) }
        'restore'   { [void][WinVM.WinApi]::ShowWindowAsync($h, 9) }
        'activate'  { [void][WinVM.WinApi]::ShowWindowAsync($h, 9); [void][WinVM.WinApi]::SetForegroundWindow($h) }
        'close'     { $proc.CloseMainWindow() | Out-Null }
    }

    return [ordered]@{ title = $proc.MainWindowTitle; state = $State; processId = $proc.Id; applied = $true }
}

# ------------------------------ 键鼠输入（gui.input.*） ------------------------------

function Initialize-InputApi {
    if ('WinVM.InputApi' -as [type]) { return }
    Add-Type -Namespace WinVM -Name InputApi -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public System.IntPtr dwExtraInfo; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit)]
public struct INPUTUNION { [System.Runtime.InteropServices.FieldOffset(0)] public MOUSEINPUT mi; [System.Runtime.InteropServices.FieldOffset(0)] public KEYBDINPUT ki; [System.Runtime.InteropServices.FieldOffset(0)] public HARDWAREINPUT hi; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUTUNION u; }
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
'@ -ErrorAction Stop
}

function Send-KeyboardInput {
    param(
        [string]$Text = '',
        [string[]]$Keys = @(),
        [int]$DelayMs = 20
    )

    Initialize-InputApi

    $vkMap = @{
        'enter' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20
        'backspace' = 0x08; 'delete' = 0x2E; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
        'home' = 0x24; 'end' = 0x23; 'ctrl' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B
        'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74
    }

    $inputs = New-Object System.Collections.ArrayList

    foreach ($k in $Keys) {
        $key = $k.ToLowerInvariant()
        if (-not $vkMap.ContainsKey($key)) { throw "UNSUPPORTED_KEY: 不支持的组合键：$k" }
        $vk = $vkMap[$key]
        $down = New-Object WinVM.InputApi+INPUT
        $down.type = 1; $down.u.ki.wVk = $vk; $down.u.ki.dwFlags = 0
        $up = New-Object WinVM.InputApi+INPUT
        $up.type = 1; $up.u.ki.wVk = $vk; $up.u.ki.dwFlags = 2
        [void]$inputs.Add($down); [void]$inputs.Add($up)
    }

    if ($Text) {
        foreach ($ch in $Text.ToCharArray()) {
            $d = New-Object WinVM.InputApi+INPUT
            $d.type = 1; $d.u.ki.wScan = [uint16][int]$ch; $d.u.ki.dwFlags = 4   # KEYEVENTF_UNICODE
            $u = New-Object WinVM.InputApi+INPUT
            $u.type = 1; $u.u.ki.wScan = [uint16][int]$ch; $u.u.ki.dwFlags = 6   # UNICODE | KEYUP
            [void]$inputs.Add($d); [void]$inputs.Add($u)
        }
    }

    if ($inputs.Count -eq 0) { throw 'INVALID_PARAMS: Text 与 Keys 不能同时为空' }

    $arr = [WinVM.InputApi+INPUT[]]$inputs.ToArray()
    # 2026-10-27 Step6.3 补测暴露：静态 Marshal::SizeOf([Type]) 在 PS 5.1 对运行时 Add-Type
    # 结构抛「类型 System.RuntimeType 不能作为非托管结构进行封送处理」=> 键鼠输入全灭。
    # 正解=对**实例**取非托管尺寸（SizeOf(object) 重载），一次算好复用。
    $cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($arr[0])
    $sent = [WinVM.InputApi]::SendInput([uint32]$arr.Length, $arr, $cbSize)
    Start-Sleep -Milliseconds $DelayMs

    return [ordered]@{ sent = $sent; textLength = $Text.Length; keys = $Keys }
}

function Send-MouseInput {
    param(
        [ValidateSet('move', 'click', 'doubleClick', 'rightClick', 'wheel', 'drag')]
        [string]$Action = 'click',
        [int]$X = 0, [int]$Y = 0,
        [int]$ToX = 0, [int]$ToY = 0,
        [int]$WheelDelta = 0,
        [int]$DelayMs = 50
    )

    Initialize-InputApi
    [void][WinVM.InputApi]::SetCursorPos($X, $Y)

    $MOUSEEVENTF_MOVE = 0x0001; $LEFTDOWN = 0x0002; $LEFTUP = 0x0004
    $RIGHTDOWN = 0x0008; $RIGHTUP = 0x0010; $WHEEL = 0x0800; $ABSOLUTE = 0x8000

    $inputs = New-Object System.Collections.ArrayList
    $mk = {
        param([uint32]$flags, [int]$dx = 0, [int]$dy = 0, [uint32]$data = 0)
        $i = New-Object WinVM.InputApi+INPUT
        $i.type = 0; $i.u.mi.dx = $dx; $i.u.mi.dy = $dy
        $i.u.mi.dwFlags = $flags; $i.u.mi.mouseData = $data
        return $i
    }

    switch ($Action) {
        'move'        { [void]$inputs.Add((& $mk ($MOUSEEVENTF_MOVE -bor $ABSOLUTE) $X $Y)) }
        'click'       { [void]$inputs.Add((& $mk $LEFTDOWN)); [void]$inputs.Add((& $mk $LEFTUP)) }
        'doubleClick' {
            [void]$inputs.Add((& $mk $LEFTDOWN)); [void]$inputs.Add((& $mk $LEFTUP))
            [void]$inputs.Add((& $mk $LEFTDOWN)); [void]$inputs.Add((& $mk $LEFTUP))
        }
        'rightClick'  { [void]$inputs.Add((& $mk $RIGHTDOWN)); [void]$inputs.Add((& $mk $RIGHTUP)) }
        'wheel'       { [void]$inputs.Add((& $mk $WHEEL 0 0 ([uint32]$WheelDelta))) }
        'drag' {
            [void]$inputs.Add((& $mk ($MOUSEEVENTF_MOVE -bor $ABSOLUTE) $X $Y))
            [void]$inputs.Add((& $mk $LEFTDOWN))
            [void]$inputs.Add((& $mk ($MOUSEEVENTF_MOVE -bor $ABSOLUTE) $ToX $ToY))
            [void]$inputs.Add((& $mk $LEFTUP))
        }
    }

    $arr = [WinVM.InputApi+INPUT[]]$inputs.ToArray()
    # 2026-10-27 Step6.3 补测暴露：静态 Marshal::SizeOf([Type]) 在 PS 5.1 对运行时 Add-Type
    # 结构抛「类型 System.RuntimeType 不能作为非托管结构进行封送处理」=> 键鼠输入全灭。
    # 正解=对**实例**取非托管尺寸（SizeOf(object) 重载），一次算好复用。
    $cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($arr[0])
    $sent = [WinVM.InputApi]::SendInput([uint32]$arr.Length, $arr, $cbSize)
    Start-Sleep -Milliseconds $DelayMs

    return [ordered]@{ action = $Action; sent = $sent; x = $X; y = $Y }
}

# ------------------------------ UIA（gui.uia.*） ------------------------------

function Get-UiaTree {
    param([string]$WindowTitle = '', [int]$MaxDepth = 3)

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    $auto = [System.Windows.Automation.AutomationElement]::RootElement
    if ($WindowTitle) {
        $cond = [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty, $WindowTitle)
        $win = $auto.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
        if (-not $win) { throw "WINDOW_NOT_FOUND: $WindowTitle" }
        $root = $win
    }
    else { $root = $auto }

    function Get-UiaNode {
        param($Element, [int]$Depth, [int]$MaxDepth)
        $node = [ordered]@{
            name = $Element.Current.Name
            controlType = $Element.Current.ControlType.ProgrammaticName
            automationId = $Element.Current.AutomationId
            className = $Element.Current.ClassName
            isEnabled = $Element.Current.IsEnabled
        }
        if ($Depth -lt $MaxDepth) {
            $children = $Element.FindAll(
                [System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)
            $list = @()
            foreach ($c in $children) {
                if ($list.Count -ge 50) { break }
                $list += Get-UiaNode -Element $c -Depth ($Depth + 1) -MaxDepth $MaxDepth
            }
            $node['children'] = $list
        }
        return $node
    }

    return Get-UiaNode -Element $root -Depth 0 -MaxDepth $MaxDepth
}

function Invoke-UiaElement {
    param(
        [Parameter(Mandatory)][string]$WindowTitle,
        [string]$AutomationId = '',
        [string]$Name = '',
        [string]$ControlType = '',
        [ValidateSet('invoke', 'setValue', 'toggle', 'focus')][string]$Action = 'invoke',
        [string]$Value = ''
    )

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    $auto = [System.Windows.Automation.AutomationElement]::RootElement
    $winCond = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty, $WindowTitle)
    $win = $auto.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCond)
    if (-not $win) { throw "WINDOW_NOT_FOUND: $WindowTitle" }

    $conds = New-Object System.Collections.ArrayList
    if ($AutomationId) {
        [void]$conds.Add([System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId))
    }
    if ($Name) {
        [void]$conds.Add([System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty, $Name))
    }
    if ($ControlType) {
        $ct = [System.Windows.Automation.ControlType]::LookupById(
            [System.Windows.Automation.ControlType]::$ControlType.Id)
        [void]$conds.Add([System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct))
    }
    if ($conds.Count -eq 0) { throw 'INVALID_PARAMS: 至少指定 AutomationId / Name / ControlType 之一' }

    $cond = if ($conds.Count -eq 1) { $conds[0] }
    else { [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]$conds.ToArray()) }

    $el = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if (-not $el) { throw "ELEMENT_NOT_FOUND: 未找到匹配的元素" }

    switch ($Action) {
        'invoke' {
            $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            if (-not $p) { throw 'PATTERN_UNSUPPORTED: 元素不支持 InvokePattern' }
            $p.Invoke()
        }
        'setValue' {
            $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if (-not $p) { throw 'PATTERN_UNSUPPORTED: 元素不支持 ValuePattern' }
            $p.SetValue($Value)
        }
        'toggle' {
            $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            if (-not $p) { throw 'PATTERN_UNSUPPORTED: 元素不支持 TogglePattern' }
            $p.Toggle()
        }
        'focus' { $el.SetFocus() }
    }

    return [ordered]@{
        window = $WindowTitle; automationId = $AutomationId; name = $Name
        action = $Action; applied = $true
    }
}

# ------------------------------ 剪贴板（gui.clipboard.manage） ------------------------------

function Get-ClipboardText {
    Add-Type -AssemblyName System.Windows.Forms
    return [ordered]@{ text = [System.Windows.Forms.Clipboard]::GetText() }
}

function Set-ClipboardTextValue {
    param([Parameter(Mandatory)][string]$Text)
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Clipboard]::SetText($Text)
    return [ordered]@{ set = $true; length = $Text.Length }
}

# ------------------------------ gui.clipboard.manage 读写分派（M6 · Phase 3 批4） ------------------------------
# 能力声明本就是「剪贴板**读写**」（definitions.ts description 名实相符补债）：
#   · 请求带 `text` 参数（$PSBoundParameters 判定，空串=合法的「清空剪贴板」写入）⇒ 走写侧；
#   · 不带 ⇒ 走读侧（与挂载前逐字同行为）。
# 分派函数是注册表唯一绑定（fn='Invoke-GuiClipboardManage'）；Get/Set 两函数保留为内部实现
# ——psmod-contract 孤儿守卫据此把 Set-ClipboardTextValue 从孤儿快照除名（接上=期望变红同步）。
function Invoke-GuiClipboardManage {
    param(
        [string]$Text
    )
    if ($PSBoundParameters.ContainsKey('Text')) {
        return Set-ClipboardTextValue -Text $Text
    }
    return Get-ClipboardText
}

# ------------------------------ 等待条件（gui.wait.condition） ------------------------------

function Wait-GuiCondition {
    param(
        [ValidateSet('windowExists', 'windowGone', 'processExited', 'screenStable')]
        [string]$Condition = 'windowExists',
        [string]$WindowTitle = '',
        [int]$ProcessId = 0,
        [int]$TimeoutMs = 15000,
        [int]$PollIntervalMs = 300
    )

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $lastHash = ''

    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        $met = $false
        switch ($Condition) {
            'windowExists' {
                $met = ($null -ne (Get-Process | Where-Object { $_.MainWindowTitle -like "*$WindowTitle*" } | Select-Object -First 1))
            }
            'windowGone' {
                $met = ($null -eq (Get-Process | Where-Object { $_.MainWindowTitle -like "*$WindowTitle*" } | Select-Object -First 1))
            }
            'processExited' {
                $met = ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
            }
            'screenStable' {
                Add-Type -AssemblyName System.Drawing
                Add-Type -AssemblyName System.Windows.Forms
                $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                $bmp = New-Object System.Drawing.Bitmap 160, 120
                $g = [System.Drawing.Graphics]::FromImage($bmp)
                try { $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size) } finally { $g.Dispose() }
                $ms = New-Object System.IO.MemoryStream
                $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                $hash = ([System.Security.Cryptography.SHA256]::Create()).ComputeHash($ms.ToArray()) -join ''
                $ms.Dispose(); $bmp.Dispose()
                if ($hash -eq $lastHash) { $met = $true } else { $lastHash = $hash }
            }
        }
        if ($met) {
            return [ordered]@{ condition = $Condition; met = $true; elapsedMs = $sw.ElapsedMilliseconds }
        }
        Start-Sleep -Milliseconds $PollIntervalMs
    }

    return [ordered]@{ condition = $Condition; met = $false; elapsedMs = $sw.ElapsedMilliseconds; timedOut = $true }
}
