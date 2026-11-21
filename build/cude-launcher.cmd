@echo off
setlocal
if not exist "%~dp0data\" goto launch
set "VSCODE_PORTABLE=%~dp0data"
if not exist "%VSCODE_PORTABLE%\tmp\" mkdir "%VSCODE_PORTABLE%\tmp" 2>nul
if not exist "%VSCODE_PORTABLE%\tmp\" goto launch
set "TEMP=%VSCODE_PORTABLE%\tmp"
set "TMP=%TEMP%"
:launch
start "Cude IDE" "%~dp0CudeIDE.exe" %*
