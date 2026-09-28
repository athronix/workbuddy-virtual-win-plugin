Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "C:\WinVMBridge\packages\vm-capabilities\psmod\gui.ps1"
$r = Get-SessionHealth
$lines = @()
$lines += ("TYPE=" + $r.GetType().FullName)
$lines += ("IS_ARRAY=" + ($r -is [array]))
$lines += ("COUNT=" + $r.Count)
$lines += ("RAW=" + ($r | ConvertTo-Json -Compress -Depth 5))
if ($r -is [array]) {
    for ($i = 0; $i -lt $r.Count; $i++) {
        $lines += ("ELEM" + $i + "_TYPE=" + $r[$i].GetType().FullName)
        $lines += ("ELEM" + $i + "_JSON=" + ($r[$i] | ConvertTo-Json -Compress -Depth 5))
    }
} else {
    $lines += ("SESSION_ID=" + $r.sessionId)
}
$lines | Out-File C:\WinVMBridge\.diag3.out -Encoding utf8
