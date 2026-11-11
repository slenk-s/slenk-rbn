@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Slenk Notes Stopper

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-slenk-notes.ps1"
if errorlevel 1 (
  echo.
  echo [ERROR] Stopper failed. See messages above.
  pause
  exit /b 1
)

echo.
pause
