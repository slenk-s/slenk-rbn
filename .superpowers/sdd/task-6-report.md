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

## Final hardening re-review fixes — 2026-11-12

Closed all 7 Important and 3 Minor findings from `task-6-final-rereview.md`.

### Implementation

- I1/I2: remote image transport now uses Node `http`/`https` with an injected lookup callback pinned to each validated address set, preserving URL Host and TLS SNI on every redirect. DNS lookup races the same image/job signal; an aborted lookup cannot start transport when it resolves late.
- I3: async process execution now starts a Unix process group where supported, requests graceful termination, escalates after 2 seconds to Windows `taskkill /T /F` or POSIX group `SIGKILL`, and reaches a safe supervisor terminal bound after a further 3 seconds without exposing diagnostics.
- I4: publish continuations carry immutable generation/controller tokens. Every replacement controller installs a new token; delayed catches and commits from an aborted token cannot mutate same-attempt recovery.
- I5/I6: alias saturation never evicts an issued alias; unregistered saturated requests receive the canonical identity. Owner+fingerprint retained work is resolved before auth for new attempt IDs.
- I7: jobs record upload side-effect entry and retain `failed_after_side_effect` fingerprints with safe unknown-outcome guidance, preventing automatic re-upload after preview/QR failure. Pre-upload failures still release their fingerprint.
- M1: per-attempt build directories, ZIPs, preview JSON, and QR files are removed in `finally`; a bounded startup janitor removes owned-root crash leftovers without traversing outside the build root.
- M2: canonicalization and builder share Unicode-code-point-safe `effectiveMiniToolTitle`; emoji at the 20-character boundary remains intact.
- M3: server QR reads are capped at 512 KiB instead of 2 MiB, reducing the 100-record worst-case base64 retention while preserving controlled data-URL delivery.

### TDD and verification evidence

RED was observed for DNS transport pinning and stalled lookup abort, process escalation/supervisor bound, stale continuation isolation, live-alias preservation, pre-auth fingerprint reuse, post-upload failure retention, Unicode boundary truncation, and artifact cleanup. Focused suites then passed: server 56/56 and web flow 54/54.

Final verification:

- `TEST_DATABASE_URL=... DATABASE_URL=... node --test server/test/redappAuth.test.mjs server/test/referenceImages.test.mjs server/test/publishJobs.test.mjs server/test/safeRemoteImage.test.mjs server/test/minitoolBuild.test.mjs`: 141/141 pass. The fake unreachable DB URLs prevent any real database/network operation.
- `npm --prefix web test`: 90/90 pass.
- `npm --prefix web run lint`: exits 0 with the same 15 pre-existing `App.jsx` warnings and no errors.
- `npm --prefix web run build`: succeeds; 49 modules transformed.
- `node --check` on all changed server production files: passes.
- `git diff --check`: passes (Git reports only existing LF-to-CRLF checkout notices).

No real redapp CLI, login, upload, preview, or remote image request was executed. The initial broad `npm --prefix server test -- --test-name-pattern=...` command also discovered scripts outside the requested suites and failed because `DATABASE_URL` was absent; the explicit five-suite command above is the authoritative server verification and passed completely.

## Second final review repair — 2026-11-12

Closed I1–I8 and M1–M2 from `task-6-second-rereview.md`.

### Per-finding disposition

- **I1:** Pinned lookup now implements scalar and `{ all: true }` callback contracts. A real local Node HTTP transport test proves one resolver call, pinned socket address, preserved Host, and abort cleanup without external network.
- **I2:** Cancellation immediately targets the whole Windows tree or POSIX process group, escalates to force after grace, and ignores leader close until tree supervision confirms termination or reaches the bounded supervisor result. Commands remain array-based, async, and output-bounded.
- **I3:** Address classification rejects site-local, translated, NAT64, 6to4, Teredo, mapped, and ordinary non-global IPv4/IPv6 destinations while retaining public IPv4/IPv6.
- **I4:** Upload gate, CLI entry verification, dry run, and plan parsing remain pre-side-effect. The marker is called by the gated command runner immediately before confirm process dispatch.
- **I5:** `failed_after_side_effect` records are not capacity-evicted during retention; saturated admission fails while exact ID and owner+fingerprint recovery stay authoritative. Explicit owner-scoped acknowledgement retires the protected tombstone.
- **I6:** The browser has a distinct terminal `outcome-unknown` phase, upload/preview-record guidance, no terminal polling claim or automatic resubmit, and an authenticated acknowledgement before a fresh in-memory attempt.
- **I7:** Artifact cleanup exceptions cannot replace successful DTOs; locked leftovers remain for bounded startup cleanup.
- **I8:** Alias saturation rejects the unregistered identity with authoritative `PUBLISH_ALIAS_CAPACITY`; the browser does not poll it, and existing aliases remain recoverable. The ninth-alias test covers lost-response safety by proving no acceptance/registration occurs.
- **M1:** POSIX PATH prepends `<prefix>/bin`; Windows retains `<prefix>`.
- **M2:** Startup janitor inspects owned-root metadata and chooses the bounded oldest candidates, skipping symlinks so stale tails cannot starve.

