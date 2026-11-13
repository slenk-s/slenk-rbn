# Slenk Notes one-click launcher (auto-detect Node / Redis).
#
# Auto-detects Redis (winget package -> PATH -> E:\Redis) and Node (PATH -> F:\Node),
# installs deps if missing, builds the web frontend (keeps the API's dist fresh for the
# tunnel), starts Redis + API + queue worker + Vite dev server, then opens the browser
# at the dev server (http://localhost:5173).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $root
. (Join-Path $root 'launcher-utils.ps1')

function Write-Step([string]$msg) { Write-Host "`n[$($script:step)/7] $msg" -ForegroundColor Cyan; $script:step++ }
function Write-Ok([string]$msg) { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg) { Write-Host "  ERROR $msg" -ForegroundColor Red }

$script:step = 1

# --- 0. Find Node / Redis executables -------------------------------------
$redis = Resolve-RedisTools
$nodeTools = Resolve-NodeTools
if (-not $nodeTools) { Write-Err 'Node.js + npm not found. Install Node.js LTS and add it to PATH.'; exit 1 }
# Add the detected Node directory for child processes, but also use explicit paths below.
$env:PATH = "$($nodeTools.Dir);$env:PATH"
Write-Host "Node     : $($nodeTools.Node)"
Write-Host "npm      : $($nodeTools.Npm)"
if ($redis) { Write-Host "Redis    : $($redis.Server)" } else { Write-Warn 'Redis server + cli pair not found.' }

# --- 1. Check .env ---------------------------------------------------------
if (-not (Test-Path '.env')) { Write-Err '.env not found. Copy the .env from the old machine.'; exit 1 }
Write-Ok '.env found'

# --- 2. Install deps if missing -------------------------------------------
Write-Step 'Checking dependencies'
if (-not (Test-Path 'server\node_modules')) {
  Write-Host '  Installing server deps ...'
  & $nodeTools.Npm --prefix server install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Err 'server deps install failed.'; exit 1 }
} else { Write-Ok 'server deps present' }
if (-not (Test-Path 'web\node_modules')) {
  Write-Host '  Installing web deps ...'
  & $nodeTools.Npm --prefix web install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Err 'web deps install failed.'; exit 1 }
} else { Write-Ok 'web deps present' }

# --- 3. Build frontend ----------------------------------------------------
Write-Step 'Building web frontend'
& $nodeTools.Npm --prefix web run build
if ($LASTEXITCODE -ne 0) { Write-Err 'web build failed.'; exit 1 }
Write-Ok 'web\dist built'

# --- 4. Start Redis --------------------------------------------------------
Write-Step 'Starting Redis'
$redisCli = if ($redis) { $redis.Cli } else { $null }

$ping = $false
if ($redisCli) {
  $oldEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $reply = & $redisCli -p 6379 PING 2>$null
  $ping = ($LASTEXITCODE -eq 0 -and "$reply".Trim() -eq 'PONG')
  $ErrorActionPreference = $oldEAP
}
if ($ping) {
  Write-Ok 'Redis already running'
} elseif ($redis) {
  Write-Host '  Starting redis-server ...'
  Start-Process -FilePath $redis.Server -ArgumentList '--port','6379' -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 500
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $reply = & $redisCli -p 6379 PING 2>$null
    $redisReady = ($LASTEXITCODE -eq 0 -and "$reply".Trim() -eq 'PONG')
    $ErrorActionPreference = $oldEAP
  } while (-not $redisReady -and (Get-Date) -lt $deadline)
  if ($redisReady) { Write-Ok 'Redis started' } else { Write-Err 'Redis did not respond with PONG within 10 seconds.'; exit 1 }
} else {
  Write-Err 'Redis server + redis-cli not found. Install Redis (winget: taizod1024.redis-windows-fork) or add both executables to PATH.'
  exit 1
}

# --- 5. Start API + worker ------------------------------------------------
Write-Step 'Starting backend API (port 3001)'
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$portBusy = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($portBusy) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($portBusy.OwningProcess)" -ErrorAction SilentlyContinue
  $isOwnCommand = $owner -and (Test-SlenkProcessCommandLine -CommandLine $owner.CommandLine -RootPath $root)
  $isSlenkApi = $false
  if (-not $isOwnCommand) {
    try {
      $healthJson = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 3).Content
      $isSlenkApi = Test-SlenkHealthPayload -Json $healthJson
    } catch { $isSlenkApi = $false }
  }
  if ($isOwnCommand -or $isSlenkApi) {
    Write-Ok "Slenk API already running on 3001 (PID $($portBusy.OwningProcess)) - reusing"
  } else {
    Write-Err "Port 3001 is occupied by another process (PID $($portBusy.OwningProcess)); refusing to reuse it."
    exit 1
  }
} else {
  $serverScript = Join-Path $root 'server\src\index.js'
  Start-Process -FilePath $nodeTools.Node -ArgumentList "`"$serverScript`"" -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'server.log') -RedirectStandardError (Join-Path $logDir 'server.err.log')
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
$workerRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { Test-SlenkProcessCommandLine -CommandLine $_.CommandLine -RootPath $root } | Where-Object { $_.CommandLine.Replace('/', '\').IndexOf((Join-Path $root 'server\src\worker.js'), [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }
if ($workerRunning) {
  Write-Ok "Worker already running (PID $($workerRunning.ProcessId -join ','))"
} else {
  $workerScript = Join-Path $root 'server\src\worker.js'
  Start-Process -FilePath $nodeTools.Node -ArgumentList "`"$workerScript`"" -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'worker.log') -RedirectStandardError (Join-Path $logDir 'worker.err.log')
  Write-Ok 'Worker started'
}

# --- 6. Start web dev server (Vite, port 5173) -----------------------------
Write-Step 'Starting web dev server (port 5173)'
$viteBusy = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($viteBusy) {
  Write-Ok 'Web dev server already running on 5173 - reusing'
} else {
  $viteBin = Join-Path $root 'web\node_modules\vite\bin\vite.js'
  Start-Process -FilePath $nodeTools.Node -ArgumentList "`"$viteBin`"" -WorkingDirectory (Join-Path $root 'web') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'web-dev.log') -RedirectStandardError (Join-Path $logDir 'web-dev.err.log')
  # Poll up to ~20s for the dev server to come up.
  $deadline = (Get-Date).AddSeconds(20)
  while (-not $viteBusy -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $viteBusy = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
  }
  if ($viteBusy) { Write-Ok 'Web dev server listening on 5173' } else { Write-Err 'Web dev server did not start. Check logs\web-dev.err.log'; exit 1 }
}

# --- 7. Open browser ------------------------------------------------------
Write-Step 'Opening browser'
Start-Process 'http://localhost:5173/'

Write-Host "`n==================================================" -ForegroundColor Green
Write-Host "  Ready" -ForegroundColor Green
Write-Host "  Web (dev) : http://localhost:5173/" -ForegroundColor Green
Write-Host "  API       : http://localhost:3001/" -ForegroundColor Green
Write-Host "  Login     : admin / 123456" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
