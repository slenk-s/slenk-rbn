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
export const MINITOOL_PUBLISH_DEADLINE_MS = 30 * 60 * 1000;
// 发布 POST（首次与重放）必须覆盖服务端建任务前的最坏窗口：180s 版本门禁 + 120s whoami + 30s 余量。
// 过短的截止会让客户端在服务端即将建任务时放弃，把正常发布误报为 RESTART_UNKNOWN。
// GET 轮询仍走 20s 小截止。
export const MINITOOL_PUBLISH_REQUEST_DEADLINE_MS = 330_000;
// cancelLogin/logout/getStatus 等服务端动作同样要等门禁+CLI，客户端调用给同样的宽截止；
// 即便如此失败时也必须按“结果不确定”处理，因为服务端可能已经执行了动作。
export const REDAPP_GATED_ACTION_DEADLINE_MS = 330_000;
export const RESTART_UNKNOWN_GUIDANCE = '服务已重启，无法确认原任务结果；请先到小红书小工具预览记录核对，再决定是否重新发布。';
export const OUTCOME_UNKNOWN_GUIDANCE = '上传可能已经生效，但本机无法确认最终结果；请先检查小红书小工具的上传记录和预览记录，再决定是否重新发布。';
const AUTHORITATIVE_PRECREATION_CODES = new Set([
  'AUTH_REQUIRED', 'PUBLISH_JOB_CAPACITY', 'PUBLISH_ALIAS_CAPACITY', 'REDAPP_UNAVAILABLE',
  'PUBLISH_ATTEMPT_CONFLICT', 'PUBLISH_VALIDATION', 'PUBLISH_USER_LIMIT'
]);
// cancel-failed 只会出现在从未成功 POST 的分支，刻意不属于已派发阶段；
// 真正的派发历史由 flow.postDispatched 在 mustRecover 表达式里单独 OR 进去。
const POST_DISPATCHED_PHASES = new Set(['replaying', 'job-created', 'job-polling', 'uncertain']);
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

export function createPublishAttemptId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
  if (typeof cryptoImpl?.getRandomValues !== 'function') throw new Error('浏览器不支持安全的发布标识生成');
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

export function createPublishRequestSnapshot({ attemptId, title, content, tags, images, accountId }) {
  const resolvedAttemptId = attemptId || createPublishAttemptId();
  return Object.freeze({
    attemptId: String(resolvedAttemptId),
    title: String(title),
    content: String(content),
    tags: Object.freeze([...tags]),
    images: Object.freeze([...images]),
    // 多账号发布：accountId 必须随快照冻结，授权重放沿用同一账号。
    ...(accountId != null && accountId !== '' ? { accountId: String(accountId) } : {})
  });
}

// ---- 多账号：列表渲染与发布选择器的纯函数（便于单测） ----

export function accountStatusLabel(status) {
  return status === 'bound' ? '已绑定' : '待绑定';
}

export function accountDisplayName(account) {
  const nickname = typeof account?.nickname === 'string' ? account.nickname.trim() : '';
  if (nickname) return nickname;
  if (typeof account?.openIdMasked === 'string' && account.openIdMasked) return account.openIdMasked;
  return '待绑定账号';
}

export function accountLoginHint(account) {
  if (account?.status !== 'bound') return '尚未扫码绑定';
  if (account.loggedIn === true) return account.needsReauth === true ? '需要重新授权' : '已登录';
  return '未登录';
}

// 发布账号选择器只列已绑定账号；待绑定（未扫码）的账号不能作为发布目标。
export function buildPublishAccountOptions(accounts) {
  return (Array.isArray(accounts) ? accounts : [])
    .filter(account => account?.status === 'bound')
    .map(account => {
      // 已绑定账号缺昵称/掩码时回退到账号 id，保证选择器里可区分。
      const display = accountDisplayName(account);
      const base = display === '待绑定账号' ? String(account.id) : display;
      const needsReauth = account.needsReauth === true;
      return {
        id: String(account.id),
        value: String(account.id),
        label: needsReauth ? `${base}（需重新授权）` : base,
        needsReauth
      };
    });
}

