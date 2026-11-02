[CmdletBinding()]
param(
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputPath = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  Join-Path $projectRoot 'release'
} elseif ([IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory
} else {
  Join-Path $projectRoot $OutputDirectory
}
$releaseRoot = [IO.Path]::GetFullPath($outputPath)
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stagingRoot = Join-Path $releaseRoot ".staging-$timestamp"
$zipPath = Join-Path $releaseRoot "image-rating-platform-release-$timestamp.zip"

function Assert-PathInside([string]$Path, [string]$Parent) {
  $normalizedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $normalizedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if (
    -not $normalizedPath.Equals($normalizedParent, [StringComparison]::OrdinalIgnoreCase) -and
    -not $normalizedPath.StartsWith("$normalizedParent\", [StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "Refusing to operate outside the release directory: $normalizedPath"
  }
}

function Copy-ReleaseItem([string]$RelativePath) {
  $sourcePath = Join-Path $projectRoot $RelativePath
  $targetPath = Join-Path $stagingRoot $RelativePath

  if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Required release item is missing: $RelativePath"
  }

  if ((Get-Item -LiteralPath $sourcePath).PSIsContainer) {
    New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
    Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $targetPath -Recurse -Force
    return
  }

  $targetParent = Split-Path -Parent $targetPath
  New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
}

Assert-PathInside $releaseRoot $projectRoot
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Assert-PathInside $stagingRoot $releaseRoot

if (Test-Path -LiteralPath $stagingRoot) {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

$releaseItems = @(
  '.env',
  '.dockerignore',
  'README.md',
  'DEPLOY.md',
  'docker-compose.yml',
  'deploy',
  'package.json',
  'docs',
  'server/Dockerfile',
  'server/package.json',
  'server/package-lock.json',
  'server/src',
  'client/Dockerfile',
  'client/nginx.conf',
  'client/index.html',
  'client/package.json',
  'client/package-lock.json',
  'client/vite.config.ts',
  'client/tsconfig.json',
  'client/src'
)

foreach ($item in $releaseItems) {
  Copy-ReleaseItem $item
}

$archiveEntries = Get-ChildItem -LiteralPath $stagingRoot -Force
if (-not $archiveEntries) {
  throw 'No release files were collected'
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -LiteralPath $archiveEntries.FullName -DestinationPath $zipPath -CompressionLevel Optimal

try {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force
} catch {
  Write-Warning "The temporary staging directory could not be removed: $stagingRoot"
}

$zipInfo = Get-Item -LiteralPath $zipPath
Write-Host ''
Write-Host "Release package created:" -ForegroundColor Green
Write-Host "  $($zipInfo.FullName)"
Write-Host ("  Size: {0:N2} MB" -f ($zipInfo.Length / 1MB))
