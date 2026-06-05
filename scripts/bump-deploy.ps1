# Manual cache-bust before push (CI runs bump_deploy_version.py on every Pages deploy).
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
python scripts/bump_deploy_version.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Commit web/VERSION.txt, web/BUILD.json, and any updated HTML/CSS/JS query strings."