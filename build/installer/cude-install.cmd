@echo off
setlocal EnableExtensions
title Cude IDE Setup
set "VERSION=0.1.0"
set "DEST=%LOCALAPPDATA%\Programs\Cude IDE"
set "APP=%DEST%\Cude-IDE"
set "KEEP=%LOCALAPPDATA%\Programs\cude-ide-data-keep"
set "LOG=%TEMP%\cude-ide-install.log"
set "SRC=%~dp0"
echo Cude IDE %VERSION% setup %DATE% %TIME% > "%LOG%"
echo source=%SRC% >> "%LOG%"

echo.
echo   Installing Cude IDE %VERSION% for this Windows user...
echo   %DEST%
echo   Privacy: device ID, hashed hardware identity, app/OS version, request count,
echo   and approximate IP country/city are used for Cude Pool security.
echo   Device telemetry does not collect your code or chat content.
echo   Details: docs/PRIVACY.md
echo.

rem Close a running copy so its files can be replaced.
taskkill /im CudeIDE.exe /f >nul 2>&1
ping -n 3 127.0.0.1 >nul

rem Keep settings, history and extensions on upgrade.
if exist "%KEEP%" goto :recovery
if exist "%APP%\data" (
  move "%APP%\data" "%KEEP%" >> "%LOG%" 2>&1
  if errorlevel 1 goto :fail
)

rem Remove the previous program files (retry once if Windows still holds a file).
if exist "%APP%" rd /s /q "%APP%" >> "%LOG%" 2>&1
if exist "%APP%" ( ping -n 4 127.0.0.1 >nul & rd /s /q "%APP%" >> "%LOG%" 2>&1 )
if exist "%APP%" goto :fail
if not exist "%DEST%" mkdir "%DEST%" >> "%LOG%" 2>&1

echo   Copying files...
tar -xf "%SRC%Cude-IDE.zip" -C "%DEST%" >> "%LOG%" 2>&1
if errorlevel 1 goto :fail
if not exist "%APP%\CudeIDE.exe" goto :fail

if exist "%KEEP%" (
  if exist "%APP%\data" rd /s /q "%APP%\data" >nul 2>&1
  move "%KEEP%" "%APP%\data" >> "%LOG%" 2>&1
  if errorlevel 1 goto :fail
)
copy /y "%SRC%uninstall.cmd" "%DEST%\uninstall.cmd" >> "%LOG%" 2>&1

echo   Creating shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; foreach($p in @([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('Desktop'))){ $l=$s.CreateShortcut((Join-Path $p 'Cude IDE.lnk')); $l.TargetPath=$env:APP+'\CudeIDE.exe'; $l.WorkingDirectory=$env:APP; $l.IconLocation=$env:APP+'\CudeIDE.exe,0'; $l.Description='Cude IDE'; $l.Save() }" >> "%LOG%" 2>&1

set "KEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CudeIDE"
reg add "%KEY%" /v DisplayName /d "Cude IDE" /f >nul
reg add "%KEY%" /v DisplayVersion /d "%VERSION%" /f >nul
reg add "%KEY%" /v Publisher /d "Cude Studio" /f >nul
reg add "%KEY%" /v DisplayIcon /d "%APP%\CudeIDE.exe" /f >nul
reg add "%KEY%" /v InstallLocation /d "%DEST%" /f >nul
reg add "%KEY%" /v UninstallString /d "\"%DEST%\uninstall.cmd\"" /f >nul
reg add "%KEY%" /v NoModify /t REG_DWORD /d 1 /f >nul
reg add "%KEY%" /v NoRepair /t REG_DWORD /d 1 /f >nul

echo ok >> "%LOG%"
echo   Done. Starting Cude IDE...
start "" "%APP%\CudeIDE.exe"
exit /b 0

:recovery
echo   Previous settings backup found: %KEEP%
echo   Restore or move this backup before retrying; setup will not delete it.
exit /b 1

:fail
echo failed >> "%LOG%"
echo.
echo   Setup could not finish. Close Cude IDE and run the installer again.
echo   Details: %LOG%
ping -n 8 127.0.0.1 >nul
exit /b 1
