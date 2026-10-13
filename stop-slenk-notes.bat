@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Slenk Notes Stopper

echo Stopping Slenk Notes ...

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3001 " ^| findstr "LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>&1 && echo   stopped pid %%p (port 3001)
)

wmic process where "name='cmd.exe' and commandline like '%%Slenk Notes%%'" get processid /value 2>nul | findstr "processid" | for /f "tokens=2 delims==" %%p do (
  taskkill /PID %%p /T /F >nul 2>&1
)

"E:\Redis\redis-cli.exe" shutdown nosave >nul 2>&1
echo   Redis stop requested.
echo.
echo Done. Re-run start-slenk-notes.bat to launch again.
pause