# Stops Redis: graceful `shutdown nosave` via redis-cli first (shared detection),
# pid-file fallback, last resort kills remaining redis-server processes.

$ErrorActionPreference = 'Continue'
$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $toolDir
. (Join-Path $root 'launcher-utils.ps1')

$redis = Resolve-RedisTools
$stopped = $false
if ($redis) {
  & $redis.Cli -p 6379 shutdown nosave 2>$null | Out-Null
  # redis-cli exits 0 even when the server closes the connection mid-shutdown;
  # confirm with a failed PING.
  Start-Sleep -Milliseconds 500
  $reply = & $redis.Cli -p 6379 PING 2>$null
  $stopped = -not ($LASTEXITCODE -eq 0 -and "$reply".Trim() -eq 'PONG')
}

$pidFile = Join-Path $toolDir 'redis.pid'
if (-not $stopped -and (Test-Path $pidFile)) {
  $pid = [int](Get-Content $pidFile | Select-Object -First 1)
  Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
  $stopped = $true
}
Remove-Item $pidFile -ErrorAction SilentlyContinue

if (-not $stopped) {
  Get-Process -Name redis-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Write-Host 'Redis stopped.'
