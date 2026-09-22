@echo off
setlocal
set "NDC_INSTALLER=%~f0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$lines = Get-Content -LiteralPath $env:NDC_INSTALLER; $marker = [Array]::IndexOf($lines, '# NDC_POWERSHELL'); if ($marker -lt 0) { throw 'Installer payload marker not found.' }; & ([ScriptBlock]::Create(($lines[($marker + 1)..($lines.Length - 1)] -join [Environment]::NewLine)))"
set "NDC_EXIT=%ERRORLEVEL%"
endlocal & exit /b %NDC_EXIT%
# NDC_POWERSHELL
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepositoryUrl = 'https://github.com/Norway174/Norways-Diff-Checker.git'
$Root = Join-Path $env:LOCALAPPDATA 'NorwaysDiffChecker'
$AppDir = Join-Path $Root 'app'
$ToolsDir = Join-Path $Root 'tools'
$InstallerPath = Join-Path $Root 'NorwaysDiffCheckerInstaller.exe'
$LegacyInstallerPath = Join-Path $Root 'NorwaysDiffCheckerInstaller.bat'
$LauncherPath = Join-Path $Root 'Norways Diff Checker.exe'
$RealExe = Join-Path $AppDir 'dist\win-unpacked\Norways Diff Checker.exe'
$StatePath = Join-Path $Root 'installer-state.json'
$StartMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Norways Diff Checker.lnk'
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Norways Diff Checker.lnk'
$script:MenuOptions = @()
$Host.UI.RawUI.WindowTitle = 'Norways Diff Checker Setup'

function Write-Rule([ConsoleColor]$Color = 'DarkCyan') {
    Write-Host ('-' * 68) -ForegroundColor $Color
}

function Write-Heading([string]$Title, [string]$Subtitle = '') {
    Clear-Host
    Write-Host
    Write-Host '  NORWAYS DIFF CHECKER' -ForegroundColor Cyan
    Write-Host '  Setup and Maintenance' -ForegroundColor DarkGray
    Write-Rule
    Write-Host "  $Title" -ForegroundColor White
    if ($Subtitle) { Write-Host "  $Subtitle" -ForegroundColor DarkGray }
    Write-Rule DarkGray
    Write-Host
}

function Pause-Installer {
    Write-Host
    Write-Rule DarkGray
    [void](Read-Host 'Press Enter to return to the main menu')
}

