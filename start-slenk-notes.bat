@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Slenk Notes One-Click Launcher

rem --- Safety: the launcher must sit next to the PowerShell step. ---
if not exist "%~dp0start-slenk-notes.ps1" (
  echo [ERROR] start-slenk-notes.ps1 not found next to this .bat.
  echo         Keep both files in the repo root and retry.
  pause
  exit /b 1
)

rem --- Use the full PowerShell path so PATH changes cannot break us. ---
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" (
  echo [ERROR] Windows PowerShell not found.
  echo         Expected: %PS_EXE%
  pause
  exit /b 1
)

echo ==================================================
echo   Slenk Notes  -  One Click Launcher
echo   Node / Redis are auto-detected below.
echo ==================================================
echo.

rem Delegate to the robust PowerShell launcher (auto-detect + build + start).
rem -ExecutionPolicy Bypass survives locked-down execution policies.
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-slenk-notes.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Launcher failed with exit code %EXIT_CODE%.
  echo         Review the messages above, then press a key.
  pause
  exit /b %EXIT_CODE%
)

echo.
echo Done. Slenk Notes should be running at http://localhost:3001/
echo You can close this window.
pause >nul
exit /b 0
