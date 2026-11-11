# Stops only Node processes launched from this repository.
# Redis is shared infrastructure and remains running unless -StopRedis is passed.
param([switch]$StopRedis)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSCommandPath
. (Join-Path $root 'launcher-utils.ps1')

Write-Host 'Stopping Slenk Notes ...'
$seen = @{}
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { Test-SlenkProcessCommandLine -CommandLine $_.CommandLine -RootPath $root }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  $seen[$p.ProcessId] = $true
  Write-Host "  stopped pid $($p.ProcessId)"
}
$conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) {
  if (-not $seen[$c.OwningProcess]) {
    Write-Warning "Port 3001 is owned by PID $($c.OwningProcess), but its command line is not this repository. It was not stopped."
  }
}

if ($StopRedis) {
  $redis = Resolve-RedisTools
  if ($redis) {
    & $redis.Cli -p 6379 shutdown nosave 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host '  Redis stop requested.' }
    else { Write-Warning 'redis-cli shutdown failed; Redis may already be stopped.' }
  } else {
    Write-Warning 'Redis server + cli pair not found; Redis stop skipped.'
  }
} else {
  Write-Host '  Redis left running (use stop-slenk-notes.ps1 -StopRedis to stop it).'
}

Write-Host 'Done. Re-run start-slenk-notes.bat to launch again.'
