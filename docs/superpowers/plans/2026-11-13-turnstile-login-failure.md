# Turnstile Login Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make users complete Cloudflare Turnstile on `/` before entering the separate `/login` credential page, then accept that fresh challenge token while preserving strict server-side validation and redacted diagnostics.

**Architecture:** Extract Siteverify into a small dependency-injected library that returns `{ ok, reason, details }` without Express coupling. Keep the auth route's public `403 { error: "forbidden" }` contract, but log a redacted reason. Model unauthenticated UI as two SPA URL states: `/` renders only Turnstile, its success callback keeps the fresh token in React memory and moves to `/login`, and any missing/expired/failed token returns to `/` without persistent token storage.

**Tech Stack:** Node.js ESM, Node built-in test runner, Express, React 19, Vite 8, Cloudflare Turnstile Siteverify.

## Global Constraints

- Siteverify remains server-side and fail-closed.
- Successful verification requires `success === true`, `action === "login"`, and a hostname in `TURNSTILE_HOSTNAMES`.
- Never log or expose the Turnstile token or `TURNSTILE_SECRET`.
- Client responses continue to use the generic `403 { error: "forbidden" }` response.
- Do not relax action or hostname checks to make login pass.
- Tokens are single-use; every failed login, expiration, or widget error clears the saved token and returns to `/`.
- `/` renders only the Turnstile challenge; `/login` renders credentials only while a fresh token exists in React memory.
- Never persist the Turnstile token in URL state, localStorage, sessionStorage, or cookies.
- Direct navigation or refresh on `/login` without an in-memory token replaces the route with `/`.

---

## File Map

- Create `server/src/lib/turnstile.js`: validate configuration, call Siteverify, classify results, and return redacted diagnostics.
- Create `server/test/turnstile.test.mjs`: unit tests for valid, Cloudflare rejection, action/hostname mismatch, and transport failure.
- Modify `server/src/routes/auth.js`: call the library, preserve the response contract, and log only redacted diagnostics.
- Create `web/src/lib/turnstileLogin.js`: pure two-stage auth flow state used by the React widget callbacks and route transitions.
- Create `web/test/turnstileLogin.test.mjs`: token and `/` → `/login` lifecycle regression tests.
- Modify `web/src/App.jsx`: render a Turnstile-only `/` page, switch to the credential-only `/login` page after callback success, and return to `/` on every token-invalidating outcome.

### Task 1: Server-side Siteverify classifier

**Files:**
- Create: `server/src/lib/turnstile.js`
- Test: `server/test/turnstile.test.mjs`

**Interfaces:**
- Consumes: `verifyTurnstile({ token, secret, expectedAction, expectedHostnames, remoteIp, fetchImpl })`.
- Produces: `Promise<{ ok: true } | { ok: false, reason: string, details?: object }>`; `details` may contain only `errorCodes`, `action`, `hostname`, or `status`.

- [ ] **Step 1: Write failing tests**

Cover a valid response, `invalid-input-response`, action mismatch, hostname mismatch, and a thrown fetch. Assert the fetch body contains the supplied response token, while returned diagnostics never contain the token or secret.

- [ ] **Step 2: Verify RED**

```bash
npm --prefix server test -- --test-name-pattern="Turnstile"
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/turnstile.js`.

- [ ] **Step 3: Implement the minimal classifier**

Validate the token length, secret, and non-empty hostname set. POST URL-encoded fields to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a 10-second abort signal. Return these reasons: `invalid_config`, `siteverify_transport`, `siteverify_rejected`, `action_mismatch`, `hostname_mismatch`; return `{ ok: true }` only after every strict check passes.

- [ ] **Step 4: Verify GREEN**

```bash
npm --prefix server test -- --test-name-pattern="Turnstile"
```

Expected: all Turnstile tests PASS.

### Task 2: Auth route redacted diagnostics

**Files:**
- Modify: `server/src/routes/auth.js:8-58`
- Test: `server/test/turnstile.test.mjs`

**Interfaces:**
- Consumes: `verifyTurnstile(...)` from Task 1.
- Produces: unchanged login API behavior; logs `Turnstile verification rejected` plus redacted `reason/details` only.

- [ ] **Step 1: Add a failing redaction assertion**

