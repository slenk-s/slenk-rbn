# Task 6 Report — 扫码直达授权弹框与自动续发

## Status

Implemented on top of `feat/redapp-auth-center` tip `f29ee4d` (including Task 4 `39e4320` and approved Task 5 `6bd1f0f`).

## Implementation

- `NoteRewriteWorkspace` captures a frozen publish request snapshot at click time, including copied `tags` and `images` arrays.
- Added a raw Fetch-like Bearer adapter that returns `Response` objects, applies request deadlines, and lets `readApiError()` preserve safe structured `AUTH_REQUIRED` fields.
- Integrated `publishWithAuth()` with `createRedappAuthClient()` exact-session polling and a ten-minute deadline.
- Reused `RedappAuthModal` in `resume-publish` mode. Completed authorization shows “授权成功，正在继续发布…” without Task 5 dashboard status refresh behavior.
- Closing the modal only hides it. Poll/replay continues while mounted; a fixed progress button reopens it.
- Explicit cancel aborts polling/replay immediately, separately calls server cancel, preserves note/channel state, and normalizes controller cancellation to `AUTH_NOT_COMPLETED`.
- Starting a newer attempt aborts the older controller. Ref identity and exact-session checks prevent stale UI commits/replay.
- Success clears pending/auth state and opens the existing preview QR/link modal.
- Terminal auth errors keep the note intact, present terminal guidance, and allow a fresh submit retry.
- Draft-channel publishing remains unchanged.
- Workspace `api()` now augments errors with decoded fields and HTTP status.

## State-machine decisions

1. `idle -> publishing`: create in-memory immutable request and flow object.
2. `publishing -> auth-required`: retain exact `sessionId`, show shared modal, poll only that session.
3. `auth-required -> hidden`: close hides presentation only; controller continues.
4. `auth-required -> authorized -> replaying`: update modal/status, replay exactly once with original snapshot.
5. `replaying -> preview`: clear pending/auth state and display existing preview modal.
6. `auth-required -> cancelled`: abort client before server cancellation so no replay can race past cancel.
7. `auth-required -> failed/expired/not-found`: stop flow, preserve terminal presentation/form; no automatic retry.
8. `any active -> newer attempt/unmount`: abort old controller; stale identity checks suppress old commits.

No pending request or controller is stored in localStorage or global state.

## TDD evidence

RED observed:

- Snapshot/adapter tests initially failed because exports did not exist.
- Exact-session progress callback test initially failed with no updates.
- Explicit cancellation contract test initially failed with `AUTH_CANCELLED` rather than `AUTH_NOT_COMPLETED`.

GREEN observed after minimal implementations:

- Snapshot copies mutable arrays and stringifies scalar fields.
- Fetch adapter preserves raw responses and Bearer headers.
- Polling emits exact-session updates through terminal `done`.
- Explicit polling cancellation becomes `AUTH_NOT_COMPLETED` and never replays.

## Verification

- `npm --prefix web test`: 66/66 pass.
- `npm --prefix web run lint`: exits 0; existing `App.jsx` warnings remain, no lint errors.
- `npm --prefix web run build`: succeeds; 49 modules transformed.
- `git diff --check`: clean.

## Review findings addressed

Independent review findings fixed: cancel/replay race, cancel failure message overwrite, cancellation contract, raw request deadlines, structured workspace errors, terminal auth-state visibility, and undefined CSS variables.

## Concerns / limitations

- Browser Preview is attached to the original checkout rather than this isolated worktree, so this UI was not interactively exercised against live auth. No live redapp authorization was mutated.
- Lint reports pre-existing warnings in `App.jsx`; it has no errors and exits successfully.

## Review repair — 2026-11-11

All 7 Important and 2 Minor findings were repaired as one explicit publish-flow state machine:

- Flows now carry generation, phase, cancellation identity, and controller state; every async UI/preview commit uses the common current-flow guard.
- Cancellation enters `cancelling` before abort, retains flow identity through server cancellation, never lets the aborted publish catch own cancellation state, and preserves the exact session with bounded failure guidance when server cancellation fails.
- Mini-tool publish uses a dedicated 900,000ms deadline (120s audits + 360s upload + 240s preview + 180s margin); ordinary auth calls remain 20,000ms.
- The fetch adapter has an `AbortSignal.any` compatibility path forwarding both caller/deadline aborts and cleaning listeners/timers.
- Reopen control is above the publish confirmation backdrop, while the auth modal remains above both.
- Poll timeout is a retained retryable `timeout` terminal; all resume-publish terminal states receive a fresh-submit retry action.
- New reservations synchronously clear stale auth presentation, and unchanged poll fields preserve React state object identity.

