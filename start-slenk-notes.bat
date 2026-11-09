@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Slenk Notes Launcher

echo ==================================================
echo   Slenk Notes  -  One Click Launcher
echo ==================================================
echo.

rem Delegate to the robust PowerShell launcher (auto-detects Node/Redis).
rem Use -ExecutionPolicy Bypass to survive locked-down execution policies.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-slenk-notes.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Launcher failed. See messages above.
  pause
  exit /b 1
)

echo.
echo Done. Press any key to close this window.
pause >nul