### RED/GREEN evidence

RED was observed for the real Node lookup contract, Windows leader-close supervision, special IPv6 forms, upload boundary placement, protected-record capacity, terminal unknown UX, cleanup exception isolation, saturated ninth alias, POSIX PATH, and fair janitor selection. The focused repaired server and web suites subsequently passed.

### Final verification

- `TEST_DATABASE_URL=... DATABASE_URL=... node --test server/test/redappAuth.test.mjs server/test/referenceImages.test.mjs server/test/publishJobs.test.mjs server/test/safeRemoteImage.test.mjs server/test/minitoolBuild.test.mjs`: **159/159 pass**.
- `npm --prefix web test`: **91/91 pass**.
- `npm --prefix web run lint`: exits 0 with the existing **15 App.jsx warnings**, no errors.
- `npm --prefix web run build`: succeeds; **49 modules transformed**.
- `node --check` for all changed server production files: passes.
- `git diff --check`: passes; Git reports only LF-to-CRLF checkout notices.

No real redapp login/upload/preview or external network operation was performed. Local controlled HTTP sockets and injected process/CLI fakes provided deterministic transport and cancellation coverage.

## Third final review repair — 2026-11-12

Closed all 7 Important (N1–N7) and 6 Minor (N8–N13) findings from `task-6-third-rereview.md` on top of `bd71325`.

### Per-finding disposition

