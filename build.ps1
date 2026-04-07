[CmdletBinding()]
param(
	[string]$Version,
	[string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $repoRoot

$manifestPath = Join-Path $repoRoot "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
	throw "manifest.json not found at $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $Version) {
	$Version = $manifest.version
}
if (-not $Version) {
	throw "Unable to determine plugin version from manifest.json"
}

$packageName = "zotero-copilot-$Version.xpi"
$outputRoot = Join-Path $repoRoot $OutputDir
$outputPath = Join-Path $outputRoot $packageName

$includePaths = @(
	"manifest.json",
	"bootstrap.js",
	"copilot.js",
	"preferences.js",
	"preferences.xhtml",
	"preferences.css",
	"prefs.js",
	"icon.svg",
	"icon16.svg",
	"updates.json",
	"CLAUDE.md",
	"locale",
	"markdown",
	"vendor"
)

foreach ($relativePath in $includePaths) {
	$fullPath = Join-Path $repoRoot $relativePath
	if (-not (Test-Path -LiteralPath $fullPath)) {
		throw "Required packaging path missing: $relativePath"
	}
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("zotero-copilot-build-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

try {
	foreach ($relativePath in $includePaths) {
		$sourcePath = Join-Path $repoRoot $relativePath
		$destinationPath = Join-Path $stageRoot $relativePath
		$parentPath = Split-Path -Parent $destinationPath
		if ($parentPath) {
			New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
		}
		Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
	}

	if (Test-Path -LiteralPath $outputPath) {
		Remove-Item -LiteralPath $outputPath -Force
	}

	Add-Type -AssemblyName System.IO.Compression.FileSystem
	[System.IO.Compression.ZipFile]::CreateFromDirectory(
		$stageRoot,
		$outputPath,
		[System.IO.Compression.CompressionLevel]::Optimal,
		$false
	)

	$signature = [System.IO.File]::ReadAllBytes($outputPath)[0..1]
	if ($signature[0] -ne 0x50 -or $signature[1] -ne 0x4B) {
		throw "Build output is not a valid zip archive: $outputPath"
	}

	$archive = [System.IO.Compression.ZipFile]::OpenRead($outputPath)
	try {
		$manifestEntry = $archive.Entries | Where-Object { $_.FullName -eq "manifest.json" } | Select-Object -First 1
		if (-not $manifestEntry) {
			throw "manifest.json missing from archive"
		}
	}
	finally {
		$archive.Dispose()
	}

	Write-Host "Built $outputPath"
}
finally {
	if (Test-Path -LiteralPath $stageRoot) {
		Remove-Item -LiteralPath $stageRoot -Recurse -Force
	}
}
