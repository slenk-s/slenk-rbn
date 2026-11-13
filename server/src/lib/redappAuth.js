import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { parseTaggedOutput } from './redappCli.js';

const ACTIVE_STATUSES = new Set(['waiting_prompt', 'waiting_scan']);
const TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const MAX_LOGIN_SECONDS = 600;
const MAX_LOGIN_OUTPUT_LINE_LENGTH = 64 * 1024;
const CLOSED_ERROR_MESSAGE = '授权管理器已关闭';
const MAX_MASKED_OPEN_ID_LENGTH = 512;
const LOGIN_DONE_TIMEOUT_MS = 5000;
const MATCH_FAILURE_ERROR = '扫码匹配失败';
const MATCH_TIMEOUT_ERROR = '扫码匹配超时';
const MATCH_DUPLICATE_ERROR = 'XHS 账号已绑定';

function finiteNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 匹配结果投影：只保留允许的字段并做类型约束，避免内部对象/异常文本泄漏到公开 DTO。
function projectMatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const match = {};
  if (typeof value.matched === 'boolean') match.matched = value.matched;
  if (value.conflict === true) match.conflict = true;
  if (typeof value.existingId === 'string') match.existingId = value.existingId.slice(0, 256);
  if (typeof value.accountId === 'string') match.accountId = value.accountId.slice(0, 256);
  if (typeof value.error === 'string') match.error = value.error.slice(0, 256);
  return Object.keys(match).length ? match : undefined;
}

// needsReauth 永远在投影时刻按 loggedIn/expireTimeMs 重算，不信任上游存入的布尔值：
// 已完成的会话快照在保留窗口内继续被读取，期间凭证可能刚刚过期。
function projectAuthStatus(value, now = Date.now) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const loggedIn = source.loggedIn === true;
  const expireTimeMs = finiteNumberOrNull(source.expireTimeMs);
  const projected = {
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
    needsReauth: !loggedIn || (expireTimeMs !== null && expireTimeMs <= now())
  };
  const match = projectMatch(source.match);
  if (match) projected.match = match;
  return projected;
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

function busyLoginError() {
  return Object.assign(new Error('同用户已有登录会话进行中'), { code: 'XHS_LOGIN_BUSY' });
}

// parseTaggedOutput 的 sanitize 已把 credentials 投影为公开 DTO（openId 被掩码），
// 登录成功回执里的原始 openId 需从行内原文取出，供 onLoginDone 做扫码自动匹配。
function rawLoginOpenId(line) {
  const tag = 'RESULT_JSON:';
  if (!line.startsWith(tag)) return undefined;
  try {
    return JSON.parse(line.slice(tag.length))?.credentials?.openId;
  } catch {
    return undefined;
  }
}

