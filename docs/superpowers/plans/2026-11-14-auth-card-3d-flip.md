# 3D Flip Authentication Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate challenge/login screens with one glassmorphism two-sided card that shows real Turnstile on the front and flips left 180° to the credential form after a visible success pause.

**Architecture:** Extend the existing pure Turnstile flow with a small presentation phase machine while preserving its token/request generations. Render both card faces inside one perspective scene; React controls active/inert semantics, while CSS owns `preserve-3d`, backface hiding, the 450ms success pause, and the 700ms Y-axis transition. Existing Siteverify and server behavior remain unchanged.

**Tech Stack:** React 19, JavaScript ES modules, Node built-in test runner, CSS 3D transforms, Vite 8, Cloudflare Turnstile.

## Global Constraints

- Flip only after the current-generation real Turnstile callback succeeds; a custom box click must never substitute for verification.
- Keep the Turnstile token in React memory only; never write it to URL, localStorage, sessionStorage, or cookies.
- Keep server Siteverify, `action === "login"`, hostname allowlist, single-use token handling, redacted diagnostics, and generic `403 forbidden` unchanged.
- Front and back both render the same S icon, `Slenk Notes`, and `原创笔记图工作台` header.
- Show `✓ 验证成功` for 450ms before a 700ms `rotateY(-180deg)` left flip.
- Hidden/inactive faces must be non-focusable and unavailable to assistive technology.
- Back, expiration, widget errors, login rejection, timeout, abort, and persistence failure clear token and credentials and return to a fresh challenge face.
- Old widget generations and stale login completions remain unable to alter current state.
- `prefers-reduced-motion: reduce` skips the 3D transition while preserving the success feedback and state/security rules.
- Do not add an animation library or modify server files for this visual feature.

---

## File Map

- Modify `web/src/lib/turnstileLogin.js`: add a pure presentation phase controller and animation completion fallback without weakening existing challenge/login generations.
- Modify `web/test/turnstileLogin.test.mjs`: cover success pause, flip phases, reduced motion, stale callbacks, fallback completion, and reverse cleanup.
- Modify `web/src/App.jsx`: render one shared perspective scene with front/back faces, shared headers, success feedback, semantic face isolation, focus transfer, and existing request wiring.
- Modify `web/src/App.css`: implement the glass card, perspective, backface hiding, left 180° transition, responsive sizing, pointer/focus isolation, and reduced-motion rules.
- Create `web/test/authFlipUi.test.mjs`: source/markup contract tests for the shared two-face structure, accessibility attributes, copy, and required CSS primitives.

### Task 1: Presentation phase controller

**Files:**
- Modify: `web/src/lib/turnstileLogin.js`
- Modify: `web/test/turnstileLogin.test.mjs`

**Interfaces:**
- Consumes: the existing `createTurnstileLoginFlow()` token/challenge/login generation API.
- Produces: `createAuthFlipController({ schedule, cancel, successDelayMs = 450, flipDurationMs = 700, reducedMotion = false })` with `phase()`, `challengeSucceeded(onFlipReady)`, `flipCompleted()`, `returnToChallenge(onChallengeReady)`, and `dispose()`.
- Phases: `challenge`, `success-feedback`, `flipping-to-login`, `login`, `flipping-to-challenge`.

- [ ] **Step 1: Write failing phase tests**

Add tests proving:

```js
const queued = [];
const flip = createAuthFlipController({
  schedule: (fn, ms) => { queued.push({ fn, ms }); return queued.length; },
  cancel: () => {}
});
assert.equal(flip.phase(), 'challenge');
flip.challengeSucceeded(() => {});
assert.equal(flip.phase(), 'success-feedback');
assert.equal(queued[0].ms, 450);
queued[0].fn();
assert.equal(flip.phase(), 'flipping-to-login');
flip.flipCompleted();
assert.equal(flip.phase(), 'login');
```

Also cover duplicate success, reverse transition, `dispose()`, 700ms fallback completion, and reduced-motion direct completion after the 450ms feedback.