### Review TDD evidence

RED observed before production changes:

- Focused tests failed on missing state/deadline/helper exports.
- UI source/style assertion failed because timeout presentation/retry wiring were absent and reopen z-index was below 1200.
- Adapter fallback coverage required caller abort, deadline abort with a caller signal, and listener cleanup.

GREEN after implementation:

- Focused flow/UI tests: 63/63 pass during the repair cycle.
- Final full suite: 75/75 pass.
- `npm --prefix web run lint`: exits 0 with the same 15 pre-existing `App.jsx` warnings and no errors.
- `npm --prefix web run build`: succeeds; 49 modules transformed.
- `git diff --check`: clean.

### Remaining concern


## Comprehensive idempotency hardening — 2026-11-12

All 9 Important and 4 Minor findings from the idempotent architecture review were addressed on top of `8900784`.

### Server architecture

- Strictly validates every mini-tool publish field before auth/login: attempt IDs, scalar types/lengths, tags, image count/length, and project-supported image sources.
- Canonicalizes operation inputs and binds owner-scoped attempt IDs to SHA-256 fingerprints. Same payload/new ID aliases running or retained done work; same ID/different payload returns safe `409 PUBLISH_ATTEMPT_CONFLICT`; failed work releases its fingerprint for a fresh retry.
- Replaced the eager promise registry with bounded queued/running execution, global concurrency 2, per-user admission 1, queued/running deadlines, bounded aliases and records, terminal retention, no running eviction, abort-on-dispose, and late-result guards.
- Replaced route `spawnSync` audits and sync upload/preview with cancellable async runners and async dry-run/confirm operations. The repository audit script is mandatory; both directory and zip require exit 0, no `ERROR`, and `PASS`.
- Build fetches combine per-image 30-second deadlines with the job signal, check cancellation between image/compression stages, and abort zip streams.
- QR output uses the existing single-handle 2 MiB PNG reader, accepts only the expected output path, and falls back from stale CLI paths without exposing local paths or raw audit/process output.

### Frontend recovery

- Request ID generation now has a `crypto.getRandomValues` UUID-v4 fallback inside the handled submit flow.
- Initial POST transport/timeout/JSON uncertainty immediately polls the same attempt; authoritative auth and validation/conflict responses remain authoritative.
- POST and GET parse queued/running/done/failed explicitly. Failed and done-without-output produce terminal failure UI.
- Cancel-after-replay retains the same attempt and resumes result recovery. Unknown work keeps “查询发布结果”; fresh IDs are available only after authoritative failure/pre-job auth termination.
- Refresh duplication is prevented without localStorage by the server owner+fingerprint alias index: resubmitting an unchanged note with a new UUID reuses running/done work during retention.

### TDD evidence

RED was observed for strict canonical validation/fingerprints, alias conflict and reuse, queue/deadline/disposal, fail-closed audits, async runner cancellation, QR fallback/path safety, initial-POST recovery, explicit queued/failed parsing, and UUID fallback. Focused implementations then made those tests GREEN.

### Final verification

- Server auth + reference + publish suites: 96 tests, 96 pass.
- Full web suite: 83 tests, 83 pass.
- Web lint: exits 0 with 15 pre-existing warnings and no errors.
- Web production build: succeeds, 49 modules transformed.
- Server syntax checks and `git diff --check`: pass.

### Concerns

- The registry remains intentionally process-local for the documented local single-process deployment; server restart loses retained job status.
- No real CLI, network, login, upload, or phone preview was used. Online mini-tool documentation could not be fetched in this environment, so the bundled references were used conservatively.
- `npm install --ignore-scripts` reports existing dependency advisories (4 moderate, 1 high); they were not introduced or remediated by this task.


## Architectural repair — idempotent publish jobs