- **N1:** `cleanup()` no longer TTL-evicts `failed_after_side_effect` tombstones; the lifetime is documented inline (never TTL/capacity-evicted, retired only by owner-scoped `acknowledgeUnknown`, bounded by `maxEntries` fail-closed capacity). Regression test: +31 min `cleanup()` retains the record, same-fingerprint resubmit pre-acknowledgement returns the tombstone DTO with no second upload, and acknowledgement still retires it.
- **N2:** `isPublicAddress` now rejects the deprecated `::/96` IPv4-compatible remainder (`groups[0..5]` all zero, covering `::`/`::1`/`::7f00:1`-style embeddings of private *and* public IPv4 — policy decision: block the entire deprecated space) and discard-only `100::/64` (RFC 6666). Blocked matrix extended with `::127.0.0.1`, `::7f00:1`, `::10.0.0.1`, `::192.168.1.1`, `::169.254.1.1`, `::8.8.8.8` (blocked), `100::1`, plus a hostile-DNS-AAAA fetch test proving no transport is attempted.
- **N3:** `releaseChild` now marks `session.released`; a late `attachChild` kills the late child, re-nulls state, and returns; `feedStream`/`closeHandler` guard on `released` and `session.streams?.[name]`. Regression tests: pending spawn → logout → resolve spawn → emit output/close (no throw, child killed, session gone) and pending spawn → dispose → resolve spawn (child killed, no listeners attached).
- **N4:** the async runner salvages a raced success: when termination is in progress and the child closes 0 with a complete `RESULT_JSON` `status:"ok"` in captured stdout, it resolves `{ status: 0, error: null }` so publish records `done` instead of `failed_after_side_effect`; an unsuccessful close-0 still settles as `process_termination_unconfirmed` at the supervisor bound. Both paths tested with an injected failing `terminateTree` on the win32 path.
- **N5:** new `MINITOOL_PUBLISH_REQUEST_DEADLINE_MS = 330_000` (gate 180 s + whoami 120 s + 30 s margin) backs the publish POST (initial and replay) and the publish-flow cancel; GET polls keep the 20 s deadline; the deadline test now asserts the exact 30-minute `MINITOOL_PUBLISH_DEADLINE_MS` and the ≥300 s POST envelope. Dashboard `status/login/cancel/logout` use `REDAPP_GATED_ACTION_DEADLINE_MS` via per-call `deadlineMs`, and their failure wording stays outcome-uncertain (“可能仍在进行”/“没有被确认移除”).
- **N6:** `pollSession` tolerates transient failures (non-404, non-cancel, non-timeout) with bounded linear backoff (`max(interval,100) * failures`, capped 5 s) inside the session budget; 404/cancel/budget-timeout remain immediate. The dashboard `pollExactSession` applies the same policy via `dashboardPollFailureDisposition` with a 10-minute budget and 1.5 s→5 s backoff. Tests: transient-then-done succeeds, persistent failure ends in `AUTH_POLL_TIMEOUT`, 404 stays immediate, cancel wins over backoff.
- **N7:** `'cancel-failed'` removed from `POST_DISPATCHED_PHASES`; a test pins that a `cancel-failed` phase never triggers recovery/uncertain for a never-dispatched attempt (actual dispatch history remains `flow.postDispatched`, OR-ed at the call site).
- **N8:** `redappAuth.js` imports `node:crypto`; a test exercises the default `randomId` (UUID session id without injection).
- **N9:** `janitorMiniToolArtifacts` accepts a `root` parameter; janitor tests use `fs.mkdtempSync` isolation; the module-level invocation was removed and the janitor now runs once from `server/src/index.js` startup inside try/catch, so imports/tests never touch real storage.
- **N10:** `projectAuthStatus` always recomputes `needsReauth` from `loggedIn`/`expireTimeMs` (manager passes its injected `now`), and `publicSession` reprojects retained session auth at read time. Tests: past-expiry with stored `needsReauth:false` projects `true`; a session expiring inside the retention window flips to `needsReauth:true` on read.
- **N11:** `toDto` spreads `job.result` first, then authoritative identity/status; a hostile result cannot inject `attemptId`/`requestedAttemptId`/`status` (test with hostile keys).
- **N12:** the janitor deletes every genuinely-expired entry per run (O(n) metadata, `maxEntries` retained only as a defensive guard defaulting to unlimited), symlinks still skipped; a 130-expired-entry test proves full convergence in one run.
- **N13:** the `failed_after_side_effect` DTO surfaces a sanitized `uploadReceipt` (`fileId`/`md5` strings only, bounded; dropped when absent); test proves no raw/path fields leak.

### RED/GREEN evidence

RED observed before implementation: server — tombstone TTL test, hostile-result DTO test, sanitized-receipt test, 7 new SSRF matrix entries + hostile-AAAA test, 2 janitor tests (root param ignored, >100 expired stranded), logout-during-spawn crash test, termination-salvage test (hangs pre-fix; bounded with `--test-timeout` for observation), 2 needsReauth projection tests. Web — missing exports (`MINITOOL_PUBLISH_REQUEST_DEADLINE_MS`, `dashboardPollFailureDisposition`) failed both suites at import; poll-tolerance/cancel-failed tests failed. GREEN after implementation as below. One incidental regression during repair (an added bare `catch {` widened an existing source-regex test's match) was restructured to a `.then(() => true, () => false)` wait guard.

### Final verification

- `TEST_DATABASE_URL=... DATABASE_URL=... node --test server/test/redappAuth.test.mjs server/test/referenceImages.test.mjs server/test/publishJobs.test.mjs server/test/safeRemoteImage.test.mjs server/test/minitoolBuild.test.mjs`: **179/179 pass** (fake unreachable DB URLs; no real database/network).
- `npm --prefix web test`: **99/99 pass**.
- `npm --prefix web run lint`: exits 0 with the same **15 pre-existing `App.jsx` warnings**, no errors.
- `npm --prefix web run build`: succeeds; **49 modules transformed**.
- `node --check` on all changed server files (`publish.js`, `redappAuth.js`, `redappCli.js`, `safeRemoteImage.js`, `minitoolBuild.js`, `index.js`): passes.
- `git diff --check`: passes (only existing LF-to-CRLF checkout notices).

No real redapp login/upload/preview or external network operation was performed; all new coverage uses fakes and isolated temp directories.
