$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $root 'dist\installer'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'NorwaysDiffCheckerInstaller.bat') -Destination $destination -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'engine.ps1') -Destination $destination -Force
Write-Host "Installer scripts are ready in $destination"
