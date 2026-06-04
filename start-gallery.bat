@echo off
REM Optional Windows shortcut — same as: cd web && python -m http.server 8080
title daCommunity Gallery
cd /d "%~dp0web"
echo.
echo  daCAT Collections — local preview
echo  Landing:          http://localhost:8080/
echo  daCommunity:      http://localhost:8080/dacommunity/
echo.
echo  Do NOT double-click index.html — use this link instead.
echo  Press Ctrl+C to stop.
echo.
python -m http.server 8080