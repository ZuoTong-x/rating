param(
    [string]$Source = 'D:\v030_data\V030_images.zip',
    [string]$DataDir = 'D:\v030_data',
    [string]$HostName = 'sensebench@101.89.57.33',
    [string]$RemoteDir = '/data/sunwenxiu/rating/inbox',
    [string]$ImportDir = '/home/sensebench/sunwenxiu/rating_v9'
)

$ErrorActionPreference = 'Stop'
$progressPath = Join-Path $DataDir 'V030_split_upload_progress.json'
$parts = @(
    @{ Index = 1; Name = 'V030_images_20G_1.zip' },
    @{ Index = 2; Name = 'V030_images_20G_2.zip' },
    @{ Index = 3; Name = 'V030_images_40G_3.zip' }
)

function Write-ProgressRecord([int]$index, [string]$status, [hashtable]$extra = @{}) {
    $record = [ordered]@{
        source = $Source
        updated_at = (Get-Date).ToString('o')
        part = $index
        status = $status
    }
    foreach ($key in $extra.Keys) { $record[$key] = $extra[$key] }
    [IO.File]::WriteAllText($progressPath, ($record | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}

function Get-RemoteSize([string]$name) {
    $remotePath = "$RemoteDir/$name"
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            $result = ssh -o BatchMode=yes -o ConnectTimeout=15 $HostName "stat -c '%s' '$remotePath' 2>/dev/null || echo 0"
            $lineObject = $result | Select-Object -Last 1
            if ($null -ne $lineObject) {
                $line = $lineObject.ToString().Trim()
                if ($line -match '^\d+$') { return [int64]$line }
            }
        } catch {
            if ($attempt -eq 4) { throw }
        }
        Start-Sleep -Seconds 2
    }
    return [int64]0
}

function Wait-Upload([string]$localPath, [string]$name, [int]$index, [bool]$startScp) {
    $total = (Get-Item -LiteralPath $localPath).Length
    $remotePath = "$RemoteDir/$name"
    $process = $null
    if ($startScp) {
        $args = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', $localPath, "$HostName`:$remotePath")
        $process = Start-Process -FilePath 'scp' -ArgumentList $args -PassThru -NoNewWindow
    }
    $previous = Get-RemoteSize $name
    $previousTime = Get-Date
    while ($true) {
        Start-Sleep -Seconds 10
        $current = Get-RemoteSize $name
        $now = Get-Date
        $seconds = [math]::Max(($now - $previousTime).TotalSeconds, 0.001)
        $speed = ($current - $previous) / $seconds
        $eta = if ($speed -gt 0) { ($total - $current) / $speed } else { 0 }
        $percent = if ($total -gt 0) { $current / $total * 100 } else { 0 }
        Write-Host ("{0} {1}: {2:N2}% {3:N2} MB/s ETA {4}" -f (Get-Date -Format HH:mm:ss), $name, $percent, ($speed / 1MB), ([timespan]::FromSeconds($eta)))
        if ($current -ge $total) { break }
        if ($process -and $process.HasExited) {
            throw "scp exited early with code $($process.ExitCode)"
        }
        $previous = $current
        $previousTime = $now
    }
    if ($process) {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "scp failed with code $($process.ExitCode)" }
    }
    if ((Get-RemoteSize $name) -ne $total) { throw "remote size mismatch for $name" }
    Write-ProgressRecord $index 'uploaded' @{ bytes = $total }
}

function Verify-And-Import([string]$localPath, [string]$name, [int]$index) {
    Write-ProgressRecord $index 'checking-upload'
    $localHash = (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $remotePath = "$RemoteDir/$name"
    $remoteOutput = ssh -o BatchMode=yes $HostName "sha256sum '$remotePath'"
    $remoteHash = (($remoteOutput | Select-Object -First 1) -split '\s+')[0].ToLowerInvariant()
    if ($localHash -ne $remoteHash) { throw "SHA256 mismatch for ${name}: local=$localHash remote=$remoteHash" }
    Write-ProgressRecord $index 'hash-verified' @{ sha256 = $localHash }

    # Keep the requested server-side mv command; source and destination are intentionally identical.
    ssh -o BatchMode=yes $HostName "mv '$remotePath' '$remotePath'"
    Write-ProgressRecord $index 'mv-complete' @{ sha256 = $localHash }

    $importCommand = "cd '$ImportDir' && docker compose exec -T api node src/import-local.js '/app/inbox/$name'"
    ssh -o BatchMode=yes $HostName $importCommand
    Write-ProgressRecord $index 'imported' @{ sha256 = $localHash }

    Remove-Item -LiteralPath $localPath -Force
    Write-ProgressRecord $index 'local-cleaned' @{ sha256 = $localHash }
}

Write-ProgressRecord 0 'pipeline-started'
for ($i = 0; $i -lt 2; $i++) {
    $part = $parts[$i]
    $localPath = Join-Path $DataDir $part.Name
    if (-not (Test-Path -LiteralPath $localPath)) { throw "missing local package: $localPath" }
    Write-ProgressRecord $part.Index 'waiting-upload'
    Wait-Upload $localPath $part.Name $part.Index ($i -eq 1)
    Verify-And-Import $localPath $part.Name $part.Index
}

$part3 = $parts[2]
$part3Path = Join-Path $DataDir $part3.Name
Write-ProgressRecord 3 'building'
python (Join-Path $PSScriptRoot 'split_v030_zip.py') --source $Source --output $part3Path --part 3
Write-ProgressRecord 3 'built-and-validated' @{ bytes = (Get-Item -LiteralPath $part3Path).Length }
Wait-Upload $part3Path $part3.Name $part3.Index $true
Verify-And-Import $part3Path $part3.Name $part3.Index
Write-ProgressRecord 3 'complete'
Write-Host 'V030 split upload/import pipeline complete.'