export function createPublishFlow({ request, generation }) {
  const flow = {
    controller: new AbortController(),
    request,
    attemptId: request?.attemptId,
    generation,
    continuationGeneration: 0,
    continuation: null,
    sessionId: null,
    cancelled: false,
    phase: 'publishing'
  };
  flow.continuation = createPublishContinuation(flow);
  return flow;
}

export function createPublishContinuation(flow) {
  const token = Object.freeze({ generation: ++flow.continuationGeneration, controller: flow.controller });
  flow.continuation = token;
  return token;
}

export function canCommitPublishFlow(current, flow, generation = flow?.generation, continuation = flow?.continuation) {
  return current === flow
    && flow?.generation === generation
    && flow?.continuation === continuation
    && continuation?.controller === flow.controller
    && !continuation?.controller?.signal.aborted
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
    status: response.status === 'done' ? 'cancel-not-applied' : (response.status || 'failed'),
    error: response.status === 'done'
      ? '授权已完成，正在查询同一次发布结果'
      : '取消未生效，正在查询同一次发布结果。'
  };
}

export function shouldRecoverAttemptAfterCancel(phase) {
  return POST_DISPATCHED_PHASES.has(phase);
}

export function isAuthoritativePrecreationError(error) {
  return AUTHORITATIVE_PRECREATION_CODES.has(error?.code)
    || (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500);
}

export function interpretMiniToolPublishResponse(job, attemptId) {
  const effectiveAttemptId = typeof job?.attemptId === 'string' && job.attemptId ? job.attemptId : attemptId;
  const requestedMatches = job?.requestedAttemptId == null || job.requestedAttemptId === attemptId;
  const uncertain = () => Object.assign(new Error('发布结果暂时无法确认，请查询发布结果'), { code: 'PUBLISH_JOB_UNCERTAIN', attemptId: effectiveAttemptId });
  if (!job || !requestedMatches || (job.attemptId !== attemptId && job.requestedAttemptId == null)) throw uncertain();
  if (job.status === 'queued' || job.status === 'running') return { action: 'poll', attemptId: effectiveAttemptId };
  if (job.status === 'done') return { action: 'done', job };
  if (job.status === 'failed') throw Object.assign(new Error(job.error || '扫码直达发布失败，请重新提交'), { code: 'PUBLISH_JOB_FAILED', attemptId: effectiveAttemptId, status: 'failed' });
  if (job.status === 'failed_after_side_effect') throw Object.assign(new Error(OUTCOME_UNKNOWN_GUIDANCE), { code: 'PUBLISH_JOB_OUTCOME_UNKNOWN', attemptId: effectiveAttemptId, status: job.status });
  throw uncertain();
}

export async function recoverInitialPublish({ attemptId, post, poll, onAttemptId = () => {} }) {
  let job;
  try { job = await post(); }
  catch (cause) {
    if (isAuthoritativePrecreationError(cause)) throw cause;
    try { return await poll(attemptId); }
    catch (pollError) {
      if (pollError?.code) throw pollError;
      throw Object.assign(new Error('发布结果暂时无法确认，请查询发布结果'), { code: 'PUBLISH_JOB_UNCERTAIN', attemptId, cause });
    }
  }
  const decision = interpretMiniToolPublishResponse(job, attemptId);
  if (decision.attemptId && decision.attemptId !== attemptId) onAttemptId(decision.attemptId);
  return decision.action === 'done' ? decision.job : poll(decision.attemptId);
}

export async function pollMiniToolPublishJob({
  attemptId,
  request,
  signal,
  pollMs = 1000,
  timeoutMs = MINITOOL_PUBLISH_DEADLINE_MS
}) {
  const startedAt = Date.now();
  const path = `/api/publish/minitool/jobs/${encodeURIComponent(attemptId)}`;
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw cancellationError();
    let job;
    try {
      job = await request(path);
    } catch (cause) {
      if (cause?.status === 404) {
        throw Object.assign(new Error(RESTART_UNKNOWN_GUIDANCE), {
          code: 'PUBLISH_JOB_RESTART_UNKNOWN', attemptId, cause
        });
      }
      throw Object.assign(new Error('发布结果暂时无法确认，请查询发布结果'), {
        code: 'PUBLISH_JOB_UNCERTAIN', attemptId, cause
      });
    }
    const decision = interpretMiniToolPublishResponse(job, attemptId);
    if (decision.action === 'done') return decision.job;
    await delay(pollMs, signal);
  }
  throw Object.assign(new Error('发布结果暂时无法确认，请查询发布结果'), {
    code: 'PUBLISH_JOB_UNCERTAIN', attemptId
  });
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

