const STRING_AUTH_FIELDS = [
  'sessionId',
  'status',
  'qrImage',
  'authorizeUrl',
  'userCode'
];

const TERMINAL_ERRORS = {
  failed: ['AUTH_FAILED', '授权失败'],
  expired: ['AUTH_EXPIRED', '授权会话已过期'],
  cancelled: ['AUTH_CANCELLED', '授权已取消'],
  'not-found': ['AUTH_SESSION_NOT_FOUND', '授权会话不存在或已失效']
};

const ACTIVE_STATUSES = new Set(['waiting_prompt', 'waiting_scan']);
const DISPLAYED_AUTH_FIELDS = [
  'sessionId', 'status', 'qrImage', 'authorizeUrl', 'userCode', 'expiresAt', 'error', 'mode'
];
const RETAINED_TERMINAL_CODES = new Set([
  'AUTH_FAILED', 'AUTH_EXPIRED', 'AUTH_CANCELLED', 'AUTH_SESSION_NOT_FOUND',
  'AUTH_NOT_COMPLETED', 'AUTH_POLL_TIMEOUT'
]);
export const GENERIC_AUTH_DEADLINE_MS = 20_000;
// Server envelope: audits 120s + upload dry/confirm 360s + preview dry/confirm 240s + 180s margin.
export const MINITOOL_PUBLISH_DEADLINE_MS = 900_000;
const SENSITIVE_MESSAGE_MARKERS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'openid',
  'apikey',
  'authorization',
  'bearer',
  'credential',
  'password',
  'secret',
  'credentialpath',
  'credentialfile'
]);

function hasSensitiveMarker(value) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return [...SENSITIVE_MESSAGE_MARKERS].some(marker => normalized.includes(marker));
}

function safeMessage(value, fallback = '请求失败') {
  if (typeof value !== 'string' || !value || hasSensitiveMarker(value)) return fallback;
  return value;
}

function safeAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const auth = {};
  for (const field of STRING_AUTH_FIELDS) {
    if (typeof value[field] === 'string') auth[field] = value[field];
  }
  if (Number.isFinite(value.expiresAt)) auth.expiresAt = value.expiresAt;
  if (value.error == null) auth.error = null;
  else if (typeof value.error === 'string') auth.error = safeMessage(value.error, '');
  return auth;
}

function authFlowError(status, responseStatus = status) {
  const [code, message] = TERMINAL_ERRORS[status] || ['AUTH_NOT_COMPLETED', '授权未完成'];
  return Object.assign(new Error(message), { code, status: responseStatus });
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cancellationError() {
  return Object.assign(new Error('授权轮询已取消'), {
    code: 'AUTH_POLL_CANCELLED',
    status: 'cancelled'
  });
}

function timeoutError() {
  return Object.assign(new Error('授权轮询超时'), {
    code: 'AUTH_POLL_TIMEOUT',
    status: 'timeout'
  });
}

export function createPublishRequestSnapshot({ title, content, tags, images }) {
  return Object.freeze({
    title: String(title),
    content: String(content),
    tags: Object.freeze([...tags]),
    images: Object.freeze([...images])
  });
}

export function createPublishFlow({ request, generation }) {
  return {
    controller: new AbortController(),
    request,
    generation,
    sessionId: null,
    cancelled: false,
    phase: 'publishing'
  };
}

export function canCommitPublishFlow(current, flow, generation = flow?.generation) {
  return current === flow
    && flow?.generation === generation
    && !flow.cancelled
    && flow.phase !== 'cancelling'
    && flow.phase !== 'terminal'
    && !flow.controller.signal.aborted;
}

export function mergeDisplayedAuth(previous, current) {
  if (!previous || !current || previous.sessionId !== current.sessionId) return previous;
  const next = { ...previous, ...current };
  return DISPLAYED_AUTH_FIELDS.every(field => Object.is(previous[field], next[field])) ? previous : next;
}

export function publishAuthTerminal(error, { replay = false } = {}) {
  if (replay && error?.code === 'AUTH_REQUIRED') {
    return { status: 'failed', error: safeMessage(error.message, '重新发布仍需授权') };
  }
  if (!RETAINED_TERMINAL_CODES.has(error?.code)) return null;
  return {
    status: error.code === 'AUTH_SESSION_NOT_FOUND' || error.status === 404 ? 'not-found'
      : error.code === 'AUTH_POLL_TIMEOUT' ? 'timeout'
        : error.status,
    error: safeMessage(error.message, '授权未完成')
  };
}

export function interpretCancelResponse(sessionId, response) {
  if (response?.sessionId !== sessionId) {
    return {
      cancelled: false,
      status: 'not-found',
      error: '取消结果与当前授权会话不一致，请重新提交。'
    };
  }
  if (response.status === 'cancelled') return { cancelled: true };
  return {
    cancelled: false,
    status: response.status || 'failed',
    error: response.status === 'done'
      ? '取消未生效，授权已完成，请重新提交。'
      : '取消未生效，授权会话状态已变化，请重新提交。'
  };
}

export function createRedappFetchAdapter({ apiBase, token, fetchImpl = fetch, getSignal, deadlineMs = GENERIC_AUTH_DEADLINE_MS }) {
  return async (path, options = {}) => {
    const deadline = new AbortController();
    const callerSignal = typeof getSignal === 'function' ? getSignal() : getSignal;
    const timeoutReason = new DOMException(`Request exceeded ${deadlineMs}ms`, 'TimeoutError');
    const timer = setTimeout(() => deadline.abort(timeoutReason), deadlineMs);
    let signal = deadline.signal;
    let cleanup = () => {};
    if (callerSignal && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([callerSignal, deadline.signal]);
    } else if (callerSignal) {
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
      return await fetchImpl(apiBase + path, {
        ...options,
        signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(options.headers || {})
        }
      });
    } finally {
      clearTimeout(timer);
      cleanup();
    }
  };
}

