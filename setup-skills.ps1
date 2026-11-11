# Creates project-local skill junctions so both Codex (.codex/skills) and
# Claude Code (.claude/skills) can discover the skills bundled in .skills/.
# Run once after cloning on a new machine. Idempotent: safe to re-run.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
$projSkills = Join-Path $root '.skills'
. (Join-Path $root 'launcher-utils.ps1')

$targets = @('redapp-cli', 'minitool-zip-builder')
foreach ($name in $targets) {
  $manifest = Join-Path $projSkills "$name\SKILL.md"
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw "Bundled Skill is incomplete: $manifest not found"
  }
}

$agentDirs = @('.codex\skills', '.claude\skills')

foreach ($agentDir in $agentDirs) {
  $dir = Join-Path $root $agentDir
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($name in $targets) {
    $link = Join-Path $dir $name
    $target = Join-Path $projSkills $name
    if (Test-SkillLinkTarget -LinkPath $link -ExpectedTarget $target) {
      Write-Output "exists (correct target): $link -> $target"
      continue
    }
    $existing = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
    if ($existing) {
      if (-not ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink')) {
        throw "Refusing to replace real directory: $link. Move or back it up, then re-run setup-skills.ps1."
      }
      Remove-Item -LiteralPath $link -Force
      Write-Output "removed stale link: $link"
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Write-Output "created junction: $link -> $target"
  }
}

Write-Output "Done. Skills discoverable from .codex/skills and .claude/skills."