Export `formatTurnstileDiagnostic(result)` from the library. Assert `JSON.stringify(formatTurnstileDiagnostic(result))` excludes test token/secret values and retains only the allowed diagnostic keys.

- [ ] **Step 2: Verify RED**

```bash
npm --prefix server test -- --test-name-pattern="Turnstile"
```

Expected: FAIL because `formatTurnstileDiagnostic` is absent.

- [ ] **Step 3: Wire the route**

Replace the route-local Siteverify implementation with the library call. On failure, call `console.warn('Turnstile verification rejected', formatTurnstileDiagnostic(result))`, return generic `403`, and do not run credential checks.

- [ ] **Step 4: Verify GREEN**

```bash
npm --prefix server test -- --test-name-pattern="Turnstile"
```

Expected: all Turnstile tests PASS.

### Task 3: Two-stage frontend verification and login flow

**Files:**
- Create: `web/src/lib/turnstileLogin.js`
- Create: `web/test/turnstileLogin.test.mjs`
- Modify: `web/src/App.jsx:1833-1923`

**Interfaces:**
- Produces: `createTurnstileLoginFlow()` with `completeChallenge(token)`, `token()`, `stage(pathname)`, and `invalidate()`.
- `stage(pathname)` returns `login` only when pathname is `/login` and a fresh in-memory token exists; otherwise it returns `challenge`.
- React callbacks: `callback(token)` saves the fresh token and navigates to `/login`; `expired-callback` and `error-callback` invalidate and replace the URL with `/`; every caught login failure invalidates, resets, and returns to `/`.

- [ ] **Step 1: Write failing lifecycle tests**

Assert the flow starts at `challenge`, a valid callback token permits `stage('/login') === 'login'`, `invalidate()` prevents token reuse, whitespace/non-string values do not unlock login, and direct `/login` access without a token remains at `challenge`. Assert the helper does not call or depend on browser persistent storage.

- [ ] **Step 2: Verify RED**

```bash
npm --prefix web test -- --test-name-pattern="Turnstile two-stage login"
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/turnstileLogin.js`.

- [ ] **Step 3: Implement the flow helper and separate screens**

Create one flow object in a React ref. Split the existing unauthenticated UI into `TurnstileChallenge` (brand plus widget only) and `CredentialsLogin` (brand plus username/password only). On Turnstile success, call `completeChallenge(token)`, update React state, and `history.pushState({}, '', '/login')`. In `App`, direct or refreshed `/login` without a fresh token must call `history.replaceState({}, '', '/')` and render the challenge. Use only `flow.token()` in the final login request; never use `getResponse()` or persistent storage for the challenge token. On invalid credentials, `forbidden`, expiration, or widget error, call `invalidate()`, reset the widget where applicable, replace the URL with `/`, and render the challenge again.

- [ ] **Step 4: Verify GREEN**

```bash
npm --prefix web test -- --test-name-pattern="Turnstile two-stage login"
```

Expected: all matching tests PASS.

### Task 4: Full verification and real-app evidence

**Files:**
- Verify only; fix only defects caused by Tasks 1-3.

- [ ] **Step 1: Run the complete automated suites**

```bash
npm --prefix server test
```

Expected: PASS.

```bash
npm --prefix web test
```

Expected: PASS.

```bash
npm --prefix web run build
```

Expected: Vite build completes successfully.

- [ ] **Step 2: Launch and inspect the app**

Use the repository preview configuration and browser tools. Confirm `/` renders only the challenge, a successful callback changes the URL to `/login` without a document reload, `/login` renders only credentials, and direct/refreshed `/login` returns to `/`. Confirm no console/server errors occur and the final login request includes `cf-turnstile-response`.

- [ ] **Step 3: Exercise one real login and one retry**

Complete a fresh challenge, log in once, and verify success. If the browser is rejected by Cloudflare error `300030`, capture that evidence, inspect the server's redacted diagnostic, and do not claim browser end-to-end success. For an invalid-credentials retry, verify the widget resets and the old token cannot be resubmitted.

- [ ] **Step 4: Review the diff**

```bash
git diff --check
git diff -- server/src/lib/turnstile.js server/src/routes/auth.js server/test/turnstile.test.mjs web/src/lib/turnstileLogin.js web/src/App.jsx web/test/turnstileLogin.test.mjs
```

Expected: no whitespace errors; changes remain limited to the Turnstile login flow and its tests.
