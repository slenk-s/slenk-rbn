# Agent Guidance

## Bundled skills

This repo bundles two Xiaohongshu (XHS) skills under `.skills/`, plus one
Cloudflare skill:

- `redapp-cli` — management/CLI skill: run the `redapp` CLI to debug locally,
  query mini-tools, upload packages/images, generate phone previews, submit
  versions, and edit basic info.
- `minitool-zip-builder` — development/spec skill: build H5 pages into
  container-compliant offline `.zip` mini-tool packages and validate artifacts.
- `turnstile-spin` — Cloudflare Turnstile skill: set up, repair, or migrate
  Turnstile bot verification (widget embed + server-side siteverify). The login
  page uses this integration.

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

## Data layer

- 数据层为 SQLite（唯一后端；MySQL 已移除）。SQLite 文件：`SQLITE_PATH`（默认 `storage/slenk.sqlite`）；媒体字节：`MEDIA_DIR`（默认 `storage/media`），元数据在 `slenk_notes_media`。
- SQLite 首启只从 `storage/local/` 一次性导入 `users` / `providers` / `user_settings`（`slenk_notes_meta.local_import_v1` 标记）；旧任务/笔记/媒体不迁移。

## Multi-image tasks (read before touching)

Feature pages submit `image` / `video` / `rewrite` tasks with a `tab`; the
worker runs them from the shared `ai-tasks` queue. Keep these invariants:

- `server/src/lib/referenceImages.js` caps references: 9 in per-reference mode
  (`MAX_PER_REFERENCE_IMAGES`), and 2 when composing one image
  (`MAX_REFERENCE_IMAGES`; excess is truncated with a worker-log warning only,
  the task still succeeds).
- Image tasks: `perReference !== false` with more than one reference means one
  `/images/edits` request per reference (outputs = references × `count`, with
  `imageReferences`); otherwise all references go into a single request and
  output = `count` (1–4). Uploads are capped at 9 files, 25MB each.
- Video tasks: one MP4 per input image, `videos` / `localVideos` in input
  order. `VIDEO_CONCURRENCY` and `IMAGE_REQUEST_CONCURRENCY` are clamped 1–4.
- Note-rewrite text generation deliberately sends no reference images
  (`referenceImages = []` in `server/src/worker.js`); per-image regeneration
  submits one `purpose: 'noteImage'` image task per image.
- Note download (商品下载) caches parsed XHS images under `storage/notes-images`
  (width 1080, concurrency 4, 25s budget) and downloads through
  `/api/download`, which only accepts absolute http(s) URLs.

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
