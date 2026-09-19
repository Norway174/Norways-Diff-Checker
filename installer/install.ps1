param(
  [ValidateSet('install','update','update-silent')][string]$Mode = 'install',
  [Parameter(Mandatory)][string]$SourceConfig,
  [Parameter(Mandatory)][string]$InstallerPath
)
$ErrorActionPreference = 'Stop'
$appHome = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NorwaysDiffChecker'))
$program = [IO.Path]::GetFullPath((Join-Path $appHome 'program'))
$settings = [IO.Path]::GetFullPath((Join-Path $appHome 'settings'))
$work = [IO.Path]::GetFullPath((Join-Path $env:TEMP ('NDC-install-' + [guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Force -Path $work,$settings | Out-Null
$logPath = Join-Path $settings 'installer.log'
function Log([string]$message) {
  Add-Content -LiteralPath $logPath -Value ((Get-Date -Format o) + ' ' + $message)
  Write-Host $message
}
function AssertInside([string]$candidate,[string]$parent) {
  $full = [IO.Path]::GetFullPath($candidate)
  $base = [IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
  if (!$full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path: $full" }
}
try {
  $config = Get-Content -LiteralPath $SourceConfig -Raw | ConvertFrom-Json
  $archive = Join-Path $work 'source.zip'
  $sha = ''
  if ($config.githubRepo) {
    $repo = [string]$config.githubRepo
    $branch = [string]$config.branch
    Log "Reading latest $repo/$branch commit"
    $headers = @{ 'User-Agent' = 'NorwaysDiffCheckerInstaller'; 'Accept' = 'application/vnd.github+json' }
    $info = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/branches/$branch" -Headers $headers
    $sha = [string]$info.commit.sha
    if ($sha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid GitHub commit SHA.' }
    Invoke-WebRequest -Uri "https://api.github.com/repos/$repo/zipball/$sha" -Headers $headers -OutFile $archive
  } else {
    $source = [string]$config.localPath
    if (!(Test-Path -LiteralPath (Join-Path $source '.git'))) { throw "Local Git repository not found: $source" }
    $sha = (& git -C $source rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[a-f0-9]{40}$') { throw 'Could not read local committed HEAD.' }
    Log "Archiving local commit $sha"
    & git -C $source archive --format=zip --output=$archive HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Git archive failed.' }
  }
  $sourceRoot = Join-Path $work 'source'
  Expand-Archive -LiteralPath $archive -DestinationPath $sourceRoot
  if (!(Test-Path -LiteralPath (Join-Path $sourceRoot 'package.json'))) {
    $candidate = Get-ChildItem -LiteralPath $sourceRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') } | Select-Object -First 1
    if (!$candidate) { throw 'Source archive has no package.json.' }
    $sourceRoot = $candidate.FullName
  }
  if (!(Test-Path -LiteralPath (Join-Path $sourceRoot 'package-lock.json'))) { throw 'Source archive has no lockfile.' }
  $nodeVersion = 'v24.8.0'
  $nodeZipName = "node-$nodeVersion-win-x64.zip"
  $nodeZip = Join-Path $work $nodeZipName
  $expectedSha = '970ecc121a16f546174b6a870215ca4cc0de33f8a616b42c16c8c02e66b07d05'
  Log 'Downloading pinned Node build runtime'
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVersion/$nodeZipName" -OutFile $nodeZip
  if ((Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedSha) { throw 'Node runtime hash mismatch.' }
  Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $work 'node')
  $nodeDir = Join-Path $work "node\node-$nodeVersion-win-x64"
  $env:PATH = $nodeDir + ';' + $env:PATH
  $npm = Join-Path $nodeDir 'npm.cmd'
  Log 'Installing locked dependencies and building unpacked program'
  Push-Location $sourceRoot
  try {
    & $npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    & $npm run check
    if ($LASTEXITCODE -ne 0) { throw 'Application checks failed.' }
    & $npm run build:dir
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
  } finally { Pop-Location }
  $built = Join-Path $sourceRoot 'dist\win-unpacked'
  if (!(Test-Path -LiteralPath (Join-Path $built 'Norways Diff Checker.exe'))) { throw 'Built executable is missing.' }
  $staged = Join-Path $work 'program-new'
  Copy-Item -LiteralPath $built -Destination $staged -Recurse
  Copy-Item -LiteralPath $InstallerPath -Destination (Join-Path $staged 'NorwaysDiffCheckerInstaller.exe')
  $running = Get-CimInstance Win32_Process -Filter "name = 'Norways Diff Checker.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($program,[StringComparison]::OrdinalIgnoreCase) }
  if ($running) {
    Log 'Waiting for the application to close'
    for ($i=0; $i -lt 60 -and $running; $i++) {
      Start-Sleep -Seconds 1
      $running = Get-CimInstance Win32_Process -Filter "name = 'Norways Diff Checker.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($program,[StringComparison]::OrdinalIgnoreCase) }
    }
    if ($running) { throw 'Please close Norways Diff Checker before updating.' }
  }
  AssertInside $program $appHome
  $backup = Join-Path $work 'program-old'
  if (Test-Path -LiteralPath $program) { Move-Item -LiteralPath $program -Destination $backup }
  try {
    Move-Item -LiteralPath $staged -Destination $program
    $sourceName = 'local'
    if ($config.githubRepo) { $sourceName = 'github' }
    $marker = @{ sha=$sha; source=$sourceName; githubRepo=$config.githubRepo; branch=$config.branch; installedAt=(Get-Date -Format o) }
    $marker | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $settings 'installed.json')
    Log "Installed commit $sha"
  } catch {
    if (Test-Path -LiteralPath $program) { AssertInside $program $appHome; Remove-Item -LiteralPath $program -Recurse -Force }
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $program }
    throw
  }
  if ($Mode -eq 'update') { Start-Process -FilePath (Join-Path $program 'Norways Diff Checker.exe') -WindowStyle Normal }
} catch {
  Log ('INSTALL FAILED: ' + $_.Exception.Message)
  Write-Error $_
  exit 1
} finally {
  AssertInside $work $env:TEMP
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
