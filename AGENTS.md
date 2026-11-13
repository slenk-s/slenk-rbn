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

## XHS account authorization (per-user, multi-account)

Each Slenk user binds **multiple** XHS accounts; users are fully isolated and
different users may bind the same XHS account (each scans independently).
Keep these rules intact when touching auth or publish code:

- Accounts live in `slenk_notes_xhs_accounts`: pending rows are inserted with
  `open_id` NULL and filled when the QR scan auto-matches the scanned openId;
  `unique(user_id, open_id)` rejects duplicates for the same user only.
- Credentials live per account under `storage/auth/<userId>/<accountId>/`,
  overridable via env `SLENK_XHS_AUTH_ROOT`; never commit these dirs.
- Key APIs: `GET/POST/DELETE /api/redapp/accounts` (delete defaults to
  removing the on-disk credentials), `GET /api/redapp/admin/accounts`
  (admin-only, read-only, fails closed with 403), existing
  `/api/redapp/auth/*` endpoints take `?accountId=`, and
  `POST /api/publish/minitool` requires `accountId`.
- All account queries are scoped by `user_id`; an unowned `accountId` must
  return 404, never another user's data.
- API responses and the frontend must never expose tokens, full openIds, or
  absolute credential paths — only the masked openId and a directory-name
  hint (`credentialDirHint`).
- The old single shared credential (`~/.skillhub-upload/`) is **not**
  auto-migrated; leave it untouched.
