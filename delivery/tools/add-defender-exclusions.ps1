# add-defender-exclusions.ps1 -- Add Windows Defender exclusions for the WinVM Bridge
#                                 service directories and interpreter processes.
#
# WHY: On this VM, Defender's per-process scanning adds a random 10-60s delay to every
# powershell.exe process creation, which is the common root cause of install/timeout
# flakiness across the whole delivery cycle (~9min -> ~4min after exclusion).
#
# WHAT: Add-MpPreference -ExclusionPath 'C:\WinVMBridge','C:\WinVMWorkspace'
#                    -ExclusionProcess 'node.exe','powershell.exe'
#
# USAGE (MUST be run as Administrator in the VM):
#   powershell -NoProfile -ExecutionPolicy Bypass -File add-defender-exclusions.ps1
#
# Constraints: ASCII-only, no BOM (host sandbox / transfer chain sensitive).
# Idempotent: existing exclusions are detected via Get-MpPreference and skipped.

$ErrorActionPreference = 'Stop'

$ExclusionPaths = @('C:\WinVMBridge', 'C:\WinVMWorkspace')
$ExclusionProcesses = @('node.exe', 'powershell.exe')

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

Write-Output "=== WinVM Bridge Defender exclusions ==="
Write-Output ("IsAdmin=" + (Test-IsAdmin))

# Step 1: read current exclusions (needed for idempotency).
try {
    $pref = Get-MpPreference -ErrorAction Stop
} catch {
    Write-Output ("MP_PREFERENCE_READ_FAILED: " + $_.Exception.Message)
    Write-Output "Hint: Get-MpPreference requires the Defender module (Windows Defender PowerShell provider)."
    exit 1
}

$existingPaths = @()
if ($pref.ExclusionPath) { $existingPaths = @($pref.ExclusionPath) }
$existingProcs = @()
if ($pref.ExclusionProcess) { $existingProcs = @($pref.ExclusionProcess) }

Write-Output ("Existing ExclusionPath: " + ($(if ($existingPaths.Count -gt 0) { $existingPaths -join ', ' } else { '(none)' })))
Write-Output ("Existing ExclusionProcess: " + ($(if ($existingProcs.Count -gt 0) { $existingProcs -join ', ' } else { '(none)' })))

# Step 2: compute the delta (avoid duplicate entries; Add-MpPreference would append blindly).
$addPaths = @($ExclusionPaths | Where-Object { $existingPaths -notcontains $_ })
$addProcs = @($ExclusionProcesses | Where-Object { $existingProcs -notcontains $_ })

if ($addPaths.Count -eq 0 -and $addProcs.Count -eq 0) {
    Write-Output "ALREADY_CONFIGURED: no missing exclusions, nothing to do."
    exit 0
}

# Step 3: apply (requires Administrator; Add-MpPreference fails with access denied otherwise).
try {
    if ($addPaths.Count -gt 0) {
        Add-MpPreference -ExclusionPath $addPaths -ErrorAction Stop
        Write-Output ("ADDED ExclusionPath: " + ($addPaths -join ', '))
    }
    if ($addProcs.Count -gt 0) {
        Add-MpPreference -ExclusionProcess $addProcs -ErrorAction Stop
        Write-Output ("ADDED ExclusionProcess: " + ($addProcs -join ', '))
    }
} catch {
    Write-Output ("DEFENDER_EXCLUSION_FAILED: " + $_.Exception.Message)
    Write-Output "Hint: run this script in an ELEVATED (Administrator) PowerShell inside the VM."
    Write-Output "Manual fallback: open admin PowerShell and run the two Add-MpPreference lines from the header comment."
    exit 1
}

# Step 4: echo the resulting exclusion list for auditability.
$pref2 = Get-MpPreference
Write-Output "=== Current exclusions (after) ==="
Write-Output ("ExclusionPath: " + ($(if ($pref2.ExclusionPath) { @($pref2.ExclusionPath) -join ', ' } else { '(none)' })))
Write-Output ("ExclusionProcess: " + ($(if ($pref2.ExclusionProcess) { @($pref2.ExclusionProcess) -join ', ' } else { '(none)' })))
Write-Output "DONE"
exit 0
