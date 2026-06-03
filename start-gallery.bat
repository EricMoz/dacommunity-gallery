@echo off
title daCommunity Gallery
cd /d "%~dp0web"
echo.
echo  daCommunity Gallery — local preview
echo  Open in browser:  http://localhost:8080
echo.
echo  Do NOT double-click index.html — use this link instead.
echo  Press Ctrl+C to stop.
echo.
python -m http.server 8080