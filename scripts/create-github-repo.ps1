# Creates EricMoz/dacommunity-gallery on GitHub and pushes (requires GitHub CLI + auth).
param(
    [string]$RepoName = "dacommunity-gallery"
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$ghExe = "${env:ProgramFiles}\GitHub CLI\gh.exe"
if (-not (Test-Path $ghExe)) {
    $ghExe = "gh"
}

if (-not (Get-Command $ghExe -ErrorAction SilentlyContinue) -and -not (Test-Path $ghExe)) {
    Write-Host "GitHub CLI not found. Run: winget install GitHub.cli"
    exit 1
}

& $ghExe auth status 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Not logged in. Run this first, then re-run this script:"
    Write-Host "  gh auth login"
    exit 1
}

Write-Host "Creating repo and pushing..."
& $ghExe repo create $RepoName --public --source . --remote origin --push --description "daCAT daCommunity NFT gallery on Base"
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS"
    Write-Host "1. Open https://github.com/EricMoz/$RepoName"
    Write-Host "2. Settings -> Pages -> Source: GitHub Actions"
    Write-Host "3. Actions tab -> wait for green Deploy workflow"
    Write-Host "4. Site: https://ericmoz.github.io/$RepoName/"
} else {
    Write-Host "Failed. If repo already exists, try:"
    Write-Host "  git remote add origin https://github.com/EricMoz/$RepoName.git"
    Write-Host "  git push -u origin main"
}