function Read-MenuChoice([string]$Prompt, [string[]]$Allowed) {
    $options = @($script:MenuOptions | Where-Object { $Allowed -contains $_.Key })
    $script:MenuOptions = @()
    if ($options.Count -eq 0) {
        $defaultLabels = @{ Y = 'Yes'; N = 'No'; R = 'Re-check'; C = 'Cancel'; X = 'Exit' }
        $options = @($Allowed | ForEach-Object {
            $title = if ($defaultLabels.ContainsKey($_)) { $defaultLabels[$_] } else { $_ }
            [pscustomobject]@{ Key = $_; Title = $title; Description = ''; Color = 'Cyan' }
        })
    }

    if ([Console]::IsInputRedirected) {
        foreach ($option in $options) {
            Write-Host "  [$($option.Key)] $($option.Title)"
            if ($option.Description) { Write-Host "      $($option.Description)" -ForegroundColor DarkGray }
        }
        Write-Host
        while ($true) {
            $choice = (Read-Host "  $Prompt").Trim().ToUpperInvariant()
            if ($Allowed -contains $choice) { return $choice }
            Write-Host "  Please choose: $($Allowed -join ', ')." -ForegroundColor Yellow
        }
    }

    $selected = 0
    $cancelIndex = -1
    for ($index = 0; $index -lt $options.Count; $index++) {
        if ($options[$index].Key -in @('C', 'X')) { $cancelIndex = $index; break }
    }
    $menuWidth = [Math]::Max(24, [Math]::Min(68, $Host.UI.RawUI.WindowSize.Width - 1))
    $menuTop = $Host.UI.RawUI.CursorPosition.Y

    function Format-MenuLine([string]$Text) {
        if ($Text.Length -gt $menuWidth) { return $Text.Substring(0, [Math]::Max(0, $menuWidth - 3)) + '...' }
        return $Text.PadRight($menuWidth)
    }

    function Get-DescriptionLines([string]$Text) {
        $lineWidth = [Math]::Max(12, $menuWidth - 7)
        if (-not $Text) { return @('', '') }
        $words = $Text -split '\s+'
        $lines = @('')
        foreach ($word in $words) {
            $candidate = if ($lines[-1]) { "$($lines[-1]) $word" } else { $word }
            if ($candidate.Length -le $lineWidth) {
                $lines[-1] = $candidate
            } elseif ($lines.Count -lt 2) {
                $lines += $word
            } else {
                $last = $lines[-1]
                if ($last.Length -gt $lineWidth - 3) { $last = $last.Substring(0, $lineWidth - 3) }
                $lines[-1] = $last.TrimEnd() + '...'
                break
            }
        }
        while ($lines.Count -lt 2) { $lines += '' }
        return @($lines[0], $lines[1])
    }

    while ($true) {
        $Host.UI.RawUI.CursorPosition = New-Object Management.Automation.Host.Coordinates 0, $menuTop
        for ($index = 0; $index -lt $options.Count; $index++) {
            $option = $options[$index]
            $descriptionLines = Get-DescriptionLines $option.Description
            if ($index -eq $selected) {
                Write-Host (Format-MenuLine "  >  [$($option.Key)]  $($option.Title)") -ForegroundColor Black -BackgroundColor Cyan
                if ($descriptionLines[0]) { Write-Host (Format-MenuLine "       $($descriptionLines[0])") -ForegroundColor Cyan }
                if ($descriptionLines[1]) { Write-Host (Format-MenuLine "       $($descriptionLines[1])") -ForegroundColor Cyan }
            } else {
                Write-Host (Format-MenuLine "     [$($option.Key)]  $($option.Title)") -ForegroundColor $option.Color
                if ($descriptionLines[0]) { Write-Host (Format-MenuLine "       $($descriptionLines[0])") -ForegroundColor DarkGray }
                if ($descriptionLines[1]) { Write-Host (Format-MenuLine "       $($descriptionLines[1])") -ForegroundColor DarkGray }
            }
            Write-Host (Format-MenuLine '')
        }
        Write-Host (Format-MenuLine '  Up/Down: move   Enter: select   Esc: back') -ForegroundColor DarkGray

        $key = [Console]::ReadKey($true)
        switch ($key.Key) {
            { $_ -in @([ConsoleKey]::UpArrow, [ConsoleKey]::LeftArrow) } {
                $selected = ($selected - 1 + $options.Count) % $options.Count
                continue
            }
            { $_ -in @([ConsoleKey]::DownArrow, [ConsoleKey]::RightArrow, [ConsoleKey]::Tab) } {
                $selected = ($selected + 1) % $options.Count
                continue
            }
            'Home' { $selected = 0; continue }
            'End' { $selected = $options.Count - 1; continue }
            'Enter' { Write-Host; return $options[$selected].Key }
            'Escape' {
                if ($cancelIndex -ge 0) { Write-Host; return $options[$cancelIndex].Key }
                continue
            }
        }

        $shortcut = $key.KeyChar.ToString().ToUpperInvariant()
        $shortcutOption = $options | Where-Object { $_.Key -eq $shortcut } | Select-Object -First 1
        if ($shortcutOption) { Write-Host; return $shortcutOption.Key }
    }
}

function Read-TypedChoice([string]$Prompt, [string[]]$Allowed) {
    while ($true) {
        Write-Host
        $choice = (Read-Host "  $Prompt").Trim().ToUpperInvariant()
        if ($Allowed -contains $choice) { return $choice }
        Write-Host "  Please type: $($Allowed -join ' or ')." -ForegroundColor Yellow
    }
}

