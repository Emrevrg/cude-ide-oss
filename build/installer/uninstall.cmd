@echo off
setlocal EnableExtensions
title Uninstall Cude IDE
set "DEST=%LOCALAPPDATA%\Programs\Cude IDE"
choice /m "Remove Cude IDE and its settings from this computer"
if errorlevel 2 exit /b 0
taskkill /im CudeIDE.exe /f >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Cude IDE.lnk" >nul 2>&1
powershell -NoProfile -Command "Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Cude IDE.lnk') -ErrorAction SilentlyContinue"
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CudeIDE" /f >nul 2>&1
rem Remove the folder after this script exits (it lives inside it).
start "" /min cmd /c "timeout /t 2 /nobreak >nul & rd /s /q ""%DEST%"""
echo Cude IDE was removed.
