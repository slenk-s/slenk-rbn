const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;
export const MAX_QR_IMAGE_LENGTH = Math.ceil(2 * 1024 * 1024 / 3) * 4 + 64;

export async function fetchWithDeadline(fetchImpl, input, options = {}, deadlineMs = 20_000) {
  const deadline = new AbortController();
  const callerSignal = options.signal;
  const timeoutError = new DOMException(`Request exceeded ${deadlineMs}ms`, 'TimeoutError');
  const timer = setTimeout(() => deadline.abort(timeoutError), deadlineMs);
  let signal;
  let cleanup = () => {};

  if (!callerSignal) {
    signal = deadline.signal;
  } else if (typeof AbortSignal.any === 'function') {
    signal = AbortSignal.any([callerSignal, deadline.signal]);
  } else {
    const combined = new AbortController();
    const forwardCaller = () => combined.abort(callerSignal.reason);
    const forwardDeadline = () => combined.abort(deadline.signal.reason);
    callerSignal.addEventListener('abort', forwardCaller, { once: true });
    deadline.signal.addEventListener('abort', forwardDeadline, { once: true });
    if (callerSignal.aborted) forwardCaller();
    cleanup = () => {
      callerSignal.removeEventListener('abort', forwardCaller);
      deadline.signal.removeEventListener('abort', forwardDeadline);
    };
    signal = combined.signal;
  }

  try {
    return await fetchImpl(input, { ...options, signal });
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

export function safeAuthorizeUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export function safeQrImage(value) {
  return typeof value === 'string'
    && value.length <= MAX_QR_IMAGE_LENGTH
    && DATA_IMAGE_PATTERN.test(value)
    ? value
    : '';
}

export function formatRemainingTime(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt)) return '等待授权';
  const remaining = Math.ceil((expiresAt - now) / 1000);
  if (remaining <= 0) return '已到期';
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatAuthExpiry(value, { locale = 'zh-CN', timeZone } = {}) {
  if (!Number.isFinite(value)) return '未提供';
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return '未提供';
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    ...(timeZone ? { timeZone } : {})
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
}

export function boundedSessionError(value, maxLength = 240) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function focusNavigationIndex(currentIndex, count, direction) {
  if (count <= 0) return -1;
  if (currentIndex < 0) return direction < 0 ? count - 1 : 0;
  return (currentIndex + direction + count) % count;
}

export function isUsableAuth(auth) {
  return auth?.available === true
    && auth.loggedIn === true
    && auth.needsReauth === false;
}

export function canCommitLifecycle(lifecycle, generation, sessionId = lifecycle.sessionId) {
  return lifecycle.generation === generation && lifecycle.sessionId === sessionId;
}

export function pollLifecycleTransition(lifecycle, sessionId, transferredGeneration) {
  if (Number.isInteger(transferredGeneration)) {
    return lifecycle.generation === transferredGeneration && lifecycle.sessionId === sessionId
      ? { lifecycle, generation: transferredGeneration }
      : { lifecycle, generation: lifecycle.generation, commit: false };
  }
  const generation = lifecycle.generation + 1;
  return { lifecycle: { generation, sessionId }, generation };
}

export function cancelOperationCompletion({ lifecycle, operationGeneration, sessionId, succeeded, responseStatus }) {
  if (!canCommitLifecycle(lifecycle, operationGeneration, sessionId)) {
    return { commit: false, lifecycle, busy: true };
  }
  if (succeeded && responseStatus === 'cancelled') {
    return {
      commit: true,
      lifecycle: { generation: operationGeneration, sessionId: null },
      busy: false
    };
  }
  const generation = operationGeneration + 1;
  return {
    commit: true,
    lifecycle: { generation, sessionId },
    busy: false,
    pollGeneration: generation
  };
}

export function reserveTransferredGeneration(currentGeneration, transferredGeneration) {
  return Number.isInteger(transferredGeneration)
    ? Math.max(currentGeneration, transferredGeneration)
    : currentGeneration;
}

export function cancelSessionStateCompletion({ currentSession, response, transition }) {
  if (currentSession?.sessionId !== response?.sessionId) return { commit: false };
  return {
    session: Number.isInteger(transition.pollGeneration)
      ? { ...response, pollGeneration: transition.pollGeneration }
      : response,
    close: false,
    announceSuccess: false
  };
}

export function authActionPermissions({ auth, activeSession, loading, busy }) {
  const idle = !loading && !busy;
  return {
    connect: idle && Boolean(auth) && !activeSession,
    refresh: idle && !activeSession,
    cancel: idle && activeSession,
    logout: idle && Boolean(auth) && !activeSession
  };
}

export function operationTransition(state, event, generation) {
  if (event === 'start') {
    const nextGeneration = state.generation + 1;
    return { state: { ...state, generation: nextGeneration }, generation: nextGeneration };
  }
  return { state, commit: generation === state.generation };
}

export function pollCompletionTransition(status, refreshedAuth) {
  if (status === 'done') {
    if (isUsableAuth(refreshedAuth)) return { close: true, clearSession: true };
    return {
      status: 'done',
      refreshError: refreshedAuth
        ? '授权完成，但当前账号状态仍不可用'
        : '授权成功，状态刷新失败'
    };
  }
  return { status };
}

export function sessionStatusPresentation(session, auth) {
  const presentations = {
    waiting_prompt: { tone: 'active', label: '准备中' },
    waiting_scan: { tone: 'active', label: '等待扫码' },
    expired: { tone: 'unavailable', label: '已过期' },
    failed: { tone: 'unavailable', label: '失败' },
    cancelled: { tone: 'idle', label: '已取消' },
    done: { tone: 'warning', label: '成功待刷新' },
    'not-found': { tone: 'unavailable', label: '已失效' }
  };
  return session && presentations[session.status]
    ? presentations[session.status]
    : authStatusPresentation(auth);
}

export function authStatusPresentation(auth) {
  if (!auth) return { tone: 'unknown', label: '状态未知' };
  if (!auth.available) return { tone: 'unavailable', label: 'CLI 不可用' };
  if (auth.loggedIn && auth.needsReauth) return { tone: 'warning', label: '需要重新授权' };
  if (auth.loggedIn) return { tone: 'connected', label: '已连接' };
  return { tone: 'idle', label: '未连接' };
}