The synchronous mini-tool endpoint is now an authenticated, owner-bound job API. A validated client `attemptId` creates exactly one in-memory job; duplicate concurrent POSTs reuse it, POST returns `202 running`, and owner-only GET polling returns safe `running`, `done`, or fixed-error `failed` DTOs. Terminal jobs expire after 30 minutes, entries are capped at 100 without evicting running jobs, and cleanup timers are unreferenced/disposable.

The browser freezes a UUID with the note snapshot, submits that ID through the one-replay authorization flow, and polls `/api/publish/minitool/jobs/:attemptId` with normal 20-second request deadlines and a 30-minute result deadline. Uncertain polling retains the flow and ID and exposes “查询发布结果”; it never creates a replacement attempt until a terminal failure/auth result permits a fresh snapshot. Unmount only aborts browser polling.

A cancel response reporting exact-session `done` is now mapped to `cancel-not-applied` with bounded guidance “授权已完成，但发布未继续，请重新提交”; it no longer renders the false “正在继续发布” state.

### TDD evidence

RED observed:

- Server tests failed because the job registry/router factories did not exist.
- Frontend tests failed because job polling was not exported and snapshots lacked an attempt ID.
- Existing cancel semantics tests exposed the old raced-`done` contract.

GREEN verification:

- Server auth + reference suite: 84/84 pass.
- Full web suite: 79/79 pass.
- Web lint exits 0 with 15 existing warnings and no errors.
- Vite build succeeds with 49 modules transformed.
- `git diff --check` and syntax checks pass.

### Remaining concerns

The registry is intentionally process-local: server restart loses status and multi-process deployments do not share jobs. No real CLI/network operation was used; all new coverage uses fakes. Browser interaction was not exercised live.

## Hardened architecture review closure — 2026-11-12

Closed the remaining 7 Important and 4 Minor findings from the hardened review on top of `92c5328`.

### Changes

- Post-dispatch cancellation now retains/adopts the exact server attempt for every auth-cancel outcome and restarts polling with a fresh controller; pre-replay auth cancellation can release normally.
- Structured pre-creation errors are authoritative. Alias saturation returns and registers a bounded canonical recovery identity; the browser adopts the server `attemptId`.
- Deadlines and disposal resolve the public terminal promise exactly once while physical slots remain held until execution settles. Async subprocess abort/timeout now resolves after child close.
- Remote images use a reusable DNS/public-address/redirect policy. Private, loopback, link-local, CGNAT, multicast, unspecified, mapped-private IPv6, credentials, and non-HTTP(S) URLs are rejected with a fixed error.
- Image reads enforce 25 MiB per source and 100 MiB aggregate budgets using streamed remote reads and single-handle local `fstat`/bounded reads; response bodies are cancelled on overflow/abort and Sharp has an explicit pixel cap.
- Canonical title uses the shared 20-character builder constant; content and leading-hash tag normalization also match effective package inputs.
- Existing owner attempt reuse/conflict is resolved before redapp auth, QR candidate paths are deduplicated, and `/videos/` maps to the videos directory.
- Restart loss now gives explicit outcome-unknown guidance and requires an in-memory acknowledgement before a fresh attempt. This process-local limitation remains documented and intentionally uses no localStorage.

### TDD evidence

RED was observed for title suffix equivalence, alias recovery, physical slot retention, disposal completion, QR deduplication, process-close supervision, SSRF ranges/redirects, remote Content-Length/chunk overflow/abort, local oversize, aggregate source budget, authoritative pre-creation responses, canonical attempt adoption, all post-dispatch cancel outcomes, and restart acknowledgement. Each focused suite was then made GREEN.

### Final verification

- Server auth suite: 80/80 pass.
- Server reference + publish/security suites: 51/51 pass.
- Full web suite: 89/89 pass.
- Web lint exits 0 with the same 15 pre-existing warnings and no errors.
- Vite production build succeeds; 49 modules transformed.
- Changed server files pass `node --check`; `git diff --check` passes.

### Concerns

- The registry remains process-local by design. Restart loss is now explicit and requires acknowledgement before a fresh publish.
- DNS is validated before each fetch/redirect hop, as required by the review; Node fetch may resolve the hostname again because no pinned-address dispatcher dependency is present.
- No real network, CLI, login, upload, or phone-preview operation was performed. Online mini-tool documentation was not fetched; the bundled baseline was used conservatively.
- Server dependency installation reports the existing 4 moderate and 1 high advisories; this task did not introduce or remediate them.
