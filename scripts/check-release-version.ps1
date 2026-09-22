param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'

if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository.' }
$package = Get-Content 'package.json' -Raw | ConvertFrom-Json
$version = $package.version
if ($version -isnot [string] -or [string]::IsNullOrEmpty($version)) { throw 'package.json must have a nonempty string version.' }

# Keep ordinary version tags readable. Encode any other string without losing its exact value.
$candidate = "v$version"
$tag = ''
if ($version -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$') {
    git check-ref-format "refs/tags/$candidate" 2>$null
    if ($LASTEXITCODE -eq 0) { $tag = $candidate }
}
if (!$tag) {
    $tag = 'x-' + [Convert]::ToHexString([Text.Encoding]::UTF8.GetBytes($version)).ToLowerInvariant()
}

$headers = @{
    'Accept' = 'application/vnd.github+json'
    'User-Agent' = 'NorwaysDiffCheckerReleaseWorkflow'
    'X-GitHub-Api-Version' = '2022-11-28'
}
if ($env:GH_TOKEN) { $headers['Authorization'] = "Bearer $env:GH_TOKEN" }
$base = "https://api.github.com/repos/$Repository/releases"
$alreadyReleased = $false
$page = 1
do {
    $batch = @(Invoke-RestMethod -Uri "$base`?per_page=100&page=$page" -Headers $headers)
    foreach ($release in $batch) {
        $releaseTag = [string]$release.tag_name
        if ($releaseTag -ceq $tag -or [string]$release.name -ceq $version) {
            $alreadyReleased = $true
            break
        }
        # Releases made before version-based tags used a commit SHA as their tag.
        if ($releaseTag -cmatch '^commit-[0-9a-f]{40}$') {
            $spec = '{0}:package.json' -f $releaseTag
            $legacyPackage = git show $spec | Out-String | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0) { throw "Cannot read package.json for release $releaseTag" }
            if ([string]$legacyPackage.version -ceq $version) {
                $alreadyReleased = $true
                break
            }
        }
    }
    $page++
} while (!$alreadyReleased -and $batch.Count -eq 100)

$previousTag = ''
if (!$alreadyReleased) {
    try {
        $latest = Invoke-RestMethod -Uri "$base/latest" -Headers $headers
        $previousTag = [string]$latest.tag_name
    } catch {
        if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }
    }
}

$publish = if ($alreadyReleased) { 'false' } else { 'true' }
$output = "publish=$publish`ntag=$tag`nprevious_tag=$previousTag`n"
[IO.File]::AppendAllText($OutputPath, $output, [Text.UTF8Encoding]::new($false))
Write-Host "package.json version '$version': publish=$publish, tag=$tag"
