$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$lib = Join-Path $root 'launcher-utils.ps1'
if (-not (Test-Path -LiteralPath $lib)) { throw "launcher-utils.ps1 missing" }
. $lib

function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw "ASSERT FAILED: $message" }
}

# Node fallback: with PATH stripped, a supplied fallback directory must provide
# concrete node.exe/npm.cmd paths; callers must not depend on bare commands.
$fakeNode = Join-Path $env:TEMP ('slenk-node-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fakeNode | Out-Null
New-Item -ItemType File -Path (Join-Path $fakeNode 'node.exe') | Out-Null
New-Item -ItemType File -Path (Join-Path $fakeNode 'npm.cmd') | Out-Null
try {
  $tools = Resolve-NodeTools -PathValue "$env:SystemRoot\System32" -FallbackDirs @($fakeNode)
  Assert ($tools.Node -eq (Join-Path $fakeNode 'node.exe')) 'Node fallback path was not selected'
  Assert ($tools.Npm -eq (Join-Path $fakeNode 'npm.cmd')) 'npm fallback path was not selected'
} finally { Remove-Item -LiteralPath $fakeNode -Recurse -Force }

# Redis candidate is invalid unless both server and cli exist: launcher needs
# redis-cli to prove readiness instead of trusting a stale LASTEXITCODE.
$fakeRedis = Join-Path $env:TEMP ('slenk-redis-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fakeRedis | Out-Null
New-Item -ItemType File -Path (Join-Path $fakeRedis 'redis-server.exe') | Out-Null
try {
  $onlyServer = Resolve-RedisTools -PathValue "$env:SystemRoot\System32" -WingetRoot '' -FallbackDirs @($fakeRedis)
  Assert ($null -eq $onlyServer) 'Redis server without redis-cli must be rejected'
  New-Item -ItemType File -Path (Join-Path $fakeRedis 'redis-cli.exe') | Out-Null
  # Missing drives/directories must be skipped instead of terminating the launcher
  # under ErrorActionPreference=Stop.
  $pair = Resolve-RedisTools -PathValue "$env:SystemRoot\System32" -WingetRoot '' -FallbackDirs @('Z:\definitely-missing', $fakeRedis)
  Assert ($pair.Server -eq (Join-Path $fakeRedis 'redis-server.exe')) 'Redis server path mismatch'
  Assert ($pair.Cli -eq (Join-Path $fakeRedis 'redis-cli.exe')) 'Redis cli path mismatch'
} finally { Remove-Item -LiteralPath $fakeRedis -Recurse -Force }

# Existing junctions must be accepted only when their resolved target is the
# bundled skill directory.
$linkRoot = Join-Path $env:TEMP ('slenk-link-test-' + [guid]::NewGuid())
$targetA = Join-Path $linkRoot 'target-a'
$targetB = Join-Path $linkRoot 'target-b'
$link = Join-Path $linkRoot 'skill-link'
New-Item -ItemType Directory -Path $targetA,$targetB | Out-Null
try {
  New-Item -ItemType Junction -Path $link -Target $targetA | Out-Null
  Assert (Test-SkillLinkTarget -LinkPath $link -ExpectedTarget $targetA) 'Correct skill junction target was rejected'
  Assert (-not (Test-SkillLinkTarget -LinkPath $link -ExpectedTarget $targetB)) 'Stale skill junction target was accepted'
} finally { Remove-Item -LiteralPath $linkRoot -Recurse -Force }

# Stopper must match only this repository's server/worker command lines.
$repo = 'C:\repo\Slenk Notes'
Assert (Test-SlenkProcessCommandLine -CommandLine 'node "C:\repo\Slenk Notes\server\src\worker.js"' -RootPath $repo) 'Own worker should match'
Assert (-not (Test-SlenkProcessCommandLine -CommandLine 'node C:\other\server\src\worker.js' -RootPath $repo)) 'Other project worker must not match'

# HTTP identity payload must match the expected app marker.
Assert (Test-SlenkHealthPayload -Json '{"ok":true,"app":"slenk-notes"}') 'Valid Slenk health payload was rejected'
Assert (-not (Test-SlenkHealthPayload -Json '{"ok":true,"app":"other"}')) 'Foreign health payload was accepted'
Assert (-not (Test-SlenkHealthPayload -Json '<html>not json</html>')) 'Invalid JSON health payload was accepted'

Write-Output 'PASS launcher utility tests'