- [ ] **Step 2: Verify RED**

```bash
node --test --test-name-pattern="auth flip" web/test/turnstileLogin.test.mjs
```

Expected: FAIL because `createAuthFlipController` is not exported.

- [ ] **Step 3: Implement the minimal controller**

Keep all timers injected, cancel outstanding handles on every phase replacement/dispose, permit success only from `challenge`, permit completion only from the matching flipping phase, and make fallback completion idempotent with real `transitionend`.

- [ ] **Step 4: Verify GREEN**

```bash
node --test --test-name-pattern="auth flip" web/test/turnstileLogin.test.mjs
```

Expected: all auth flip controller tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/turnstileLogin.js web/test/turnstileLogin.test.mjs
git commit -m "test: define authentication flip phases"
```

### Task 2: Two-sided React card and lifecycle wiring

**Files:**
- Modify: `web/src/App.jsx:1843-2073`
- Modify: `web/src/lib/turnstileLogin.js`
- Modify: `web/test/turnstileLogin.test.mjs`
- Create: `web/test/authFlipUi.test.mjs`

**Interfaces:**
- Consumes: `createAuthFlipController()` and the existing Turnstile/login flow.
- Produces: one `.auth-flip-scene`, one `.auth-flip-card`, `.auth-face-front`, and `.auth-face-back`; both faces contain `AuthBrand`.
- React phase mapping: front active for `challenge` and `success-feedback`; card rotating for `flipping-to-login`/`flipping-to-challenge`; back active only for `login`.

- [ ] **Step 1: Write failing UI contract tests**

Read `web/src/App.jsx` and assert it contains one flip scene/card, two faces, duplicated `AuthBrand` usage, `aria-hidden`/`inert` control per active face, `✓` and `验证成功`, a transition-end handler, and a username ref for post-flip focus. Assert the old separate top-level `.auth-screen` wrappers in `TurnstileChallenge` and `CredentialsLogin` are removed.

- [ ] **Step 2: Verify RED**

```bash
node --test web/test/authFlipUi.test.mjs
```

Expected: FAIL because the two-face structure and phase semantics do not exist.

- [ ] **Step 3: Render both faces in one card**

Refactor the authentication branch so:

```jsx
<div className="auth-screen">
  <div className="auth-flip-scene">
    <div className={cardClasses} onTransitionEnd={handleFlipTransitionEnd}>
      <section className="auth-card auth-face auth-face-front" aria-hidden={!frontActive} inert={!frontActive ? '' : undefined}>
        <AuthBrand />
        {/* live Turnstile / errors / success box */}
      </section>
      <form className="auth-card auth-face auth-face-back" aria-hidden={!backActive} inert={!backActive ? '' : undefined} onSubmit={login}>
        <AuthBrand />
        {/* credentials and submit */}
      </form>
    </div>
  </div>
</div>
```

Use the current-generation Turnstile callback to enter `success-feedback`, update history to `/login`, wait 450ms, then start flipping. Preserve the widget mounted on the front until invalidation/re-render; do not redeem the token before form submission.

- [ ] **Step 4: Wire completion, focus, and reverse cleanup**

On the card's `transform` transition end, complete only the current flip. When phase becomes `login`, focus the username input. Existing invalidation/Back cleanup must synchronously clear request/token/credentials and request a reverse flip without writing extra history. After reverse completion, create a fresh widget generation. Disable form submission until `login` phase.

- [ ] **Step 5: Verify GREEN**

```bash
node --test web/test/authFlipUi.test.mjs
node --test --test-name-pattern="Turnstile|auth flip" web/test/turnstileLogin.test.mjs
```

Expected: both suites PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.jsx web/src/lib/turnstileLogin.js web/test/turnstileLogin.test.mjs web/test/authFlipUi.test.mjs
git commit -m "feat: add two-sided authentication card"
```

### Task 3: Glass styling, 3D motion, and responsive accessibility

**Files:**
- Modify: `web/src/App.css:1961-2050`
- Modify: `web/test/authFlipUi.test.mjs`

