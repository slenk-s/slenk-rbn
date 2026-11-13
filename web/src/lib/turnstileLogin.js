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
      supersedeLogin();
      challengeToken = typeof token === 'string' && token.trim() ? token : null;
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
