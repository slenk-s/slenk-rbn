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

  async function pollSession(id, { signal, timeoutMs = 10 * 60 * 1000 } = {}) {
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
    const session = await pollSession(sessionId);
    if (typeof session?.sessionId !== 'string' || session.sessionId !== sessionId) {
      throw authFlowError('not-found');
    }
    if (session?.status !== 'done') throw authFlowError(session?.status);

    await onAuthorized(session);
    return publish();
  }
}
