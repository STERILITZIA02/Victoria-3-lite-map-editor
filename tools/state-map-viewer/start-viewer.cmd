@echo off
REM Run from this folder when you want the tool URL to open automatically.
REM Use ..\.. as the mod root unless VIC3_MOD_ROOT is set explicitly.
cd /d "%~dp0"
node server.js --open
pause
