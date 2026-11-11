# Runs the BullMQ queue worker, appending output to logs\worker-dev.log.
#
# Called by the "Slenk Notes Worker" scheduled task at logon. Can also be run by hand.

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
$entry = Join-Path $srcDir 'worker.js'
& $nodeTools.Node --watch "--watch-path=$srcDir" $entry *>> (Join-Path $logDir 'worker-dev.log')
