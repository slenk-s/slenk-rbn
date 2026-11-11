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
