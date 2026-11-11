# Runs the backend API (port 3001) in the foreground of the current session,
# appending output to logs\server-dev.log.
#
# Called by the "Slenk Notes Server" scheduled task at logon so the tunnel has a
# backend to reach without anyone opening a terminal. Can also be run by hand.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSCommandPath
Set-Location -LiteralPath $root
. (Join-Path $root 'launcher-utils.ps1')

$nodeTools = Resolve-NodeTools
if (-not $nodeTools) { throw 'Node.js + npm not found. Install Node.js LTS or add it to PATH.' }
$env:PATH = "$($nodeTools.Dir);$env:PATH"

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$srcDir = Join-Path $root 'server\src'
$entry = Join-Path $srcDir 'index.js'
& $nodeTools.Node --watch "--watch-path=$srcDir" $entry *>> (Join-Path $logDir 'server-dev.log')
