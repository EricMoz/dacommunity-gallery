# Creates EricMoz/dacommunity-gallery on GitHub and pushes (requires GitHub CLI + auth).
param(
    [string]$RepoName = "dacommunity-gallery"
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
    Write-Host "GitHub CLI (gh) not installed."
    Write-Host "Install: winget install GitHub.cli"
    Write-Host "Then run: gh auth login"
    Write-Host "Then re-run this script."
    exit 1
}

gh auth status 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "Run: gh auth login"
    exit 1
}

gh repo create $RepoName --public --source . --remote origin --push --description "daCAT daCommunity NFT gallery on Base"
if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Done! Enable Pages: Settings -> Pages -> GitHub Actions"
    Write-Host "Add secret OPENSEA_API_KEY for auto-refresh"
    Write-Host "Site: https://ericmoz.github.io/$RepoName/"
}