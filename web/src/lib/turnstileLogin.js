export function createTurnstileLoginFlow() {
  let challengeToken = null;
  let loginGeneration = 0;
  let activeLogin = null;

  function supersedeLogin() {
    loginGeneration += 1;
    activeLogin?.controller.abort();
    activeLogin = null;
  }

  return {
    completeChallenge(token) {
      if (activeLogin !== null) return false;
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
      challengeToken = null;
      supersedeLogin();
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

export function loadTurnstileScript(document, onLoad, onError) {
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
  const loaded = () => {
    script.dataset.turnstileState = 'loaded';
    onLoad();
  };
  const failed = () => {
    script.dataset.turnstileState = 'failed';
    onError();
  };
  script.addEventListener('load', loaded, { once: true });
  script.addEventListener('error', failed, { once: true });
  return {
    script,
    cleanup() {
      script.removeEventListener('load', loaded);
      script.removeEventListener('error', failed);
    }
  };
}
