# Slenk Notes one-click launcher (auto-detect Node / Redis).
#
# Auto-detects Redis (winget package -> PATH -> E:\Redis) and Node (PATH -> F:\Node),
# installs deps if missing, builds the web frontend, starts Redis + API + queue worker,
# then opens the browser.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $root

function Write-Step([string]$msg) { Write-Host "`n[$($script:step)/6] $msg" -ForegroundColor Cyan; $script:step++ }
function Write-Ok([string]$msg) { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg) { Write-Host "  ERROR $msg" -ForegroundColor Red }

$script:step = 1

# --- 0. Find Redis executables -------------------------------------------
function Find-Redis {
  $candidates = @()
  # winget packages dir
  $wg = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter '*redis-windows*' -ErrorAction SilentlyContinue
  foreach ($d in $wg) {
    $srv = Join-Path $d.FullName 'redis-server.exe'
    $cli = Join-Path $d.FullName 'redis-cli.exe'
    if (Test-Path $srv) { $candidates += [pscustomobject]@{ Server = $srv; Cli = $cli } }
  }
  # PATH lookup
  $srvFromPath = (Get-Command redis-server.exe -ErrorAction SilentlyContinue).Source
  $cliFromPath = (Get-Command redis-cli.exe -ErrorAction SilentlyContinue).Source
  if ($srvFromPath) { $candidates += [pscustomobject]@{ Server = $srvFromPath; Cli = $cliFromPath } }
  # legacy E:\Redis
  if (Test-Path 'E:\Redis\redis-server.exe') { $candidates += [pscustomobject]@{ Server = 'E:\Redis\redis-server.exe'; Cli = 'E:\Redis\redis-cli.exe' } }
  return $candidates | Select-Object -First 1
}

function Find-Node {
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node -and (Test-Path 'F:\Node\node.exe')) { $node = 'F:\Node\node.exe' }
  if ($node) { return Split-Path -Parent $node }
  return $null
}

$redis = Find-Redis
$nodeDir = Find-Node
if (-not $nodeDir) { Write-Err 'Node.js not found. Install Node.js LTS and add it to PATH.'; exit 1 }
Write-Host "Node dir : $nodeDir"
if ($redis) { Write-Host "Redis    : $($redis.Server)" } else { Write-Warn 'Redis not found (will try redis-cli on PATH later).' }

# --- 1. Check .env ---------------------------------------------------------
if (-not (Test-Path '.env')) { Write-Err '.env not found. Copy the .env from the old machine.'; exit 1 }
Write-Ok '.env found'

# --- 2. Install deps if missing -------------------------------------------
Write-Step 'Checking dependencies'
if (-not (Test-Path 'server\node_modules')) {
  Write-Host '  Installing server deps ...'
  & npm --prefix server install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Err 'server deps install failed.'; exit 1 }
} else { Write-Ok 'server deps present' }
if (-not (Test-Path 'web\node_modules')) {
  Write-Host '  Installing web deps ...'
  & npm --prefix web install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Err 'web deps install failed.'; exit 1 }
} else { Write-Ok 'web deps present' }

# --- 3. Build frontend ----------------------------------------------------
Write-Step 'Building web frontend'
& npm --prefix web run build
if ($LASTEXITCODE -ne 0) { Write-Err 'web build failed.'; exit 1 }
Write-Ok 'web\dist built'

# --- 4. Start Redis --------------------------------------------------------
Write-Step 'Starting Redis'
$redisCli = $null
if ($redis -and (Test-Path $redis.Cli)) { $redisCli = $redis.Cli }
else { $redisCli = (Get-Command redis-cli.exe -ErrorAction SilentlyContinue).Source }

$ping = $false
if ($redisCli) {
  $oldEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $redisCli -p 6379 PING 2>$null | Out-Null
  $ping = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $oldEAP
}
if ($ping) {
  Write-Ok 'Redis already running'
} elseif ($redis) {
  Write-Host '  Starting redis-server ...'
  Start-Process -FilePath $redis.Server -ArgumentList '--port','6379' -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if ($redisCli) {
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $redisCli -p 6379 PING 2>$null | Out-Null
    $ErrorActionPreference = $oldEAP
  }
  if ($LASTEXITCODE -eq 0) { Write-Ok 'Redis started' } else { Write-Err 'Redis did not respond to PING.'; exit 1 }
} else {
  Write-Warn 'Redis not found. Install Redis (winget: taizod1024.redis-windows-fork) or start it manually.'
}

# --- 5. Start API + worker ------------------------------------------------
Write-Step 'Starting backend API (port 3001)'
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$portBusy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
  Write-Ok "Port 3001 already in use (PID $($portBusy.OwningProcess)) - reusing"
} else {
  Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server.err.log')
  # Poll up to ~15s for the port to come up (first boot can be slow).
  $deadline = (Get-Date).AddSeconds(15)
  $portBusy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
  while (-not $portBusy -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $portBusy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
  }
  if ($portBusy) { Write-Ok 'API listening on 3001' } else { Write-Err 'API did not start. Check logs\server.err.log'; exit 1 }
}

Write-Step 'Starting queue worker'
$workerRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]worker\.js' }
if ($workerRunning) {
  Write-Ok "Worker already running (PID $($workerRunning.ProcessId -join ','))"
} else {
  Start-Process -FilePath 'node' -ArgumentList 'src/worker.js' -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'worker.log') -RedirectStandardError (Join-Path $logDir 'worker.err.log')
  Write-Ok 'Worker started'
}

# --- 6. Open browser ------------------------------------------------------
Write-Step 'Opening browser'
Start-Process 'http://localhost:3001/'

Write-Host "`n==================================================" -ForegroundColor Green
Write-Host "  Ready" -ForegroundColor Green
Write-Host "  Web + API : http://localhost:3001/" -ForegroundColor Green
Write-Host "  Login     : admin / 123456" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