**Interfaces:**
- Consumes: class names and phase classes from Task 2.
- Produces: `perspective`, `transform-style: preserve-3d`, face `backface-visibility: hidden`, back `rotateY(180deg)`, active card `rotateY(-180deg)`, 700ms smooth transition, glass surface, reduced-motion override, and mobile overflow protection.

- [ ] **Step 1: Add failing CSS contract tests**

Assert `App.css` contains the required selectors and declarations:

```js
assert.match(css, /\.auth-flip-scene[\s\S]*perspective:/);
assert.match(css, /\.auth-flip-card[\s\S]*transform-style:\s*preserve-3d/);
assert.match(css, /\.auth-face[\s\S]*backface-visibility:\s*hidden/);
assert.match(css, /\.auth-face-back[\s\S]*rotateY\(180deg\)/);
assert.match(css, /\.is-flipped[\s\S]*rotateY\(-180deg\)/);
assert.match(css, /700ms/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
```

Also require glass background/border/backdrop filter, success box/check styles, inactive pointer isolation, and a small-screen media query.

- [ ] **Step 2: Verify RED**

```bash
node --test web/test/authFlipUi.test.mjs
```

Expected: FAIL on missing CSS primitives.

- [ ] **Step 3: Implement the selected glass direction**

Apply the approved visual direction:

- translucent white gradient surface;
- `backdrop-filter: blur(18px)` with a non-blur fallback background;
- inner highlight and existing purple/deep-blue page background;
- fixed shared card geometry so front/back do not resize during rotation;
- green success row with round check icon and `验证成功`;
- `transition: transform 700ms cubic-bezier(...)` and `transform-origin: center center`;
- inactive face `pointer-events: none` plus React `inert`;
- `overflow-x: clip` and responsive card width/height.

- [ ] **Step 4: Add reduced-motion and mobile behavior**

Under `@media (prefers-reduced-motion: reduce)`, set transition duration to near-zero and remove perspective-heavy visual movement while React still observes the same phase order. Under the mobile breakpoint, reduce padding/radius and keep the card inside `calc(100vw - 32px)`.

- [ ] **Step 5: Verify GREEN**

```bash
node --test web/test/authFlipUi.test.mjs
npm --prefix web test
npm --prefix web run build
```

Expected: UI contract tests and complete web suite PASS; Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.css web/test/authFlipUi.test.mjs
git commit -m "style: add glass 3D authentication flip"
```

### Task 4: Browser verification and final review

**Files:**
- Verify all changed frontend files; fix only defects within this feature.

- [ ] **Step 1: Start the existing API and web preview**

Use `.claude/launch.json` via browser preview tools. Reuse existing servers if current; otherwise start `server` and `web`.

- [ ] **Step 2: Verify initial and guarded routes**

Confirm `/` shows only the front face and real Turnstile state. Direct `/login` without memory token replaces to `/`, shows no password field, and persists no challenge token.

- [ ] **Step 3: Exercise controlled flip states**

Because automated browsers may receive Cloudflare `300030`, use the test seam/controller in a browser-safe development verification path only if needed; never add a production bypass. Capture evidence for success box visibility, 450ms pause, left 180° rotation, final back face, username focus, Back reverse transition, and stale callback isolation.

- [ ] **Step 4: Verify accessibility and responsive behavior**

Use snapshots/inspection to confirm only the active face is accessible/focusable. Check mobile width and `prefers-reduced-motion: reduce`; reset viewport and color scheme afterward.

- [ ] **Step 5: Check runtime output**

Confirm no new console errors, failed requests, or server errors. Run:

```bash
npm --prefix web test
npm --prefix web run build
git diff --check
```

Expected: all pass.

- [ ] **Step 6: Request final code review**

Review the complete branch against `docs/superpowers/specs/2026-11-14-auth-card-3d-flip-design.md`, including security, animation state races, accessibility, reduced motion, responsive layout, and test validity. Fix all Critical/Important findings and re-review to READY.
