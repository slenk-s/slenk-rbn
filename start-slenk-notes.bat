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

echo [1/6] Building web frontend ...
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

echo [2/6] Checking Redis ...
if not exist "E:\Redis\redis-server.exe" (
  echo [ERROR] E:\Redis\redis-server.exe not found.
  pause
  exit /b 1
)
sc query Redis >nul 2>&1
if errorlevel 1 goto redis_standalone
sc query Redis | find "RUNNING" >nul 2>&1
if errorlevel 1 (
  echo       Redis service found but stopped, starting it ...
  net start Redis >nul 2>&1
) else (
  echo       Redis service already running.
)
goto redis_check

:redis_standalone
"E:\Redis\redis-cli.exe" ping >nul 2>&1
if errorlevel 1 (
  echo       Redis not running, starting it ...
  start "Slenk Notes - Redis" /D "E:\Redis" cmd /k "redis-server.exe redis.windows.conf"
  ping -n 4 127.0.0.1 >nul
) else (
  echo       Redis already running.
)

:redis_check
"E:\Redis\redis-cli.exe" ping >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Redis did not come up. Check E:\Redis\redis.windows.conf
  pause
  exit /b 1
)
echo       Redis OK.
echo.

echo [3/6] Checking backend API on port 3001 ...
netstat -ano | findstr "LISTENING" | findstr ":3001 " >nul 2>&1
if errorlevel 1 (
  echo       Starting backend API ...
  start "Slenk Notes - Server" cmd /k "npm --prefix server run dev"
) else (
  echo       Port 3001 already in use - skipping, the running instance is reused.
)
echo.

echo [4/6] Checking queue worker ...
set WORKER_COUNT=ERR
for /f %%c in ('powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*src/worker.js*' }).Count"') do set WORKER_COUNT=%%c
set START_WORKER=1
if not "%WORKER_COUNT%"=="0" if not "%WORKER_COUNT%"=="ERR" set START_WORKER=0
if "%START_WORKER%"=="1" (
  echo       Starting queue worker ...
  start "Slenk Notes - Queue Worker" cmd /k "npm --prefix server run queue"
) else (
  echo       Worker already running ^(%WORKER_COUNT% node process^(es^)^) - skipping.
)
echo.

echo [5/6] Checking Cloudflare tunnel ...
sc query cloudflared | find "RUNNING" >nul 2>&1
if errorlevel 1 (
  echo       [WARN] cloudflared service is not running.
  echo              Public access via https://236963.xyz will be unavailable.
) else (
  echo       cloudflared service is running.
)
echo.

echo [6/6] Opening browser ...
ping -n 5 127.0.0.1 >nul
start "" "http://localhost:3001/"

echo ==================================================
echo   Ready
echo   Web + API : http://localhost:3001/
echo   Public    : https://236963.xyz/
echo   Login     : admin / 123456
echo ==================================================
echo.
pause