export async function readApiError(response) {
  const body = await response.json().catch(() => ({}));
  const error = new Error(safeMessage(
    typeof body?.error === 'string' && body.error
      ? body.error
      : response.statusText || '请求失败'
  ));
  error.code = typeof body?.code === 'string' && body.code ? body.code : 'API_ERROR';
  error.status = response.status;
  const auth = safeAuth(body?.auth);
  if (auth) error.auth = auth;
  return error;
}

async function readResponse(response) {
  if (!response || typeof response !== 'object' || typeof response.json !== 'function') {
    return response;
  }
  if (!response.ok) throw await readApiError(response);
  return response.json();
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(cancellationError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(cancellationError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withPollingDeadline(promise, { signal, remainingMs }) {
  if (signal?.aborted) return Promise.reject(cancellationError());
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (handler, value) => {
      cleanup();
      handler(value);
    };
    const onAbort = () => finish(reject, cancellationError());
    timer = setTimeout(() => finish(reject, timeoutError()), Math.max(0, remainingMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

export function createRedappAuthClient({ api, pollMs = 1000 }) {
  if (typeof api !== 'function') throw new TypeError('api must be a function');
  const interval = Number.isFinite(pollMs) && pollMs >= 0 ? pollMs : 1000;

  async function request(path, options) {
    return readResponse(await api(path, options));
  }

  const status = () => request('/api/redapp/auth');
  const login = () => request('/api/redapp/auth/login', { method: 'POST' });
  const session = id => request(`/api/redapp/auth/session/${encodeURIComponent(id)}`);
  const cancel = id => request(`/api/redapp/auth/session/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  const logout = () => request('/api/redapp/auth/logout', { method: 'POST' });

  async function pollSession(id, { signal, timeoutMs = 10 * 60 * 1000, onUpdate = () => {} } = {}) {
    if (!isNonemptyString(id)) throw authFlowError('not-found');
    const startedAt = Date.now();
    while (true) {
      if (signal?.aborted) throw cancellationError();
      const elapsed = Date.now() - startedAt;
      if (timeoutMs <= elapsed) throw timeoutError();

      let current;
      try {
        current = await withPollingDeadline(session(id), {
          signal,
          remainingMs: timeoutMs - elapsed
        });
      } catch (error) {
        if (error?.status === 404) throw authFlowError('not-found', 404);
        throw error;
      }

      if (typeof current?.sessionId !== 'string' || current.sessionId !== id) {
        throw authFlowError('not-found');
      }
      await onUpdate(current);
      if (current?.status === 'done') return current;
      if (TERMINAL_ERRORS[current?.status]) throw authFlowError(current.status);
      if (!ACTIVE_STATUSES.has(current?.status)) throw authFlowError(current?.status);

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw timeoutError();
      await delay(Math.min(interval, remainingMs), signal);
    }
  }

  return { status, login, session, cancel, logout, pollSession };
}

export async function publishWithAuth({
  publish,
  pollSession,
  onAuthRequired = () => {},
  onAuthorized = () => {}
}) {
  try {
    return await publish();
  } catch (error) {
    const sessionId = error?.auth?.sessionId;
    if (error?.code !== 'AUTH_REQUIRED') throw error;
    if (!isNonemptyString(sessionId)) throw authFlowError('not-found');

    await onAuthRequired(error.auth);
    let session;
    try {
      session = await pollSession(sessionId);
    } catch (pollError) {
      if (pollError?.code === 'AUTH_POLL_CANCELLED') {
        throw Object.assign(new Error('授权未完成'), {
          code: 'AUTH_NOT_COMPLETED',
          status: 'cancelled'
        });
      }
      throw pollError;
    }
    if (typeof session?.sessionId !== 'string' || session.sessionId !== sessionId) {
      throw authFlowError('not-found');
    }
    if (session?.status !== 'done') throw authFlowError(session?.status);

    await onAuthorized(session);
    return publish();
  }
}
