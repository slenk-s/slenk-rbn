export const LOGIN_REQUEST_TIMEOUT_MS = 30_000;

export function authFlipViewState(phase) {
  return {
    frontActive: phase === 'challenge' || phase === 'success-feedback',
    backActive: phase === 'login',
    cardFlipped: phase === 'flipping-to-login' || phase === 'login'
  };
}

export function moveFocusToChallenge({ activeElement, challengeTarget }) {
  activeElement?.blur?.();
  challengeTarget?.focus?.();
}

export function selectTurnstileSize(contentWidth) {
  return typeof contentWidth === 'number' && Number.isFinite(contentWidth) && contentWidth < 300 ? 'compact' : 'normal';
}

export function createAuthFlipController({
  schedule = globalThis.setTimeout,
  cancel = globalThis.clearTimeout,
  successDelayMs = 450,
  flipDurationMs = 700,
  watchdogMarginMs = 200,
  reducedMotion = false
} = {}) {
  let motionPreference = reducedMotion;
  let currentPhase = 'challenge';
  let pendingHandle = null;
  let transitionGeneration = 0;
  let disposed = false;
  let completionCallback = null;

  function cancelPending() {
    if (pendingHandle !== null) {
      cancel(pendingHandle);
      pendingHandle = null;
    }
  }

  function scheduleGuarded(callback, delay) {
    cancelPending();
    const generation = ++transitionGeneration;
    pendingHandle = schedule(() => {
      if (disposed || generation !== transitionGeneration) return;
      pendingHandle = null;
      callback();
    }, delay);
  }

  function completeFlip(expectedPhase, nextPhase) {
    if (disposed || currentPhase !== expectedPhase) return false;
    cancelPending();
    transitionGeneration += 1;
    currentPhase = nextPhase;
    const callback = completionCallback;
    completionCallback = null;
    callback?.(nextPhase);
    return true;
  }

  return {
    phase() {
      return currentPhase;
    },
    disposed() {
      return disposed;
    },
    challengeSucceeded(onFlipReady) {
      if (disposed || currentPhase !== 'challenge') return false;
      currentPhase = 'success-feedback';
      completionCallback = onFlipReady;
      scheduleGuarded(() => {
        if (motionPreference) {
          currentPhase = 'login';
          const callback = completionCallback;
          completionCallback = null;
          callback?.('login');
          return;
        }
        currentPhase = 'flipping-to-login';
        onFlipReady?.('flipping-to-login');
        scheduleGuarded(() => completeFlip('flipping-to-login', 'login'), flipDurationMs + watchdogMarginMs);
      }, successDelayMs);
      return true;
    },
    flipCompleted() {
      if (currentPhase === 'flipping-to-login') return completeFlip('flipping-to-login', 'login');
      if (currentPhase === 'flipping-to-challenge') return completeFlip('flipping-to-challenge', 'challenge');
      return false;
    },
    returnToChallenge(onChallengeReady) {
      if (disposed || currentPhase === 'challenge' || currentPhase === 'flipping-to-challenge') return false;
      cancelPending();
      transitionGeneration += 1;
      completionCallback = onChallengeReady;
      if (currentPhase === 'success-feedback' || motionPreference) {
        currentPhase = 'challenge';
        const callback = completionCallback;
        completionCallback = null;
        callback?.('challenge');
        return true;
      }
      currentPhase = 'flipping-to-challenge';
      scheduleGuarded(() => completeFlip('flipping-to-challenge', 'challenge'), flipDurationMs + watchdogMarginMs);
      return true;
    },
    setReducedMotion(value) {
      motionPreference = Boolean(value);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      transitionGeneration += 1;
      cancelPending();
      completionCallback = null;
    }
  };
}

export function createLeaveLoginCleanup({ flow, submittingRef, setSubmitting, setError, setUsername, setPassword, scheduleReset }) {
  return () => {
    flow.invalidate();
    submittingRef.current = false;
    setSubmitting(false);
    setError('');
    setUsername('');
    setPassword('');
    scheduleReset();
  };
}

