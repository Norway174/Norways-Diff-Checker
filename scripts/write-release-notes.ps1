param(
    [Parameter(Mandatory)][string]$Repository,
    [Parameter(Mandatory)][string]$HeadCommit,
    [string]$PreviousTag,
    [Parameter(Mandatory)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'

if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $HeadCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'Invalid repository or commit.'
}

$range = $HeadCommit
if ($PreviousTag) {
    if ($PreviousTag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid previous release tag.' }
    git check-ref-format "refs/tags/$PreviousTag" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Invalid previous release tag.' }
    git rev-parse --verify "$PreviousTag^{commit}" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Previous release tag is missing from the checkout.' }
    git merge-base --is-ancestor $PreviousTag $HeadCommit
    if ($LASTEXITCODE -ne 0) { throw 'Previous release is not an ancestor of this build.' }
    $range = "$PreviousTag..$HeadCommit"
}

$commits = @(git log --reverse --format=%H $range)
if ($LASTEXITCODE -ne 0 -or $commits.Count -eq 0) { throw 'No commits found for release notes.' }

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('Download **Installer.exe** to install, update, repair, or uninstall the app. The installer includes the app and works offline. **Portable.zip** contains the standalone app.')
$lines.Add('')
$lines.Add('### Commits')
$lines.Add('')
foreach ($sha in $commits) {
    if ($sha -notmatch '^[0-9a-f]{40}$') { throw 'Invalid commit in release history.' }
    $author = (git show -s --format=%an $sha | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not read author for $sha" }
    $message = (git show -s --format=%B $sha | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not read message for $sha" }
    $parts = @($message -split '\r?\n')
    $subject = [System.Net.WebUtility]::HtmlEncode($parts[0])
    $author = [System.Net.WebUtility]::HtmlEncode($author)
    $short = $sha.Substring(0, 8)
    $lines.Add(('- [`{0}`](https://github.com/{1}/commit/{2}) — {3} — {4}' -f $short, $Repository, $sha, $subject, $author))
    if ($parts.Count -gt 1 -and ($parts[1..($parts.Count - 1)] -join '').Trim()) {
        $lines.Add('')
        foreach ($part in $parts[1..($parts.Count - 1)]) {
            $lines.Add('  > ' + [System.Net.WebUtility]::HtmlEncode($part))
        }
    }
}

[IO.File]::WriteAllText($OutputPath, ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