function Write-MenuOption([string]$Key, [string]$Title, [string]$Description, [ConsoleColor]$Color = 'Cyan') {
    $script:MenuOptions += [pscustomobject]@{
        Key = $Key
        Title = $Title
        Description = $Description
        Color = $Color
    }
}

function Write-Step([int]$Current, [int]$Total, [string]$Title) {
    Write-Host
    Write-Host "  [$Current/$Total] " -NoNewline -ForegroundColor Cyan
    Write-Host $Title -ForegroundColor White
}

function Write-Success([string]$Message) {
    Write-Host
    Write-Rule DarkGreen
    Write-Host "  SUCCESS  $Message" -ForegroundColor Green
    Write-Rule DarkGreen
}

function Get-InstallSummary {
    $hasCheckout = Test-Path -LiteralPath (Join-Path $AppDir '.git')
    $hasPackage = Test-Path -LiteralPath $RealExe
    $state = $null
    if (Test-Path -LiteralPath $StatePath) {
        try { $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json } catch { $state = $null }
    }
    $status = if ($hasCheckout -and $hasPackage) { 'Installed' } elseif ($hasCheckout -or $hasPackage) { 'Needs repair' } else { 'Not installed' }
    [pscustomobject]@{ Installed = ($hasCheckout -or $hasPackage); Status = $status; State = $state }
}

function Write-InstallSummary($Summary) {
    $statusColor = if ($Summary.Status -eq 'Installed') { 'Green' } elseif ($Summary.Status -eq 'Needs repair') { 'Yellow' } else { 'DarkGray' }
    Write-Host '  STATUS' -ForegroundColor DarkGray
    Write-Host '  Installation  ' -NoNewline -ForegroundColor DarkGray
    Write-Host $Summary.Status -ForegroundColor $statusColor
    Write-Host "  Location      $Root" -ForegroundColor DarkGray
    if ($Summary.State -and $Summary.State.commit) {
        $shortCommit = [string]$Summary.State.commit
        if ($shortCommit.Length -gt 10) { $shortCommit = $shortCommit.Substring(0, 10) }
        Write-Host "  Commit        $shortCommit" -ForegroundColor DarkGray
        if ($Summary.State.builtAt) {
            try {
                $built = ([DateTime]::Parse([string]$Summary.State.builtAt)).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
                Write-Host "  Last build    $built" -ForegroundColor DarkGray
            } catch { }
        }
    }
    Write-Host
    Write-Rule DarkGray
    Write-Host
}

function Invoke-External([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $null) {
    Write-Host "      > $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
    $previous = Get-Location
    try {
        if ($WorkingDirectory) { Set-Location -LiteralPath $WorkingDirectory }
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $FilePath" }
    } finally {
        Set-Location $previous
    }
}

function Get-ToolPaths {
    $portableGit = Join-Path $ToolsDir 'git\cmd\git.exe'
    $portableNode = Join-Path $ToolsDir 'node\node.exe'
    $git = if (Test-Path -LiteralPath $portableGit) { $portableGit } else { (Get-Command git.exe -ErrorAction SilentlyContinue).Source }
    $node = if (Test-Path -LiteralPath $portableNode) { $portableNode } else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
    $npm = $null
    if ($node) {
        $nodeDir = Split-Path -Parent $node
        $portableNpm = Join-Path $nodeDir 'npm.cmd'
        $npm = if (Test-Path -LiteralPath $portableNpm) { $portableNpm } else { (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }
    }
    [pscustomobject]@{ Git = $git; Node = $node; Npm = $npm }
}

function Get-MissingTools {
    $tools = Get-ToolPaths
    $missing = @()
    if (-not $tools.Git) { $missing += 'Git' }
    if (-not $tools.Node) { $missing += 'Node.js' }
    if (-not $tools.Npm) { $missing += 'npm' }
    [pscustomobject]@{ Tools = $tools; Missing = $missing }
}

function Invoke-VerifiedDownload([string]$Url, [string]$Destination, [string]$ExpectedHash) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
    $actualHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $ExpectedHash.ToLowerInvariant()) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        throw "SHA-256 verification failed for $Url"
    }
}

