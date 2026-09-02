<#
.SYNOPSIS
    WinVM Bridge —— storage 能力域（存储管理，FR-203）

.NOTES
    安全约定（SECURITY-GOVERNANCE.md）：
      - 删除默认进**回收站**，仅当显式 -Permanent 且已过审批才物理删除；
      - 分区/格式化列为 L3，**不在本模块提供**，需人工在 VM 内执行。
#>

Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction SilentlyContinue

# ------------------------------ storage.disk.list ------------------------------

function Get-DiskInfo {
    param([switch]$IncludeVolumes)

    $disks = @(Get-Disk -ErrorAction SilentlyContinue | ForEach-Object {
        $d = $_
        $parts = @(Get-Partition -DiskNumber $d.DiskNumber -ErrorAction SilentlyContinue | ForEach-Object {
            [ordered]@{
                partitionNumber = $_.PartitionNumber
                driveLetter     = $_.DriveLetter
                sizeGB          = [math]::Round($_.Size / 1GB, 2)
                type            = $_.Type
            }
        })
        [ordered]@{
            diskNumber  = $d.DiskNumber
            friendlyName = $d.FriendlyName
            sizeGB      = [math]::Round($d.Size / 1GB, 2)
            healthStatus = $d.HealthStatus.ToString()
            partitions  = $parts
        }
    })

    $result = [ordered]@{ disks = $disks }
    if ($IncludeVolumes) {
        $result['volumes'] = @(Get-Volume -ErrorAction SilentlyContinue |
            Where-Object { $_.DriveLetter } |
            ForEach-Object {
                [ordered]@{
                    driveLetter = $_.DriveLetter
                    label       = $_.FileSystemLabel
                    fileSystem  = $_.FileSystem
                    sizeGB      = [math]::Round($_.Size / 1GB, 2)
                    freeGB      = [math]::Round($_.SizeRemaining / 1GB, 2)
                    usedPercent = if ($_.Size -gt 0) { [math]::Round((1 - ($_.SizeRemaining / $_.Size)) * 100, 1) } else { 0 }
                }
            })
    }
    return $result
}

# ------------------------------ storage.space.analyze ------------------------------

function Get-DirectorySize {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int]$Depth = 2,
        [int]$Top = 30
    )

    if (-not (Test-Path -LiteralPath $Path)) { throw "PATH_NOT_FOUND: $Path" }

    function Measure-Tree {
        param([string]$Root, [int]$MaxDepth, [int]$Current)
        $size = 0L
        $count = 0L
        try {
            $enum = [System.IO.Directory]::EnumerateFileSystemEntries($Root)
            foreach ($e in $enum) {
                try {
                    if ([System.IO.Directory]::Exists($e)) {
                        if ($Current -lt $MaxDepth) {
                            $sub = Measure-Tree -Root $e -MaxDepth $MaxDepth -Current ($Current + 1)
                            $size += $sub.Size; $count += $sub.Count
                        }
                    }
                    else {
                        $fi = [System.IO.FileInfo]::new($e)
                        $size += $fi.Length; $count++
                    }
                }
                catch { }
            }
        }
        catch { }
        return [ordered]@{ Size = $size; Count = $count }
    }

    $results = @()
    $topLevel = [System.IO.Directory]::GetDirectories($Path)
    foreach ($d in $topLevel) {
        try {
            $m = Measure-Tree -Root $d -MaxDepth $Depth -Current 1
            $results += [ordered]@{
                path  = $d
                sizeMB = [math]::Round($m.Size / 1MB, 2)
                files = $m.Count
            }
        }
        catch { }
    }

    $results = $results | Sort-Object -Property sizeMB -Descending | Select-Object -First $Top
    return [ordered]@{ root = $Path; depth = $Depth; entries = @($results) }
}

# ------------------------------ storage.file.read / write ------------------------------

