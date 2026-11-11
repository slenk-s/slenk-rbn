# Shared launcher helpers. Dot-source from start/run/setup scripts.

function Find-ExecutableOnPath {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$PathValue = $env:PATH
  )
  foreach ($dir in (($PathValue -split ';') | Where-Object { $_ })) {
    $candidate = Join-Path $dir $Name
    if (Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction SilentlyContinue) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return $null
}

function Resolve-NodeTools {
  param(
    [string]$PathValue = $env:PATH,
    [string[]]$FallbackDirs = @('F:\Node')
  )
  $node = Find-ExecutableOnPath -Name 'node.exe' -PathValue $PathValue
  $npm = Find-ExecutableOnPath -Name 'npm.cmd' -PathValue $PathValue
  if ($node -and $npm) {
    return [pscustomobject]@{ Node = $node; Npm = $npm; Dir = (Split-Path -Parent $node) }
  }
  foreach ($dir in $FallbackDirs) {
    $fallbackNode = Join-Path $dir 'node.exe'
    $fallbackNpm = Join-Path $dir 'npm.cmd'
    if ((Test-Path -LiteralPath $fallbackNode -PathType Leaf -ErrorAction SilentlyContinue) -and
        (Test-Path -LiteralPath $fallbackNpm -PathType Leaf -ErrorAction SilentlyContinue)) {
      return [pscustomobject]@{ Node = $fallbackNode; Npm = $fallbackNpm; Dir = $dir }
    }
  }
  return $null
}

function Resolve-RedisTools {
  param(
    [string]$PathValue = $env:PATH,
    [string]$WingetRoot = (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'),
    [string[]]$FallbackDirs = @('E:\Redis', 'D:\slenk\YLan\Redis')
  )
  $pairs = @()
  if ($WingetRoot -and (Test-Path -LiteralPath $WingetRoot -PathType Container -ErrorAction SilentlyContinue)) {
    $servers = Get-ChildItem -LiteralPath $WingetRoot -Directory -Filter '*redis-windows*' -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -Filter 'redis-server.exe' -File -ErrorAction SilentlyContinue }
    foreach ($server in $servers) {
      $cli = Join-Path $server.DirectoryName 'redis-cli.exe'
      if (Test-Path -LiteralPath $cli -PathType Leaf -ErrorAction SilentlyContinue) {
        $pairs += [pscustomobject]@{ Server = $server.FullName; Cli = $cli }
      }
    }
  }
  $pathServer = Find-ExecutableOnPath -Name 'redis-server.exe' -PathValue $PathValue
  $pathCli = Find-ExecutableOnPath -Name 'redis-cli.exe' -PathValue $PathValue
  if ($pathServer -and $pathCli) { $pairs += [pscustomobject]@{ Server = $pathServer; Cli = $pathCli } }
  foreach ($dir in $FallbackDirs) {
    $server = Join-Path $dir 'redis-server.exe'
    $cli = Join-Path $dir 'redis-cli.exe'
    if ((Test-Path -LiteralPath $server -PathType Leaf -ErrorAction SilentlyContinue) -and
        (Test-Path -LiteralPath $cli -PathType Leaf -ErrorAction SilentlyContinue)) {
      $pairs += [pscustomobject]@{ Server = $server; Cli = $cli }
    }
  }
  return $pairs | Select-Object -First 1
}

function Test-SkillLinkTarget {
  param(
    [Parameter(Mandatory = $true)][string]$LinkPath,
    [Parameter(Mandatory = $true)][string]$ExpectedTarget
  )
  if (-not (Test-Path -LiteralPath $LinkPath)) { return $false }
  try {
    $item = Get-Item -LiteralPath $LinkPath -Force
    $actualTarget = if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
      @($item.Target)[0]
    } else {
      $item.FullName
    }
    $resolvedActual = (Resolve-Path -LiteralPath $actualTarget).Path.TrimEnd('\')
    $resolvedExpected = (Resolve-Path -LiteralPath $ExpectedTarget).Path.TrimEnd('\')
    return [string]::Equals($resolvedActual, $resolvedExpected, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Test-SlenkHealthPayload {
  param([string]$Json)
  try {
    $data = $Json | ConvertFrom-Json
    return $data.ok -eq $true -and $data.app -eq 'slenk-notes'
  } catch {
    return $false
  }
}

function Test-SlenkProcessCommandLine {
  param(
    [string]$CommandLine,
    [string]$RootPath
  )
  if (-not $CommandLine -or -not $RootPath) { return $false }
  $normalized = $CommandLine.Replace('/', '\')
  $serverScript = Join-Path $RootPath 'server\src\index.js'
  $workerScript = Join-Path $RootPath 'server\src\worker.js'
  return $normalized.IndexOf($serverScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
         $normalized.IndexOf($workerScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}
