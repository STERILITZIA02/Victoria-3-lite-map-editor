@echo off
REM Start the local Victoria 3 Lite Map Editor from the repository/mod root.
REM Keep this folder directly under an ASCII-only Victoria 3 mod directory when saving map edits.
cd /d "%~dp0\tools\state-map-viewer"
node server.js --open
pause