function Read-TextFileContent {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int]$MaxBytes = 1048576,
        [switch]$AsBase64
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "FILE_NOT_FOUND: $Path" }

    if ($AsBase64) {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -gt $MaxBytes) { throw "FILE_TOO_LARGE: $($bytes.Length) 字节超过上限 $MaxBytes" }
        return [ordered]@{ path = $Path; encoding = 'base64'; content = [Convert]::ToBase64String($bytes); bytes = $bytes.Length }
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -gt $MaxBytes) { throw "FILE_TOO_LARGE: $($bytes.Length) 字节超过上限 $MaxBytes" }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    return [ordered]@{ path = $Path; encoding = 'utf8'; content = $text; bytes = $bytes.Length }
}

function Write-TextFileContent {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Content,
        [switch]$Append,
        [switch]$CreateDirectory
    )

    $dir = [System.IO.Path]::GetDirectoryName($Path)
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        if ($CreateDirectory) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        else { throw "PATH_NOT_FOUND: 目录不存在 —— $dir" }
    }

    if ($Append) { Add-Content -LiteralPath $Path -Value $Content -Encoding UTF8 -ErrorAction Stop }
    else { Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8 -ErrorAction Stop }

    return [ordered]@{ path = $Path; appended = [bool]$Append; bytes = (Get-Item -LiteralPath $Path).Length }
}

# ------------------------------ storage.file.delete ------------------------------

function Remove-FileSystemItem {
    param(
        [Parameter(Mandatory)][string]$Path,
        [switch]$Permanent,
        [switch]$DryRun
    )

    if (-not (Test-Path -LiteralPath $Path)) { throw "PATH_NOT_FOUND: $Path" }

    $isDir = Test-Path -LiteralPath $Path -PathType Container
    $count = if ($isDir) {
        @([System.IO.Directory]::EnumerateFileSystemEntries($Path, '*', 'AllDirectories')).Count
    } else { 1 }

    if ($DryRun) {
        return [ordered]@{ path = $Path; dryRun = $true; isDirectory = $isDir; estimatedItems = $count; permanent = [bool]$Permanent }
    }

    if ($Permanent) {
        # 物理删除（需 L2 审批）
        if ($isDir) { [System.IO.Directory]::Delete($Path, $true) }
        else { [System.IO.File]::Delete($Path) }
    }
    else {
        # 默认进回收站（安全默认）
        $opt = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
        $recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
        if ($isDir) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($Path, $opt, $recycle) }
        else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($Path, $opt, $recycle) }
    }

    return [ordered]@{ path = $Path; deleted = $true; permanent = [bool]$Permanent; isDirectory = $isDir; items = $count }
}

# ------------------------------ storage.file.move / copy ------------------------------

function Move-FileSystemItem {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Destination, [switch]$Force)
    Move-Item -LiteralPath $Path -Destination $Destination -Force:$Force -ErrorAction Stop
    return [ordered]@{ from = $Path; to = $Destination; moved = (Test-Path -LiteralPath $Destination) }
}

function Copy-FileSystemItem {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Destination, [switch]$Recurse, [switch]$Force)
    Copy-Item -LiteralPath $Path -Destination $Destination -Recurse:$Recurse -Force:$Force -ErrorAction Stop
    return [ordered]@{ from = $Path; to = $Destination; copied = (Test-Path -LiteralPath $Destination) }
}

# ------------------------------ storage.dir.manage ------------------------------

function New-DirectoryItem {
    param([Parameter(Mandatory)][string]$Path)
    if (Test-Path -LiteralPath $Path) { return [ordered]@{ path = $Path; created = $false; existed = $true } }
    New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null
    return [ordered]@{ path = $Path; created = $true; existed = $false }
}

# ------------------------------ storage.search.query ------------------------------

