@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Slenk Notes Stopper

echo Stopping Slenk Notes ...

rem Delegate cleanup to PowerShell for robust process handling.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = Split-Path -Parent $PSCommandPath; " ^
  "$procs = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src[\\/](index|worker)\\.js' }; " ^
  "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host \"  stopped pid $($p.ProcessId)\" }; " ^
  "$conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue; " ^
  "foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host \"  stopped pid $($c.OwningProcess) (port 3001)\" }; " ^
  "$cli = (Get-Command redis-cli.exe -ErrorAction SilentlyContinue).Source; " ^
  "if (-not $cli) { $d = Get-ChildItem \"$env:LOCALAPPDATA\\Microsoft\\WinGet\\Packages\" -Directory -Filter '*redis-windows*' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($d) { $cli = Join-Path $d.FullName 'redis-cli.exe' } }; " ^
  "if (-not $cli -and (Test-Path 'E:\\Redis\\redis-cli.exe')) { $cli = 'E:\\Redis\\redis-cli.exe' }; " ^
  "if ($cli) { & $cli shutdown nosave 2>$null | Out-Null; Write-Host '  Redis stop requested.' } else { Write-Host '  [WARN] redis-cli not found; Redis stop skipped.' }"

echo.
echo Done. Re-run start-slenk-notes.bat to launch again.
pause