export function createRedappAuthManager({
  spawnCli,
  runCli,
  readFile,
  now = Date.now,
  randomId = () => crypto.randomUUID(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  loginDoneTimeoutMs = LOGIN_DONE_TIMEOUT_MS,
  onLoginDone
}) {
  let disposed = false;
  // 外层 Map<userId, UserAuthState>；每个用户独立持有自己的 active 会话、
  // 按 accountId 索引的会话表与登录锁。不同用户之间完全隔离、可并行。
  const users = new Map(); // userId -> { active: Session|null, sessions: Map<accountId, Session>, lock: boolean }

  function userState(userId) {
    let state = users.get(userId);
    if (!state) {
      state = { active: null, sessions: new Map(), lock: false };
      users.set(userId, state);
    }
    return state;
  }

  function publicSession(session) {
    return {
      sessionId: session.id,
      status: session.status,
      qrImage: session.qrImage || null,
      authorizeUrl: session.authorizeUrl || null,
      userCode: session.userCode || null,
      expiresAt: session.expiresAt || null,
      auth: session.auth ? projectAuthStatus(session.auth, now) : null,
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
      const state = users.get(session.userId);
      if (!state) return;
      if (state.sessions.get(session.accountId) === session) state.sessions.delete(session.accountId);
      if (state.active === session) { state.active = null; state.lock = false; }
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
    // 标记已释放：挂起的 spawn 之后完成时，attachChild 必须杀死迟到的子进程并直接返回，
    // 不得再触碰已清空的 streams/handlers（logout/dispose 撞上 180s 门禁窗口时会发生）。
    session.released = true;
    session.child = null;
    session.streams = null;
    session.stdoutHandler = null;
    session.stderrHandler = null;
    session.errorHandler = null;
    session.closeHandler = null;
  }

  function clearActive(state, session) {
    if (state && state.active === session) {
      state.active = null;
      state.lock = false;
    }
  }

  function finish(session, status, values = {}, options = {}) {
    if (disposed || !ACTIVE_STATUSES.has(session.status)) return;
    session.status = status;
    session.loginDonePending = false;
    Object.assign(session, values);
    if (session.expiryTimer) {
      clearTimer(session.expiryTimer);
      session.expiryTimer = null;
    }
    releaseChild(session, options);
    clearActive(users.get(session.userId), session);
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

  // 登录成功：协调 onLoginDone（扫码自动匹配 / 落库）与进入 done 终态。
  // onLoginDone 的失败必须上浮到会话（auth.match），不得被吞掉后仍显示登录成功。
  function matchFailure(err) {
    if (err?.code === 'XHS_ACCOUNT_DUPLICATE') {
      return { matched: false, conflict: true, error: MATCH_DUPLICATE_ERROR };
    }
    return { matched: false, error: MATCH_FAILURE_ERROR };
  }

  function settleLoginDone(session, info, auth) {
    // 标记登录结果在途：CLI 打印成功 RESULT 后立刻退出，close 事件会先于 matcher 完成到达，
    // 若 closeHandler 此时把会话标为 failed 会覆盖真正的 done。有此标记时 close 不判失败。
    session.loginDonePending = true;
    let pending;
    try {
      pending = onLoginDone?.(info);
    } catch (err) {
      auth.match = matchFailure(err);
      finish(session, 'done', { auth });
      return;
    }
    if (!pending || typeof pending.then !== 'function') {
      finish(session, 'done', { auth });
      return;
    }
    // 有界等待：matcher 在途时不会提前进入 done；超时/失败都以 auth.match 上浮结果。
    const TIMEOUT = Symbol('loginDoneTimeout');
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = armTimer(() => resolve(TIMEOUT), loginDoneTimeoutMs);
    });
    Promise.race([
      Promise.resolve(pending).then(result => result),
      timeout
    ]).then(result => {
      if (result === TIMEOUT) {
        auth.match = { matched: false, error: MATCH_TIMEOUT_ERROR };
      } else if (result !== undefined) {
        auth.match = result;
      }
      finish(session, 'done', { auth });
    }).catch(err => {
      auth.match = matchFailure(err);
      finish(session, 'done', { auth });
    }).finally(() => {
      if (timer) clearTimer(timer);
    });
  }

  function handleLine(session, line) {
    if (expirePastDeadline(session)) return;
    const parsed = parseTaggedOutput(line);
    for (const prompt of parsed.prompts) handlePrompt(session, prompt);
    for (const result of parsed.results) {
      if (result.status === 'ok' && result.credentials?.loggedIn === true) {
        settleLoginDone(session, {
          userId: session.userId,
          accountId: session.accountId,
          credentialDir: session.credentialDir,
          openId: rawLoginOpenId(line)
        }, projectAuthStatus(result.credentials, now));
      }
    }
  }

  function assertOpen() {
    if (disposed) throw new Error(CLOSED_ERROR_MESSAGE);
  }

  function attachChild(session, child) {
    session.child = child;
    if (session.released || !ACTIVE_STATUSES.has(session.status) || disposed) {
      // 会话已在 spawn 挂起期间被释放（logout/dispose）：杀死迟到的子进程并保持状态清空。
      try { child?.kill?.(); } catch {}
      session.child = null;
      session.streams = null;
      session.stdoutHandler = null;
      session.stderrHandler = null;
      session.errorHandler = null;
      session.closeHandler = null;
      return;
    }
    const feedStream = (streamName, chunk) => {
      if (session.released || !ACTIVE_STATUSES.has(session.status)) return;
      const stream = session.streams?.[streamName];
      if (!stream) return;
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
      if (session.released || !ACTIVE_STATUSES.has(session.status)) return;
      for (const streamName of ['stdout', 'stderr']) {
        if (!ACTIVE_STATUSES.has(session.status)) return;
        const stream = session.streams?.[streamName];
        if (!stream) return;
        stream.buffer += stream.decoder.end();
        if (Buffer.byteLength(stream.buffer, 'utf8') > MAX_LOGIN_OUTPUT_LINE_LENGTH) {
          finish(session, 'failed', { error: '登录进程输出异常' }, { kill: false });
          return;
        }
        if (stream.buffer) handleLine(session, stream.buffer);
      }
      if (ACTIVE_STATUSES.has(session.status) && !session.loginDonePending) finish(session, 'failed', { error: '登录进程异常退出' }, { kill: false });
    };
    session.child.stdout.on('data', session.stdoutHandler);
    session.child.stderr?.on?.('data', session.stderrHandler);
    session.child.on('error', session.errorHandler);
    session.child.on('close', session.closeHandler);
  }

  function failLoginStart(session) {
    finish(session, 'failed', { error: '登录进程启动失败' });
  }

  function startLogin(userId, accountId, credentialDir) {
    assertOpen();
    const state = userState(userId);
    if (state.lock) {
      // 同一账号已有进行中的会话 → 复用；同一用户换账号 → 锁拒绝。
      if (state.active?.accountId === accountId) return publicSession(state.active);
      throw busyLoginError();
    }
    // 该账号槽位可能残留一个终态会话（保留窗口内）：新会话占位前先释放旧会话的定时器与子进程，
    // 避免被替换的终态会话在 dispose/logout 时因不在表内而泄漏定时器。
    const previous = state.sessions.get(accountId);
    if (previous) {
      if (previous.expiryTimer) clearTimer(previous.expiryTimer);
      if (previous.retentionTimer) clearTimer(previous.retentionTimer);
      releaseChild(previous);
    }
    const createdAt = now();
    const session = {
      id: randomId(),
      userId,
      accountId,
      credentialDir,
      status: 'waiting_prompt',
      deadlineAt: createdAt + MAX_LOGIN_SECONDS * 1000,
      child: null,
      released: false,
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
    state.sessions.set(accountId, session);
    state.active = session;
    state.lock = true;

    session.expiryTimer = armTimer(() => {
      if (ACTIVE_STATUSES.has(session.status)) finish(session, 'expired');
    }, Math.max(0, session.deadlineAt - now()));
    try {
      const childOrPromise = spawnCli({ credentialHome: credentialDir });
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

  function getSession(userId, accountId, sessionId) {
    const session = users.get(userId)?.sessions.get(accountId);
    if (!session) return null;
    if (sessionId !== undefined && session.id !== sessionId) return null;
    return publicSession(session);
  }

  // credentialDir 可省略：有活动会话时沿用该账号记录的凭证目录；否则该账号尚未登记凭证目录。
  async function getStatus(userId, accountId, credentialDir) {
    assertOpen();
    const dir = credentialDir ?? users.get(userId)?.sessions.get(accountId)?.credentialDir;
    try {
      const result = await runCli(['whoami'], { credentialHome: dir });
      if (result?.status === 'error' && result.code === 'AUTH_REQUIRED') return loggedOutAuthStatus();
      return projectAuthStatus(result?.credentials, now);
    } catch {
      return unavailableAuthStatus();
    }
  }

  async function cancelLogin(userId, accountId, sessionId) {
    assertOpen();
    const session = users.get(userId)?.sessions.get(accountId);
    if (!session || session.id !== sessionId) return null;
    if (ACTIVE_STATUSES.has(session.status)) {
      finish(session, 'cancelled');
      try { await runCli(['login', '--cancel'], { credentialHome: session.credentialDir }); } catch {}
    }
    return publicSession(session);
  }

  function invalidateAccount(userId, accountId) {
    const state = users.get(userId);
    const session = state?.sessions.get(accountId);
    if (!session) return;
    if (session.expiryTimer) clearTimer(session.expiryTimer);
    if (session.retentionTimer) clearTimer(session.retentionTimer);
    releaseChild(session);
    state.sessions.delete(accountId);
    clearActive(state, session);
  }

  function invalidateAll() {
    for (const state of users.values()) {
      for (const session of state.sessions.values()) {
        if (session.expiryTimer) clearTimer(session.expiryTimer);
        if (session.retentionTimer) clearTimer(session.retentionTimer);
        releaseChild(session);
      }
      state.sessions.clear();
      state.active = null;
      state.lock = false;
    }
    users.clear();
  }

  async function logout(userId, accountId, credentialDir) {
    assertOpen();
    invalidateAccount(userId, accountId);
    try {
      const result = await runCli(['logout'], { credentialHome: credentialDir });
      return projectAuthStatus(result?.credentials, now);
    } catch {
      throw new Error('redapp 退出登录失败');
    }
  }

  function dispose() {
    disposed = true;
    invalidateAll();
  }

  return { getStatus, startLogin, getSession, cancelLogin, logout, dispose };
}
