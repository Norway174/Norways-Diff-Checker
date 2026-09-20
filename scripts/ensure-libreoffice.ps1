$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = Join-Path $root 'vendor\libreoffice-msi'
$soffice = Join-Path $target 'program\soffice.exe'
if (Test-Path -LiteralPath $soffice) { exit 0 }
$cache = Join-Path $root 'vendor-cache'
New-Item -ItemType Directory -Force -Path $cache,$target | Out-Null
$file = Join-Path $cache 'LibreOffice_26.2.6_Win_x86-64.msi'
$expected = 'f9877032fd908beb9c0ddf06df4af5c2e85f419c42e14876c4cce5aae5fb2660'
if (!(Test-Path -LiteralPath $file)) {
  Write-Host 'Downloading pinned LibreOffice 26.2.6 build asset'
  Invoke-WebRequest -Uri 'https://download.documentfoundation.org/libreoffice/stable/26.2.6/win/x86_64/LibreOffice_26.2.6_Win_x86-64.msi' -OutFile $file
}
$stream = [IO.File]::OpenRead($file)
try {
  $hasher = [Security.Cryptography.SHA256]::Create()
  $actual = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
} finally { $stream.Dispose() }
if ($actual -ne $expected) { throw 'LibreOffice download failed SHA-256 verification.' }
Write-Host 'Extracting LibreOffice into the private app asset directory'
$log = Join-Path $cache 'extract.log'
$arguments = '/a "' + $file + '" TARGETDIR="' + $target + '" /qn /norestart /l*v "' + $log + '"'
$process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -PassThru -Wait -WindowStyle Hidden
if ($process.ExitCode -ne 0 -or !(Test-Path -LiteralPath $soffice)) { throw "LibreOffice extraction failed (exit $($process.ExitCode)). See $log" }
Write-Host 'LibreOffice engine is ready'
