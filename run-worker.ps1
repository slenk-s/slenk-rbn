# Runs the BullMQ queue worker, appending output to logs\worker-dev.log.
#
# Called by the "Slenk Notes Worker" scheduled task at logon. Can also be run by hand.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $root

# Auto-detect: system PATH first, then legacy F:\Node.
$nodeDir = $null
$nodeCmd = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ($nodeCmd) { $nodeDir = Split-Path -Parent $nodeCmd }
elseif (Test-Path 'F:\Node\node.exe') { $nodeDir = 'F:\Node' }
if ($nodeDir) { $env:PATH = "$nodeDir;" + $env:PATH }
$npm = if ($nodeDir -and (Test-Path (Join-Path $nodeDir 'npm.cmd'))) { Join-Path $nodeDir 'npm.cmd' } else { 'npm.cmd' }

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

& $npm --prefix server run queue *>> (Join-Path $logDir 'worker-dev.log')
