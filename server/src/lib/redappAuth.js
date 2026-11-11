import { StringDecoder } from 'node:string_decoder';
import { parseTaggedOutput } from './redappCli.js';

const ACTIVE_STATUSES = new Set(['waiting_prompt', 'waiting_scan']);
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const MAX_LOGIN_SECONDS = 600;
const MAX_LOGIN_OUTPUT_LINE_LENGTH = 64 * 1024;
const CLOSED_ERROR_MESSAGE = '授权管理器已关闭';
const MAX_MASKED_OPEN_ID_LENGTH = 512;

function finiteNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function projectAuthStatus(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const loggedIn = source.loggedIn === true;
  const expireTimeMs = finiteNumberOrNull(source.expireTimeMs);
  return {
    available: source.available === true,
    loggedIn,
    openIdMasked: typeof source.openIdMasked === 'string'
      ? source.openIdMasked.slice(0, MAX_MASKED_OPEN_ID_LENGTH)
      : null,
    scope: Array.isArray(source.scope)
      ? source.scope.filter(item => typeof item === 'string')
      : [],
    expireTimeMs,
    refreshExpireTimeMs: finiteNumberOrNull(source.refreshExpireTimeMs),
    needsReauth: typeof source.needsReauth === 'boolean'
      ? source.needsReauth
      : !loggedIn || (expireTimeMs !== null && expireTimeMs <= Date.now())
  };
}

function unavailableAuthStatus() {
  return {
    available: false,
    loggedIn: false,
    openIdMasked: null,
    scope: [],
    expireTimeMs: null,
    refreshExpireTimeMs: null,
    needsReauth: true,
    error: 'redapp CLI 不可用'
  };
}

function loggedOutAuthStatus() {
  return {
    available: true,
    loggedIn: false,
    openIdMasked: null,
    scope: [],
    expireTimeMs: null,
    refreshExpireTimeMs: null,
    needsReauth: true
  };
}

