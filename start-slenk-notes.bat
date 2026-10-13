@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Slenk Notes Launcher

echo ==================================================
echo   Slenk Notes  -  One Click Launcher
echo ==================================================
echo.

if not exist ".env" (
  echo [ERROR] .env not found in: %~dp0
  pause
  exit /b 1
)

echo [1/5] Building web frontend ...
if not exist "web\node_modules" (
  echo       web dependencies missing, running npm install ...
  call npm --prefix web install --no-audit --no-fund --silent
)
call npm --prefix web run build
if errorlevel 1 (
  echo [ERROR] web build failed. See messages above.
  pause
  exit /b 1
)
echo       done - web\dist built.
echo.

echo [2/5] Checking Redis ...
if not exist "E:\Redis\redis-server.exe" (
  echo [ERROR] E:\Redis\redis-server.exe not found.
  pause
  exit /b 1
)
"E:\Redis\redis-cli.exe" ping >nul 2>&1
if errorlevel 1 (
  echo       Redis not running, starting it ...
  start "Slenk Notes - Redis" /D "E:\Redis" cmd /k "redis-server.exe redis.windows.conf"
  timeout /t 3 /nobreak >nul
) else (
  echo       Redis already running.
)
"E:\Redis\redis-cli.exe" ping >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Redis did not come up. Check E:\Redis\redis.windows.conf
  pause
  exit /b 1
)
echo       Redis OK.
echo.

echo [3/5] Starting backend API on port 3001 ...
start "Slenk Notes - Server" cmd /k "npm --prefix server run dev"
echo.

echo [4/5] Starting queue worker ...
start "Slenk Notes - Queue Worker" cmd /k "npm --prefix server run queue"
echo.

echo [5/5] Opening browser ...
timeout /t 4 /nobreak >nul
start "" "http://localhost:3001/"

echo ==================================================
echo   Ready
echo   Web + API : http://localhost:3001/
echo   Login     : admin / 123456
echo   Windows   : Redis / Server / Queue Worker
echo ==================================================
echo.
pause