function Install-PortableTools {
    Write-Heading 'Portable tools' 'Git and Node.js will stay inside the app data folder.'
    $stage = Join-Path $env:TEMP ("NorwaysDiffChecker-tools-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        $gitRelease = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'Norways-Diff-Checker-Installer' }
        $gitAsset = $gitRelease.assets | Where-Object { $_.name -match '^MinGit-.*-64-bit\.zip$' } | Select-Object -First 1
        if (-not $gitAsset -or -not $gitAsset.digest -or $gitAsset.digest -notmatch '^sha256:') { throw 'Unable to resolve a verified 64-bit MinGit download.' }
        $gitZip = Join-Path $stage 'git.zip'
        Write-Step 1 4 "Download $($gitAsset.name)"
        Invoke-VerifiedDownload $gitAsset.browser_download_url $gitZip ($gitAsset.digest.Substring(7))

        $nodeIndex = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
        $nodeRelease = $nodeIndex | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
        if (-not $nodeRelease) { throw 'Unable to resolve the current Node.js LTS Windows ZIP.' }
        $nodeVersion = $nodeRelease.version
        $nodeFile = "node-$nodeVersion-win-x64.zip"
        $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt").Content -split "`n"
        $checksumLine = $checksums | Where-Object { $_ -match "\s+$([Regex]::Escape($nodeFile))\s*$" } | Select-Object -First 1
        if (-not $checksumLine) { throw 'Unable to resolve the Node.js ZIP checksum.' }
        $nodeHash = ($checksumLine -split '\s+')[0]
        $nodeZip = Join-Path $stage 'node.zip'
        Write-Step 2 4 "Download $nodeFile"
        Invoke-VerifiedDownload "https://nodejs.org/dist/$nodeVersion/$nodeFile" $nodeZip $nodeHash

        Write-Step 3 4 'Extract portable tools'
        Remove-Item -LiteralPath (Join-Path $ToolsDir 'git') -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $ToolsDir 'node') -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path (Join-Path $ToolsDir 'git'), (Join-Path $ToolsDir 'node') -Force | Out-Null
        Expand-Archive -LiteralPath $gitZip -DestinationPath (Join-Path $ToolsDir 'git') -Force
        Expand-Archive -LiteralPath $nodeZip -DestinationPath $stage -Force
        $nodeExtracted = Get-ChildItem -LiteralPath $stage -Directory | Where-Object { $_.Name -like 'node-*-win-x64' } | Select-Object -First 1
        if (-not $nodeExtracted) { throw 'The Node.js archive had an unexpected layout.' }
        Copy-Item -Path (Join-Path $nodeExtracted.FullName '*') -Destination (Join-Path $ToolsDir 'node') -Recurse -Force
        Write-Step 4 4 'Verify portable tools'
        $installedTools = Get-ToolPaths
        if (-not $installedTools.Git -or -not $installedTools.Node -or -not $installedTools.Npm) { throw 'Portable tools were extracted but could not be started.' }
        Write-Success 'Portable Git and Node.js are ready.'
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-Prerequisites {
    while ($true) {
        $result = Get-MissingTools
        if ($result.Missing.Count -eq 0) { return $result.Tools }
        Write-Heading 'Required tools are missing' 'Install them normally, or use private portable copies.'
        Write-Host '  MISSING' -ForegroundColor Yellow
        $result.Missing | ForEach-Object { Write-Host "    - $_" -ForegroundColor White }
        Write-Host
        Write-Host '  Official downloads' -ForegroundColor DarkGray
        Write-Host '  Git for Windows  https://git-scm.com/download/win'
        Write-Host '  Node.js LTS      https://nodejs.org/en/download'
        Write-Host
        Write-MenuOption 'R' 'Re-check' 'Look for Git, Node.js, and npm again.'
        Write-MenuOption 'P' 'Use portable tools' 'Download verified private copies without changing PATH.'
        Write-MenuOption 'C' 'Cancel' 'Return to the main menu.' DarkGray
        switch (Read-MenuChoice 'Select an option' @('R', 'P', 'C')) {
            'R' { continue }
            'P' { Install-PortableTools; continue }
            'C' { return $null }
        }
    }
}

function Test-AppRunning {
    if (-not (Test-Path -LiteralPath $AppDir)) { return $false }
    $prefix = [IO.Path]::GetFullPath($AppDir).TrimEnd('\') + '\'
    $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    return [bool]$running
}

function Wait-ForAppExit {
    while (Test-AppRunning) {
        Write-Host
        Write-Host '  The app is currently running.' -ForegroundColor Yellow
        Write-Host '  Close every Norways Diff Checker window before continuing.' -ForegroundColor DarkGray
        Write-MenuOption 'R' 'Re-check' 'Continue after closing the app.'
        Write-MenuOption 'C' 'Cancel' 'Return without making changes.' DarkGray
        $choice = Read-MenuChoice 'Select an option' @('R', 'C')
        if ($choice -eq 'C') { return $false }
    }
    return $true
}

function Get-GitStatus([string]$Git) {
    $status = & $Git -C $AppDir status --porcelain=v1 --untracked-files=all
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read the checkout status.' }
    return @($status)
}

function Update-Checkout([string]$Git) {
    Invoke-External $Git @('-C', $AppDir, 'fetch', '--prune', 'origin', 'main')
    $status = Get-GitStatus $Git
    $head = (& $Git -C $AppDir rev-parse HEAD).Trim()
    $remote = (& $Git -C $AppDir rev-parse origin/main).Trim()
    $base = (& $Git -C $AppDir merge-base HEAD origin/main).Trim()
    $dirty = $status.Count -gt 0
    $diverged = $base -ne $head

    if ($dirty -or $diverged) {
        Write-Heading 'Local changes detected' 'Choose how the updater should handle this checkout.'
        if ($dirty) {
            Write-Host '  Modified or untracked files:' -ForegroundColor Yellow
            $status | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
            if ($status.Count -gt 20) { Write-Host "    ...and $($status.Count - 20) more" }
        }
        if ($diverged) { Write-Host '  The checkout also contains local commits or has diverged from origin/main.' -ForegroundColor Yellow }
        Write-Host
        Write-MenuOption 'P' 'Pull normally' 'Ask Git to merge the latest main branch.'
        Write-MenuOption 'R' 'Reset to main' 'Discard tracked changes and local commits.' Yellow
        Write-MenuOption 'C' 'Cancel' 'Leave the checkout untouched.' DarkGray
        switch (Read-MenuChoice 'Select an option' @('P', 'R', 'C')) {
            'P' { Invoke-External $Git @('-C', $AppDir, 'pull', '--no-rebase', 'origin', 'main') }
            'R' {
                if ((Read-TypedChoice 'This discards tracked changes and local commits. Type RESET to continue or C to cancel' @('RESET', 'C')) -eq 'C') { return $false }
                Invoke-External $Git @('-C', $AppDir, 'reset', '--hard', 'origin/main')
            }
            'C' { return $false }
        }
    } elseif ($head -ne $remote) {
        Invoke-External $Git @('-C', $AppDir, 'merge', '--ff-only', 'origin/main')
    } else {
        Write-Host 'The checkout is already at the latest main commit.' -ForegroundColor Green
    }
    return $true
}

function Invoke-Build($Tools) {
    $nodeDir = Split-Path -Parent $Tools.Node
    $gitCmdDir = Split-Path -Parent $Tools.Git
    $oldPath = $env:PATH
    $env:PATH = "$nodeDir;$gitCmdDir;$env:PATH"
    try {
        Write-Step 1 5 'Install locked dependencies'
        Invoke-External $Tools.Npm @('ci') $AppDir
        Write-Step 2 5 'Check source and types'
        Invoke-External $Tools.Npm @('run', 'check') $AppDir
        Write-Step 3 5 'Build and package the application'
        Invoke-External $Tools.Npm @('run', 'build:app') $AppDir
    } finally {
        $env:PATH = $oldPath
    }
}

function Assert-Package {
    $required = @(
        $RealExe,
        (Join-Path $AppDir 'dist\win-unpacked\resources\app.asar'),
        (Join-Path $AppDir 'dist\win-unpacked\resources\app.asar.unpacked\node_modules\@napi-rs\canvas-win32-x64-msvc\skia.win32-x64-msvc.node'),
        (Join-Path $AppDir 'dist\win-unpacked\resources\app.asar.unpacked\node_modules\@img\sharp-win32-x64\lib\sharp-win32-x64-0.35.4.node')
    )
    $missing = $required | Where-Object { -not (Test-Path -LiteralPath $_) }
    if ($missing) { throw "The packaged app is incomplete. Missing: $($missing -join ', ')" }
}

function New-Launcher {
    $source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static void Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string target = Path.Combine(root, "app", "dist", "win-unpacked", "Norways Diff Checker.exe");
        if (!File.Exists(target))
        {
            MessageBox.Show("The application package is missing. Run NorwaysDiffCheckerInstaller.exe and choose Repair.", "Norways Diff Checker", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        var start = new ProcessStartInfo(target)
        {
            WorkingDirectory = Path.GetDirectoryName(target),
            UseShellExecute = false,
            Arguments = string.Join(" ", args.Select(Quote))
        };
        Process.Start(start);
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.All(c => !char.IsWhiteSpace(c) && c != '"')) return value;
        return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }
}
'@
    Remove-Item -LiteralPath $LauncherPath -Force -ErrorAction SilentlyContinue
    Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies 'System.Windows.Forms.dll', 'System.Core.dll' -OutputAssembly $LauncherPath -OutputType WindowsApplication
    if (-not (Test-Path -LiteralPath $LauncherPath)) { throw 'Failed to create the stable launcher executable.' }
}

function New-Shortcut([string]$Path) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $LauncherPath
    $shortcut.WorkingDirectory = $Root
    $shortcut.IconLocation = "$RealExe,0"
    $shortcut.Description = 'Norways Diff Checker'
    $shortcut.Save()
}

function Install-Shortcuts([bool]$PromptUser) {
    $startMenu = $true
    $desktop = $false
    if ($PromptUser) {
        $startMenu = (Read-MenuChoice 'Create a Start Menu shortcut? [Y/N]' @('Y', 'N')) -eq 'Y'
        $desktop = (Read-MenuChoice 'Create a Desktop shortcut? [Y/N]' @('Y', 'N')) -eq 'Y'
    } else {
        $startMenu = Test-Path -LiteralPath $StartMenuShortcut
        $desktop = Test-Path -LiteralPath $DesktopShortcut
    }
    if ($startMenu) { New-Shortcut $StartMenuShortcut }
    if ($desktop) { New-Shortcut $DesktopShortcut }
}

function Save-State([string]$Git) {
    $commit = (& $Git -C $AppDir rev-parse HEAD).Trim()
    [pscustomobject]@{
        commit = $commit
        builtAt = [DateTime]::UtcNow.ToString('o')
        appDirectory = $AppDir
        executable = $RealExe
        portableTools = (Test-Path -LiteralPath $ToolsDir)
    } | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Schedule-InstallerRefresh {
    $source = Join-Path $AppDir 'installer\NorwaysDiffCheckerInstaller.exe'
    if (-not (Test-Path -LiteralPath $source)) { return }
    $current = [Environment]::GetEnvironmentVariable('NDC_INSTALLER')
    if ($current -and ([IO.Path]::GetFullPath($current) -eq [IO.Path]::GetFullPath($InstallerPath))) {
        $refresh = Join-Path $env:TEMP ("ndc-refresh-" + [Guid]::NewGuid().ToString('N') + '.cmd')
        @(
            '@echo off',
            'ping 127.0.0.1 -n 3 > nul',
            "copy /y `"$source`" `"$InstallerPath`" > nul",
            'del /q "%~f0"'
        ) | Set-Content -LiteralPath $refresh -Encoding ASCII
        Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', $refresh -WindowStyle Hidden
        return
    }
    Copy-Item -LiteralPath $source -Destination $InstallerPath -Force
}

