$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$configPath = Join-Path (Get-Location) 'dist\installer-source.json'
New-Item -ItemType Directory -Force -Path 'dist' | Out-Null
$remote = (& git remote get-url origin 2>$null)
$repo = $null
if ($LASTEXITCODE -eq 0 -and $remote -match 'github\.com[:/]([^/]+/[^/.]+)(?:\.git)?$') { $repo = $Matches[1] }
@{ localPath='D:\NodeJS\Norways Diff Checker'; githubRepo=$repo; branch='main' } | ConvertTo-Json | Set-Content -LiteralPath $configPath
$compiler = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\nsis') -Recurse -Filter makensis.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.DirectoryName -notmatch '\\Bin$' } | Select-Object -First 1
if (!$compiler) { throw 'NSIS compiler not found. Run npx electron-builder --win nsis once to obtain it.' }
& $compiler.FullName "/DSOURCE_CONFIG=$configPath" 'installer\bootstrap.nsi'
if ($LASTEXITCODE -ne 0) { throw 'NSIS installer build failed.' }
Write-Host 'Created dist\NorwaysDiffCheckerInstaller.exe'
