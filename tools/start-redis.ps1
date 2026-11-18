# Starts Redis for Slenk Notes using the shared auto-detection (winget package ->
# PATH -> E:\Redis). The bundled tools\redis-*.exe are the old 5.0.14 build kept only
# as a backup and are intentionally NOT used; production runs 8.10.3 from E:\Redis.
# AOF persistence matches the main launcher (start-slenk-notes.ps1).

$ErrorActionPreference = 'Stop'
$toolDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $toolDir
. (Join-Path $root 'launcher-utils.ps1')

$redis = Resolve-RedisTools
if (-not $redis) { throw 'Redis server + cli pair not found (winget package, PATH, or E:\Redis).' }

# Already running? Prove it with PING instead of trusting a pid file.
$reply = & $redis.Cli -p 6379 PING 2>$null
if ($LASTEXITCODE -eq 0 -and "$reply".Trim() -eq 'PONG') {
  Write-Host "Redis already running ($($redis.Server))"
  exit 0
}

# AOF 持久化（appendfsync everysec）：Redis 崩溃/重启后 BullMQ 队列不丢（官方推荐配置）。
# 持久化文件写入 storage\redis，避免 RDB/AOF 散落在仓库根目录。
$redisDataDir = Join-Path $root 'storage\redis'
if (-not (Test-Path $redisDataDir)) { New-Item -ItemType Directory -Path $redisDataDir -Force | Out-Null }
$redisArgs = @('--port','6379','--appendonly','yes','--appendfsync','everysec','--dir',('"' + $redisDataDir + '"'))
$proc = Start-Process -FilePath $redis.Server -ArgumentList $redisArgs -WindowStyle Hidden -PassThru
Set-Content -Path (Join-Path $toolDir 'redis.pid') -Value $proc.Id

$deadline = (Get-Date).AddSeconds(10)
do {
  Start-Sleep -Milliseconds 500
  $reply = & $redis.Cli -p 6379 PING 2>$null
  $ready = ($LASTEXITCODE -eq 0 -and "$reply".Trim() -eq 'PONG')
} while (-not $ready -and (Get-Date) -lt $deadline)
if (-not $ready) { throw 'Redis did not respond with PONG within 10 seconds.' }

$version = (& $redis.Server --version) -replace '^Redis server v=([^\s]+).*', '$1'
Write-Host "Redis $version started, PID $($proc.Id) ($($redis.Server))"