export function createLoginPopStateHandler({ flow, getCurrentPathname, getNextPathname, leaveLogin, setPathname }) {
  return () => {
    const currentPathname = getCurrentPathname();
    const nextPathname = getNextPathname();
    if (flow.stage(currentPathname) === 'login' && nextPathname !== '/login') leaveLogin();
    setPathname(nextPathname);
  };
}

export function createTurnstileLoginFlow() {
  let challengeToken = null;
  let challengeGeneration = 0;
  let loginGeneration = 0;
  let activeLogin = null;

  function supersedeLogin() {
    loginGeneration += 1;
    activeLogin?.controller.abort();
    activeLogin = null;
  }

  function invalidateCurrentChallenge() {
    challengeGeneration += 1;
    challengeToken = null;
    supersedeLogin();
  }

  return {
    beginChallenge() {
      challengeGeneration += 1;
      return challengeGeneration;
    },
    completeChallenge(token, generation = challengeGeneration) {
      if (generation !== challengeGeneration || activeLogin !== null || challengeToken !== null) return false;
      supersedeLogin();
      challengeToken = typeof token === 'string' && token.trim() ? token : null;
      return challengeToken !== null;
    },
    token() {
      return challengeToken;
    },
    stage(pathname) {
      return pathname === '/login' && challengeToken !== null ? 'login' : 'challenge';
    },
    invalidate() {
      invalidateCurrentChallenge();
    },
    invalidateChallenge(generation) {
      if (generation !== challengeGeneration) return false;
      invalidateCurrentChallenge();
      return true;
    },
    beginLogin() {
      if (challengeToken === null || activeLogin !== null) return null;
      const request = {
        generation: ++loginGeneration,
        token: challengeToken,
        controller: new AbortController()
      };
      request.signal = request.controller.signal;
      activeLogin = request;
      return request;
    },
    isCurrentLogin(request) {
      return activeLogin === request
        && request?.generation === loginGeneration
        && !request.signal.aborted;
    },
    finishLogin(request) {
      if (activeLogin !== request) return;
      activeLogin = null;
      loginGeneration += 1;
    }
  };
}

export function persistCurrentLogin({ flow, request, token, persist }) {
  if (!flow.isCurrentLogin(request)) return false;
  persist(token);
  flow.finishLogin(request);
  return true;
}

export function renderTurnstileWidget({ turnstile, container, widgetIdRef, options, onRenderError }) {
  if (!turnstile || !container || widgetIdRef.current !== null) return false;
  try {
    widgetIdRef.current = turnstile.render(container, options);
    return true;
  } catch (error) {
    widgetIdRef.current = null;
    onRenderError(error);
    return false;
  }
}

export function subscribeTurnstileScriptLoad(script, listener) {
  script.addEventListener('load', listener, { once: true });
  return () => script.removeEventListener('load', listener);
}

export function loadTurnstileScript(document, onLoad, onError, {
  timeoutMs = 12_000,
  setTimeout: scheduleTimeout = globalThis.setTimeout,
  clearTimeout: cancelTimeout = globalThis.clearTimeout,
  isReady = null
} = {}) {
  let script = document.querySelector('script[data-turnstile]');
  if (script?.dataset.turnstileState === 'failed') {
    script.remove();
    script = null;
  }
  if (!script) {
    script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    script.dataset.turnstile = '';
    script.dataset.turnstileState = 'loading';
    document.head.appendChild(script);
  }

  let settled = false;
  let timer = null;
  const cleanup = () => {
    script.removeEventListener('load', loaded);
    script.removeEventListener('error', failed);
    if (timer !== null) {
      cancelTimeout(timer);
      timer = null;
    }
  };
  const settle = (state, callback) => {
    if (settled) return;
    settled = true;
    script.dataset.turnstileState = state;
    cleanup();
    callback();
  };
  const loaded = () => {
    if (isReady && !isReady()) {
      settle('failed', onError);
      return;
    }
    settle('loaded', onLoad);
  };
  const failed = () => settle('failed', onError);

  if (script.dataset.turnstileState === 'loaded') {
    failed();
  } else {
    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });
    timer = scheduleTimeout(failed, timeoutMs);
  }

  return { script, cleanup };
}
