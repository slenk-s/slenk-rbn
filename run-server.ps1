# Runs the backend API (port 3001) in the foreground of the current session,
# appending output to logs\server-dev.log.
#
# Called by the "Slenk Notes Server" scheduled task at logon so the tunnel has a
# backend to reach without anyone opening a terminal. Can also be run by hand.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $root

# The task runs with a minimal environment, so make sure node/npm resolve.
if (Test-Path 'F:\Node\node.exe') { $env:PATH = 'F:\Node;' + $env:PATH }
$npm = if (Test-Path 'F:\Node\npm.cmd') { 'F:\Node\npm.cmd' } else { 'npm.cmd' }

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

& $npm --prefix server run dev *>> (Join-Path $logDir 'server-dev.log')