function withAccountQuery(path, accountId) {
  if (!isNonemptyString(accountId)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}accountId=${encodeURIComponent(accountId)}`;
}

export function createRedappAuthClient({ api, pollMs = 1000 }) {
  if (typeof api !== 'function') throw new TypeError('api must be a function');
  const interval = Number.isFinite(pollMs) && pollMs >= 0 ? pollMs : 1000;

  async function request(path, options) {
    return readResponse(await api(path, options));
  }

  // accountId 走 query（服务端按 ?accountId= 鉴权），其余 options 原样透传给 fetch 适配器。
  const splitAccount = ({ accountId, ...rest } = {}) => ({ accountId, rest });

  const status = (options = {}) => {
    const { accountId, rest } = splitAccount(options);
    return request(withAccountQuery('/api/redapp/auth', accountId), rest);
  };
  const login = (options = {}) => {
    const { accountId, rest } = splitAccount(options);
    return request(withAccountQuery('/api/redapp/auth/login', accountId), { method: 'POST', ...rest });
  };
  const session = (id, options = {}) => {
    const { accountId, rest } = splitAccount(options);
    return request(withAccountQuery(`/api/redapp/auth/session/${encodeURIComponent(id)}`, accountId), rest);
  };
  const cancel = (id, options = {}) => {
    const { accountId, rest } = splitAccount(options);
    return request(withAccountQuery(`/api/redapp/auth/session/${encodeURIComponent(id)}/cancel`, accountId), { method: 'POST', ...rest });
  };
  const logout = (options = {}) => {
    const { accountId, rest } = splitAccount(options);
    return request(withAccountQuery('/api/redapp/auth/logout', accountId), { method: 'POST', ...rest });
  };

  const listAccounts = (options = {}) => request('/api/redapp/accounts', options);
  const createAccount = (options = {}) => request('/api/redapp/accounts', { method: 'POST', ...options });
  const deleteAccount = (id, { deleteCredentials = true, ...options } = {}) =>
    request(`/api/redapp/accounts/${encodeURIComponent(id)}?deleteCredentials=${deleteCredentials === false ? 'false' : 'true'}`, { method: 'DELETE', ...options });

  async function pollSession(id, { accountId, signal, timeoutMs = 10 * 60 * 1000, onUpdate = () => {} } = {}) {
    if (!isNonemptyString(id)) throw authFlowError('not-found');
    const startedAt = Date.now();
    let transientFailures = 0;
    while (true) {
      if (signal?.aborted) throw cancellationError();
      const elapsed = Date.now() - startedAt;
      if (timeoutMs <= elapsed) throw timeoutError();

      let current;
      try {
        current = await withPollingDeadline(session(id, { accountId }), {
          signal,
          remainingMs: timeoutMs - elapsed
        });
      } catch (error) {
        // 只有 404（会话确已不存在）/取消/整体超时是立即终止；
        // 瞬时失败（重启中的连接错误、单次 5xx、单次请求超时）在会话预算内按有界退避重试，
        // 避免一次网络抖动就放弃整个发布流程而服务端授权仍在继续。
        if (error?.status === 404) throw authFlowError('not-found', 404);
        if (error?.code === 'AUTH_POLL_CANCELLED' || error?.code === 'AUTH_POLL_TIMEOUT') throw error;
        transientFailures += 1;
        const backoffMs = Math.min(Math.max(interval, 100) * transientFailures, 5000);
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) throw timeoutError();
        await delay(Math.min(backoffMs, remainingMs), signal);
        continue;
      }
      transientFailures = 0;

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

  return { status, login, session, cancel, logout, pollSession, listAccounts, createAccount, deleteAccount };
}

export async function publishWithAuth({
  publish,
  pollSession,
  onAuthRequired = () => {},
  onAuthorized = () => {},
  accountId
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
      // 授权重放与轮询必须留在发起发布的同一账号上下文。
      session = await pollSession(sessionId, isNonemptyString(accountId) ? { accountId } : undefined);
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
