param(
    [Parameter(Mandatory)][string]$InstallDir,
    [Parameter(Mandatory)][string]$SourceDir,
    [Parameter(Mandatory)][string]$ExpectedCommit,
    [Parameter(Mandatory)][string]$SelfInstaller
)
$ErrorActionPreference = 'Stop'
if ($ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'The installer contains invalid build metadata.'
}
$source = [IO.Path]::GetFullPath($SourceDir)
    $sourceExe = Join-Path $source 'norways-diff-checker.exe'
    if (!(Test-Path -LiteralPath $sourceExe -PathType Leaf)) { throw 'The portable package has no application executable.' }
    $destination = [IO.Path]::GetFullPath($InstallDir)
    if ([IO.Path]::GetPathRoot($destination).TrimEnd('\') -eq $destination.TrimEnd('\')) { throw 'The install folder cannot be a drive root.' }
    $installedExe = Join-Path $destination 'norways-diff-checker.exe'
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $running = @(Get-Process -Name 'norways-diff-checker' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedExe })
        if ($running.Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }
    if (@(Get-Process -Name 'norways-diff-checker' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedExe }).Count -gt 0) {
        throw 'Close Norways Diff Checker and run the installer again.'
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $backupExe = Join-Path $destination 'norways-diff-checker.exe.previous'
    if (Test-Path -LiteralPath $backupExe) { Remove-Item -LiteralPath $backupExe -Force }
    if (Test-Path -LiteralPath $installedExe) { Move-Item -LiteralPath $installedExe -Destination $backupExe }
    try {
        Copy-Item -LiteralPath $sourceExe -Destination $installedExe -Force
        $licenses = Join-Path $source 'licenses'
        if (Test-Path -LiteralPath $licenses) {
            $installedLicenses = Join-Path $destination 'licenses'
            New-Item -ItemType Directory -Path $installedLicenses -Force | Out-Null
            Get-ChildItem -LiteralPath $licenses -File | Copy-Item -Destination $installedLicenses -Force
        }
        $installedInstaller = Join-Path $destination 'Installer.exe'
        if (![string]::Equals([IO.Path]::GetFullPath($SelfInstaller), [IO.Path]::GetFullPath($installedInstaller), [StringComparison]::OrdinalIgnoreCase)) {
            Copy-Item -LiteralPath $SelfInstaller -Destination $installedInstaller -Force
        }
        Remove-Item -LiteralPath (Join-Path $destination 'portable.flag') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backupExe -Force -ErrorAction SilentlyContinue
    } catch {
        Remove-Item -LiteralPath $installedExe -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $backupExe) { Move-Item -LiteralPath $backupExe -Destination $installedExe }
        throw
    }
    Write-Output "Installed build $ExpectedCommit"