function Complete-Build($Tools, [bool]$PromptShortcuts) {
    Invoke-Build $Tools
    Write-Step 4 5 'Verify packaged files'
    Assert-Package
    Write-Step 5 5 'Create launcher and shortcuts'
    New-Launcher
    Install-Shortcuts $PromptShortcuts
    Save-State $Tools.Git
    Schedule-InstallerRefresh
}

function Install-App {
    Write-Heading 'Install' 'This may take several minutes on the first run.'
    $tools = Ensure-Prerequisites
    if (-not $tools) { return }
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir '.git'))) {
        if (Test-Path -LiteralPath $AppDir) {
            $backup = "$AppDir.broken-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Move-Item -LiteralPath $AppDir -Destination $backup
            Write-Host "  Moved the incomplete checkout to:`n  $backup" -ForegroundColor Yellow
        }
        Write-Step 1 1 'Download the latest source from GitHub'
        Invoke-External $tools.Git @('clone', '--branch', 'main', '--single-branch', $RepositoryUrl, $AppDir)
    }
    $currentInstaller = [Environment]::GetEnvironmentVariable('NDC_INSTALLER')
    $currentDestination = if ([IO.Path]::GetExtension($currentInstaller) -eq '.exe') { $InstallerPath } else { $LegacyInstallerPath }
    Copy-Item -LiteralPath $currentInstaller -Destination $currentDestination -Force
    Complete-Build $tools $true
    Write-Success 'Norways Diff Checker is installed.'
    Write-Host "  Launcher  $LauncherPath" -ForegroundColor DarkGray
    Pause-Installer
}

