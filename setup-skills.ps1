# Creates project-local skill junctions so both Codex (.codex/skills) and
# Claude Code (.claude/skills) can discover the skills bundled in .skills/.
# Run once after cloning on a new machine. Idempotent: safe to re-run.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
$projSkills = Join-Path $root '.skills'

if (-not (Test-Path (Join-Path $projSkills 'redapp-cli\SKILL.md'))) {
  Write-Error ".skills/redapp-cli/SKILL.md not found. Expected bundled skills under $projSkills"
}

$targets = @('redapp-cli', 'minitool-zip-builder')
$agentDirs = @('.codex\skills', '.claude\skills')

foreach ($agentDir in $agentDirs) {
  $dir = Join-Path $root $agentDir
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($name in $targets) {
    $link = Join-Path $dir $name
    $target = Join-Path $projSkills $name
    if (-not (Test-Path $link)) {
      New-Item -ItemType Junction -Path $link -Target $target | Out-Null
      Write-Output "created junction: $link -> $target"
    } else {
      # Refresh a stale junction / plain directory pointing elsewhere.
      $item = Get-Item -LiteralPath $link -Force
      if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
        Write-Output "exists (already linked): $link"
      } else {
        Remove-Item -LiteralPath $link -Recurse -Force
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        Write-Output "replaced plain dir with junction: $link -> $target"
      }
    }
  }
}

Write-Output "Done. Skills discoverable from .codex/skills and .claude/skills."
