# Agent Guidance

## Bundled skills

This repo bundles two Xiaohongshu (XHS) skills under `.skills/`:

- `redapp-cli` — management/CLI skill: run the `redapp` CLI to debug locally,
  query mini-tools, upload packages/images, generate phone previews, submit
  versions, and edit basic info.
- `minitool-zip-builder` — development/spec skill: build H5 pages into
  container-compliant offline `.zip` mini-tool packages and validate artifacts.

These are project-local (not tied to a single agent). The same source lives in
`.skills/`, and agent-specific discovery dirs (`.codex/skills`, `.claude/skills`)
point at it via directory junctions.

## Setup on a new machine

Junctions are not tracked by git. After cloning, run once to make the skills
discoverable by both Codex and Claude Code:

```powershell
.\setup-skills.ps1
```

## When working on mini-tools

- For CLI operations (upload / preview / submit / edit), follow `redapp-cli`
  and always run the version gate first with a process-scoped writable npm
  prefix/cache (for example under `storage/redapp-npm/`); do not permanently
  change global npm config. Only continue when `CLI_VERSION_JSON.status` is
  `current`, `installed`, or `updated`.
- For building/packaging H5 as a mini-tool zip, follow `minitool-zip-builder`
  and validate with `.skills/minitool-zip-builder/scripts/audit_artifact.mjs`.
- Do not invent API contracts; read the references under each skill's
  `references/` before acting.