function Update-App([bool]$RepairOnly) {
    Write-Heading $(if ($RepairOnly) { 'Repair' } else { 'Update' }) $(if ($RepairOnly) { 'Rebuild the current checkout and restore missing files.' } else { 'Fetch the latest main commit and rebuild the app.' })
    if (-not (Wait-ForAppExit)) { return }
    $tools = Ensure-Prerequisites
    if (-not $tools) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir '.git'))) {
        Write-Host '  The source checkout is missing or invalid.' -ForegroundColor Yellow
        Write-MenuOption 'R' 'Recreate checkout' 'Move the damaged folder aside and clone a clean copy.'
        Write-MenuOption 'C' 'Cancel' 'Return without making changes.' DarkGray
        if ((Read-MenuChoice 'Select an option' @('R', 'C')) -eq 'C') { return }
        if (Test-Path -LiteralPath $AppDir) {
            $backup = "$AppDir.broken-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
            Move-Item -LiteralPath $AppDir -Destination $backup
            Write-Host "  Moved the incomplete checkout to:`n  $backup" -ForegroundColor Yellow
        }
        Invoke-External $tools.Git @('clone', '--branch', 'main', '--single-branch', $RepositoryUrl, $AppDir)
    }
    if (-not $RepairOnly -and -not (Update-Checkout $tools.Git)) { return }
    Complete-Build $tools $false
    Write-Success $(if ($RepairOnly) { 'Repair completed.' } else { 'Update completed.' })
    Pause-Installer
}