export function createRedappAuthManager({
  spawnCli,
  runCli,
  readFile,
  now = Date.now,
  randomId = () => crypto.randomUUID(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let active = null;
  let disposed = false;
  const sessions = new Map();

  function publicSession(session) {
    return {
      sessionId: session.id,
      status: session.status,
      qrImage: session.qrImage || null,
      authorizeUrl: session.authorizeUrl || null,
      userCode: session.userCode || null,
      expiresAt: session.expiresAt || null,
      auth: session.auth || null,
      error: session.error || null
    };
  }

  function armTimer(callback, delay) {
    const timer = setTimer(callback, delay);
    timer?.unref?.();
    return timer;
  }

  function scheduleRemoval(session) {
    if (session.retentionTimer) clearTimer(session.retentionTimer);
    session.retentionTimer = armTimer(() => {
      sessions.delete(session.id);
      if (active === session) active = null;
    }, TERMINAL_RETENTION_MS);
  }

  function releaseChild(session, { kill = true } = {}) {
    const child = session.child;
    if (child) {
      if (session.stdoutHandler) child.stdout?.removeListener?.('data', session.stdoutHandler);
      if (session.stderrHandler) child.stderr?.removeListener?.('data', session.stderrHandler);
      if (session.errorHandler) child.removeListener?.('error', session.errorHandler);
      if (session.closeHandler) child.removeListener?.('close', session.closeHandler);
      if (kill && !child.killed) {
        try { child.kill?.(); } catch {}
      }
    }
    session.child = null;
    session.streams = null;
    session.stdoutHandler = null;
    session.stderrHandler = null;
    session.errorHandler = null;
    session.closeHandler = null;
  }

  function finish(session, status, values = {}, options = {}) {
    if (disposed || !ACTIVE_STATUSES.has(session.status)) return;
    session.status = status;
    Object.assign(session, values);
    if (session.expiryTimer) {
      clearTimer(session.expiryTimer);
      session.expiryTimer = null;
    }
    releaseChild(session, options);
    if (active === session) active = null;
    scheduleRemoval(session);
  }

  function expirePastDeadline(session) {
    if (ACTIVE_STATUSES.has(session.status) && now() >= session.deadlineAt) {
      finish(session, 'expired');
      return true;
    }
    return false;
  }

  function handlePrompt(session, prompt) {
    if (expirePastDeadline(session)) return;
    const authorizeUrl = prompt.authorizeH5Url || prompt.authorizeCommonUrl || prompt.authorizeUrl || null;
    const userCode = prompt.userCode || null;
    if (!ACTIVE_STATUSES.has(session.status) || (!prompt.qrCodePath && !authorizeUrl && !userCode)) return;
    try {
      let qrImage = null;
      if (prompt.qrCodePath) {
        const image = readFile(prompt.qrCodePath);
        qrImage = `data:image/png;base64,${Buffer.from(image).toString('base64')}`;
      }
      const seconds = Math.min(prompt.expiresInSeconds ?? MAX_LOGIN_SECONDS, MAX_LOGIN_SECONDS);
      const requestedExpiry = now() + seconds * 1000;
      const expiresAt = Math.min(requestedExpiry, session.deadlineAt);
      if (session.expiryTimer) clearTimer(session.expiryTimer);
      session.qrImage = qrImage;
      session.authorizeUrl = authorizeUrl;
      session.userCode = userCode;
      session.expiresAt = expiresAt;
      session.status = 'waiting_scan';
      session.expiryTimer = armTimer(() => {
        if (ACTIVE_STATUSES.has(session.status)) finish(session, 'expired');
      }, Math.max(0, expiresAt - now()));
    } catch {
      finish(session, 'failed', { error: '二维码读取失败' });
    }
  }

  function handleLine(session, line) {
    if (expirePastDeadline(session)) return;
    const parsed = parseTaggedOutput(line);
    for (const prompt of parsed.prompts) handlePrompt(session, prompt);
    for (const result of parsed.results) {
      if (result.status === 'ok' && result.credentials?.loggedIn === true) {
        finish(session, 'done', { auth: projectAuthStatus(result.credentials) });
      }
    }
  }

  function assertOpen() {
    if (disposed) throw new Error(CLOSED_ERROR_MESSAGE);
  }

  function attachChild(session, child) {
    session.child = child;
    if (!ACTIVE_STATUSES.has(session.status) || disposed) {
      try { session.child?.kill?.(); } catch {}
      return;
    }
    const feedStream = (streamName, chunk) => {
      if (!ACTIVE_STATUSES.has(session.status)) return;
      const stream = session.streams[streamName];
      stream.buffer += stream.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const lines = stream.buffer.split(/\r?\n/);
      stream.buffer = lines.pop() || '';
      for (const line of lines) {
        if (Buffer.byteLength(line, 'utf8') > MAX_LOGIN_OUTPUT_LINE_LENGTH) {
          finish(session, 'failed', { error: '登录进程输出异常' });
          return;
        }
        handleLine(session, line);
        if (!ACTIVE_STATUSES.has(session.status)) return;
      }
      if (Buffer.byteLength(stream.buffer, 'utf8') > MAX_LOGIN_OUTPUT_LINE_LENGTH) {
        finish(session, 'failed', { error: '登录进程输出异常' });
      }
    };
    session.stdoutHandler = chunk => feedStream('stdout', chunk);
    session.stderrHandler = chunk => feedStream('stderr', chunk);
    session.errorHandler = () => finish(session, 'failed', { error: '登录进程启动失败' });
    session.closeHandler = () => {
      if (!ACTIVE_STATUSES.has(session.status)) return;
      for (const streamName of ['stdout', 'stderr']) {
        if (!ACTIVE_STATUSES.has(session.status)) return;
        const stream = session.streams[streamName];
        stream.buffer += stream.decoder.end();
        if (Buffer.byteLength(stream.buffer, 'utf8') > MAX_LOGIN_OUTPUT_LINE_LENGTH) {
          finish(session, 'failed', { error: '登录进程输出异常' }, { kill: false });
          return;
        }
        if (stream.buffer) handleLine(session, stream.buffer);
      }
      if (ACTIVE_STATUSES.has(session.status)) finish(session, 'failed', { error: '登录进程异常退出' }, { kill: false });
    };
    session.child.stdout.on('data', session.stdoutHandler);
    session.child.stderr?.on?.('data', session.stderrHandler);
    session.child.on('error', session.errorHandler);
    session.child.on('close', session.closeHandler);
  }

  function failLoginStart(session) {
    finish(session, 'failed', { error: '登录进程启动失败' });
  }

  function startLogin() {
    assertOpen();
    if (active && ACTIVE_STATUSES.has(active.status)) return publicSession(active);
    const createdAt = now();
    const session = {
      id: randomId(),
      status: 'waiting_prompt',
      deadlineAt: createdAt + MAX_LOGIN_SECONDS * 1000,
      child: null,
      streams: {
        stdout: { buffer: '', decoder: new StringDecoder('utf8') },
        stderr: { buffer: '', decoder: new StringDecoder('utf8') }
      },
      expiryTimer: null,
      retentionTimer: null,
      stdoutHandler: null,
      stderrHandler: null,
      errorHandler: null,
      closeHandler: null
    };
    sessions.set(session.id, session);
    active = session;

    session.expiryTimer = armTimer(() => {
      if (ACTIVE_STATUSES.has(session.status)) finish(session, 'expired');
    }, Math.max(0, session.deadlineAt - now()));
    try {
      const childOrPromise = spawnCli();
      if (childOrPromise && typeof childOrPromise.then === 'function') {
        childOrPromise.then(child => attachChild(session, child), () => failLoginStart(session));
      } else {
        attachChild(session, childOrPromise);
      }
    } catch {
      failLoginStart(session);
    }
    return publicSession(session);
  }

  function getSession(id) {
    const session = sessions.get(id);
    return session ? publicSession(session) : null;
  }

  async function getStatus() {
    assertOpen();
    try {
      const result = await runCli(['whoami']);
      if (result?.status === 'error' && result.code === 'AUTH_REQUIRED') return loggedOutAuthStatus();
      return projectAuthStatus(result?.credentials);
    } catch {
      return unavailableAuthStatus();
    }
  }

  async function cancelLogin(id) {
    assertOpen();
    const session = sessions.get(id);
    if (!session) return null;
    if (ACTIVE_STATUSES.has(session.status)) {
      finish(session, 'cancelled');
      try { await runCli(['login', '--cancel']); } catch {}
    }
    return publicSession(session);
  }

  function invalidateSessions() {
    active = null;
    for (const session of sessions.values()) {
      if (session.expiryTimer) clearTimer(session.expiryTimer);
      if (session.retentionTimer) clearTimer(session.retentionTimer);
      releaseChild(session);
    }
    sessions.clear();
  }

  async function logout() {
    assertOpen();
    invalidateSessions();
    try {
      const result = await runCli(['logout']);
      return projectAuthStatus(result?.credentials);
    } catch {
      throw new Error('redapp 退出登录失败');
    }
  }

  function dispose() {
    disposed = true;
    invalidateSessions();
  }

  return { getStatus, startLogin, getSession, cancelLogin, logout, dispose };
}
