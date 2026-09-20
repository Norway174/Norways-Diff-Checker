param(
  [ValidateSet('install','update','update-silent','uninstall','uninstall-keep','uninstall-delete')][string]$Mode = 'install',
  [Parameter(Mandatory)][string]$InstallerPath
)
$ErrorActionPreference = 'Stop'
$appHome = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'NorwaysDiffChecker'))
$program = [IO.Path]::GetFullPath((Join-Path $appHome 'program'))
$settings = [IO.Path]::GetFullPath((Join-Path $appHome 'settings'))
$work = [IO.Path]::GetFullPath((Join-Path $env:TEMP ('NDC-install-' + [guid]::NewGuid().ToString('N'))))
$logPath = Join-Path $settings 'installer.log'
function Log([string]$message) {
  if (Test-Path -LiteralPath $settings) { Add-Content -LiteralPath $logPath -Value ((Get-Date -Format o) + ' ' + $message) }
  Write-Host $message
}
function AssertInside([string]$candidate,[string]$parent) {
  $full = [IO.Path]::GetFullPath($candidate)
  $base = [IO.Path]::GetFullPath($parent).TrimEnd('\') + '\'
  if (!$full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path: $full" }
}
function AppRunning {
  @(Get-CimInstance Win32_Process -Filter "name = 'Norways Diff Checker.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($program + '\',[StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
}
function RegisterApp {
  $exe = Join-Path $program 'Norways Diff Checker.exe'
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Norways Diff Checker.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Norways Diff Checker.lnk'))) {
    $item = $shell.CreateShortcut($shortcut)
    $item.TargetPath = $exe
    $item.WorkingDirectory = $program
    $item.IconLocation = $exe
    $item.Save()
  }
  $registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker'
  New-Item -Path $registry -Force | Out-Null
  New-ItemProperty -Path $registry -Name DisplayName -Value 'Norways Diff Checker' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registry -Name DisplayVersion -Value '0.1.0' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registry -Name InstallLocation -Value $program -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registry -Name DisplayIcon -Value $exe -PropertyType String -Force | Out-Null
  $commandShell = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
  $uninstall = '"' + $commandShell + '" /d /s /c ""' + (Join-Path $appHome 'NorwaysDiffCheckerInstaller.bat') + '" -uninstall"'
  New-ItemProperty -Path $registry -Name UninstallString -Value $uninstall -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $registry -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
}
function UnregisterApp {
  foreach ($shortcut in @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Norways Diff Checker.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Norways Diff Checker.lnk'))) {
    Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\NorwaysDiffChecker' -Recurse -Force -ErrorAction SilentlyContinue
}
try {
  if ($Mode.StartsWith('uninstall')) {
    if (AppRunning) { throw 'Close Norways Diff Checker before uninstalling.' }
    $deleteData = $Mode -eq 'uninstall-delete'
    if ($Mode -eq 'uninstall') {
      $answer = Read-Host 'Delete settings and locally saved comparisons? [y/N]'
      $deleteData = $answer -match '^(y|yes)$'
    }
    AssertInside $program $appHome
    if (Test-Path -LiteralPath $program) { Remove-Item -LiteralPath $program -Recurse -Force }
    UnregisterApp
    Log 'Program and shortcuts removed.'
    if ($deleteData) {
      AssertInside $settings $appHome
      if (Test-Path -LiteralPath $settings) { Remove-Item -LiteralPath $settings -Recurse -Force }
      Write-Host 'Settings and saved comparisons removed.'
    } else { Log 'Settings and saved comparisons retained.' }
    exit 0
  }
  New-Item -ItemType Directory -Force -Path $work,$settings | Out-Null
  $source = 'D:\NodeJS\Norways Diff Checker'
  $repo = $null
  if (Test-Path -LiteralPath (Join-Path $source '.git')) {
    if ((& git -C $source remote) -contains 'origin') {
      $remote = & git -C $source remote get-url origin
      if ($LASTEXITCODE -eq 0 -and $remote -match 'github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$') { $repo = $Matches[1] }
    }
  }
  if (!$repo) {
    $markerPath = Join-Path $settings 'installed.json'
    if (Test-Path -LiteralPath $markerPath) {
      $previous = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
      if ($previous.source -eq 'github') { $repo = [string]$previous.githubRepo }
    }
  }
  $config = @{ localPath=$source; githubRepo=$repo; branch='main' }
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
  $npm = $null
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($systemNode -and $systemNpm -and (& $systemNode.Source -v) -eq $nodeVersion) {
    $npm = $systemNpm.Source
    Log "Using installed Node $nodeVersion for the build"
  } else {
    if ($Mode -ne 'update-silent') {
      $answer = Read-Host "Node $nodeVersion is needed to build this update. Download a temporary copy? [Y/n]"
      if ($answer -match '^(n|no)$') { throw 'The build needs Node. No program files were changed.' }
    }
    Log "Downloading temporary Node $nodeVersion build runtime"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVersion/$nodeZipName" -OutFile $nodeZip
    $actualSha = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -ne $expectedSha) { throw 'Node runtime hash mismatch.' }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath (Join-Path $work 'node')
    $nodeDir = Join-Path $work "node\node-$nodeVersion-win-x64"
    $env:PATH = $nodeDir + ';' + $env:PATH
    $npm = Join-Path $nodeDir 'npm.cmd'
  }
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
  $asar = Join-Path $built 'resources\app.asar'
  if (!(Test-Path -LiteralPath $asar) -or (Get-Item -LiteralPath $asar).Length -lt 1000000) { throw 'Packaged application archive is missing or incomplete.' }
  $native = Join-Path $built 'resources\app.asar.unpacked\node_modules'
  if (!(Get-ChildItem -LiteralPath (Join-Path $native '@img\sharp-win32-x64\lib') -Filter '*.node' -ErrorAction SilentlyContinue)) { throw 'Sharp native engine is missing.' }
  if (!(Get-ChildItem -LiteralPath (Join-Path $native '@napi-rs\canvas-win32-x64-msvc') -Filter '*.node' -ErrorAction SilentlyContinue)) { throw 'Canvas native engine is missing.' }
  $officeEngine = Join-Path $built 'resources\libreoffice\program\soffice.exe'
  if (!(Test-Path -LiteralPath $officeEngine) -or (Get-Item -LiteralPath $officeEngine).Length -lt 100000) { throw 'Bundled LibreOffice engine is missing.' }
  $staged = Join-Path $work 'program-new'
  Copy-Item -LiteralPath $built -Destination $staged -Recurse
  Log 'Verifying staged program and engine files'
  $builtPrefix = [IO.Path]::GetFullPath($built).TrimEnd('\') + '\'
  foreach ($file in Get-ChildItem -LiteralPath $built -File -Recurse) {
    $relative = $file.FullName.Substring($builtPrefix.Length)
    $copy = Join-Path $staged $relative
    if (!(Test-Path -LiteralPath $copy) -or (Get-Item -LiteralPath $copy).Length -ne $file.Length) { throw "Staged file is missing or incomplete: $relative" }
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash) {
      throw "Staged file hash differs: $relative"
    }
  }
  if (AppRunning) {
    Log 'Waiting for the application to close'
    for ($i=0; $i -lt 60 -and (AppRunning); $i++) {
      Start-Sleep -Seconds 1
    }
    if (AppRunning) { throw 'Please close Norways Diff Checker before updating.' }
  }
  AssertInside $program $appHome
  $backup = Join-Path $work 'program-old'
  $markerPath = Join-Path $settings 'installed.json'
  $oldMarker = if (Test-Path -LiteralPath $markerPath) { Get-Content -LiteralPath $markerPath -Raw } else { $null }
  $installedInstaller = Join-Path $appHome 'NorwaysDiffCheckerInstaller.bat'
  $installedEngine = Join-Path $appHome 'engine.ps1'
  if (Test-Path -LiteralPath $installedInstaller) { Copy-Item -LiteralPath $installedInstaller -Destination (Join-Path $work 'installer-old.bat') }
  if (Test-Path -LiteralPath $installedEngine) { Copy-Item -LiteralPath $installedEngine -Destination (Join-Path $work 'engine-old.ps1') }
  if (Test-Path -LiteralPath $program) { Move-Item -LiteralPath $program -Destination $backup }
  try {
    Move-Item -LiteralPath $staged -Destination $program
    $sourceName = 'local'
    if ($config.githubRepo) { $sourceName = 'github' }
    $marker = @{ sha=$sha; source=$sourceName; githubRepo=$config.githubRepo; branch=$config.branch; installedAt=(Get-Date -Format o) }
    $marker | ConvertTo-Json | Set-Content -LiteralPath $markerPath
    $sourceInstaller = Join-Path $sourceRoot 'installer\NorwaysDiffCheckerInstaller.bat'
    $sourceEngine = Join-Path $sourceRoot 'installer\engine.ps1'
    if (!(Test-Path -LiteralPath $sourceInstaller) -or !(Test-Path -LiteralPath $sourceEngine)) { throw 'Installer scripts are missing from the committed source.' }
    if ([IO.Path]::GetFullPath($InstallerPath) -ne [IO.Path]::GetFullPath($installedInstaller)) {
      Copy-Item -LiteralPath $sourceInstaller -Destination $installedInstaller -Force
      Copy-Item -LiteralPath $sourceEngine -Destination $installedEngine -Force
    }
    RegisterApp
    Log "Installed commit $sha"
  } catch {
    if (Test-Path -LiteralPath $program) { AssertInside $program $appHome; Remove-Item -LiteralPath $program -Recurse -Force }
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $program }
    else { UnregisterApp }
    if ($oldMarker) { Set-Content -LiteralPath $markerPath -Value $oldMarker } else { Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath (Join-Path $work 'installer-old.bat')) { Copy-Item -LiteralPath (Join-Path $work 'installer-old.bat') -Destination $installedInstaller -Force } else { Remove-Item -LiteralPath $installedInstaller -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath (Join-Path $work 'engine-old.ps1')) { Copy-Item -LiteralPath (Join-Path $work 'engine-old.ps1') -Destination $installedEngine -Force } else { Remove-Item -LiteralPath $installedEngine -Force -ErrorAction SilentlyContinue }
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