function Remove-ExplorerKeys {
    $keys = @(
        'HKCU:\Software\Classes\*\shell\NorwaysDiffChecker',
        'HKCU:\Software\Classes\Directory\shell\NorwaysDiffChecker'
    )
    foreach ($key in $keys) {
        $commandKey = Join-Path $key 'command'
        $command = (Get-Item -LiteralPath $commandKey -ErrorAction SilentlyContinue).GetValue('')
        if ($command -and $command.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Uninstall-App {
    Write-Heading 'Uninstall' 'Choose whether your preferences and projects should be preserved.'
    if (-not (Wait-ForAppExit)) { return }
    Write-MenuOption 'K' 'Keep personal data' 'Remove the app, source, tools, and shortcuts. Keep preferences and projects.'
    Write-MenuOption 'D' 'Delete everything' 'Permanently remove the entire NorwaysDiffChecker data folder.' Red
    Write-MenuOption 'C' 'Cancel' 'Return without removing anything.' DarkGray
    $choice = Read-MenuChoice 'Select an option' @('K', 'D', 'C')
    if ($choice -eq 'C') { return }
    if ($choice -eq 'D' -and (Read-TypedChoice 'Type DELETE to permanently remove all app data, or C to cancel' @('DELETE', 'C')) -eq 'C') { return }

    Remove-ExplorerKeys
    Remove-Item -LiteralPath $StartMenuShortcut, $DesktopShortcut, $LauncherPath, $StatePath, $LegacyInstallerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $AppDir, $ToolsDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $Root 'cache') -Recurse -Force -ErrorAction SilentlyContinue
    if ($choice -eq 'D') {
        $cleanup = Join-Path $env:TEMP ("ndc-uninstall-" + [Guid]::NewGuid().ToString('N') + '.cmd')
        @("@echo off", "ping 127.0.0.1 -n 3 > nul", "rmdir /s /q `"$Root`"", "del /q `"%~f0`"") | Set-Content -LiteralPath $cleanup -Encoding ASCII
    } else {
        $cleanup = Join-Path $env:TEMP ("ndc-uninstall-" + [Guid]::NewGuid().ToString('N') + '.cmd')
        @("@echo off", "ping 127.0.0.1 -n 3 > nul", "del /q `"$InstallerPath`"", "del /q `"%~f0`"") | Set-Content -LiteralPath $cleanup -Encoding ASCII
    }
    Start-Process -FilePath $env:ComSpec -ArgumentList '/d', '/c', $cleanup -WindowStyle Hidden
    Write-Success 'Uninstall scheduled. This window will close.'
    exit 0
}

function Show-MainMenu {
    while ($true) {
        $summary = Get-InstallSummary
        Write-Heading 'Main menu' 'Install and maintain the local Windows application.'
        Write-InstallSummary $summary
        if (-not $summary.Installed) {
            Write-MenuOption 'I' 'Install' 'Download the source, build the app, and create a launcher.'
            Write-MenuOption 'X' 'Exit' 'Close setup without making changes.' DarkGray
            $choice = Read-MenuChoice 'Select an option' @('I', 'X')
            if ($choice -eq 'I') { Install-App } else { return }
        } else {
            Write-MenuOption 'U' 'Update' 'Fetch the latest main commit and rebuild the application.'
            Write-MenuOption 'R' 'Repair' 'Reinstall dependencies and rebuild the current checkout.'
            Write-MenuOption 'N' 'Uninstall' 'Remove the application, with an option to preserve personal data.' Yellow
            Write-MenuOption 'X' 'Exit' 'Close setup without making changes.' DarkGray
            switch (Read-MenuChoice 'Select an option' @('U', 'R', 'N', 'X')) {
                'U' { Update-App $false }
                'R' { Update-App $true }
                'N' { Uninstall-App }
                'X' { return }
            }
        }
    }
}

try {
    Show-MainMenu
} catch {
    Write-Heading 'Something went wrong' 'No further changes will be made.'
    Write-Host '  ERROR' -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor White
    Write-Host
    Write-Host '  Technical details' -ForegroundColor DarkGray
    Write-Host "  $($_.ScriptStackTrace -replace "`n", "`n  ")" -ForegroundColor DarkGray
    Pause-Installer
    exit 1
}