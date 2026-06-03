# Refresh gallery JSON from OpenSea, then start local preview server.
param(
    [switch]$Quick,
    [int]$MaxItems = 0
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$backend = Join-Path $root "backend"

Set-Location $backend
pip install -q -r requirements.txt

$args = @("fetch_gallery_data.py")
if ($Quick) { $args += "--quick" }
if ($MaxItems -gt 0) { $args += "--max-items"; $args += $MaxItems }

python @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

python merge_local_images.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location (Join-Path $root "web")
Write-Host "`nGallery data refreshed. Starting preview at http://localhost:8080"
Write-Host "Press Ctrl+C to stop.`n"
python -m http.server 8080