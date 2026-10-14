# Runs the BullMQ queue worker, appending output to logs\worker-dev.log.
#
# Called by the "Slenk Notes Worker" scheduled task at logon. Can also be run by hand.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $root

if (Test-Path 'F:\Node\node.exe') { $env:PATH = 'F:\Node;' + $env:PATH }
$npm = if (Test-Path 'F:\Node\npm.cmd') { 'F:\Node\npm.cmd' } else { 'npm.cmd' }

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

& $npm --prefix server run queue *>> (Join-Path $logDir 'worker-dev.log')