function Search-FileSystem {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Pattern = '*',
        [string]$ContentPattern = '',
        [int]$MaxResults = 100,
        [switch]$Recurse
    )

    if (-not (Test-Path -LiteralPath $Path)) { throw "PATH_NOT_FOUND: $Path" }

    $items = Get-ChildItem -LiteralPath $Path -Filter $Pattern -Recurse:$Recurse -ErrorAction SilentlyContinue |
        Select-Object -First $MaxResults

    if ($ContentPattern) {
        $items = Get-ChildItem -LiteralPath $Path -Filter $Pattern -Recurse:$Recurse -File -ErrorAction SilentlyContinue |
            Select-String -Pattern $ContentPattern -List -ErrorAction SilentlyContinue |
            Select-Object -First $MaxResults
        return @($items | ForEach-Object {
            [ordered]@{ path = $_.Path; line = $_.LineNumber; match = $_.Line.Trim() }
        })
    }

    return @($items | ForEach-Object {
        [ordered]@{
            path       = $_.FullName
            name       = $_.Name
            isDirectory = $_.PSIsContainer
            sizeBytes  = if ($_.PSIsContainer) { $null } else { $_.Length }
            modified   = $_.LastWriteTime.ToString('o')
        }
    })
}

# ------------------------------ storage.archive.manage ------------------------------

function New-ZipArchiveItem {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Destination)
    Compress-Archive -LiteralPath $Path -DestinationPath $Destination -Force -ErrorAction Stop
    return [ordered]@{ from = $Path; archive = $Destination; bytes = (Get-Item -LiteralPath $Destination).Length }
}

function Expand-ZipArchiveItem {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Destination)
    Expand-Archive -LiteralPath $Path -DestinationPath $Destination -Force -ErrorAction Stop
    return [ordered]@{ archive = $Path; to = $Destination; extracted = $true }
}

# ------------------------------ storage.link.manage ------------------------------

function New-LinkItem {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Target,
        [ValidateSet('SymbolicLink', 'HardLink', 'Junction')][string]$Type = 'SymbolicLink'
    )
    New-Item -ItemType $Type -Path $Path -Target $Target -ErrorAction Stop | Out-Null
    return [ordered]@{ path = $Path; target = $Target; type = $Type; created = $true }
}

# ------------------------------ storage.recycle.manage ------------------------------

function Get-RecycleBinInfo {
    $shell = New-Object -ComObject Shell.Application
    $bin = $shell.Namespace(0xA)
    $items = @($bin.Items() | ForEach-Object {
        [ordered]@{ name = $bin.GetDetailsOf($_, 0); path = $bin.GetDetailsOf($_, 1); size = $bin.GetDetailsOf($_, 3) }
    })
    return [ordered]@{ count = $items.Count; items = $items }
}

# ------------------------------ storage.cleanup.analyze ------------------------------

function Get-CleanupSuggestions {
    param([int]$TopLargeFiles = 30)

    $sugs = New-Object System.Collections.ArrayList

    # Windows 临时文件
    $tempPaths = @($env:TEMP, 'C:\Windows\Temp')
    foreach ($tp in $tempPaths) {
        if (Test-Path -LiteralPath $tp) {
            $size = @(Get-ChildItem -LiteralPath $tp -Recurse -File -ErrorAction SilentlyContinue |
                Measure-Object -Property Length -Sum).Sum
            if ($size -gt 0) {
                [void]$sugs.Add([ordered]@{
                    category = '临时文件'; path = $tp; sizeMB = [math]::Round($size / 1MB, 2)
                    safety = 'safe'; note = '可安全清理，但请先确认无正在使用的文件'
                })
            }
        }
    }

    # 回收站
    $rb = Get-RecycleBinInfo
    [void]$sugs.Add([ordered]@{
        category = '回收站'; path = '(recycle bin)'; itemCount = $rb.count
        safety = 'safe'; note = '清空后不可恢复'
    })

    # 大文件（用户目录，限制深度避免长时间扫描）
    $userProfile = $env:USERPROFILE
    if (Test-Path -LiteralPath $userProfile) {
        $big = @(Get-ChildItem -LiteralPath $userProfile -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object -Property Length -Descending | Select-Object -First $TopLargeFiles |
            ForEach-Object {
                [ordered]@{ path = $_.FullName; sizeMB = [math]::Round($_.Length / 1MB, 2) }
            })
        if ($big.Count -gt 0) {
            [void]$sugs.Add([ordered]@{
                category = '大文件'; path = $userProfile; files = $big
                safety = 'review'; note = '需人工确认后删除，切勿批量清理'
            })
        }
    }

    return [ordered]@{ suggestions = @($sugs.ToArray()); note = '仅分析，不执行任何删除' }
}
