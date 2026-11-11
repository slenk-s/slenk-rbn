import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_QR_IMAGE_LENGTH,
  authActionPermissions,
  authStatusPresentation,
  boundedSessionError,
  canCommitLifecycle,
  cancelOperationCompletion,
  cancelSessionStateCompletion,
  dashboardPollFailureDisposition,
  fetchWithDeadline,
  focusNavigationIndex,
  formatAuthExpiry,
  formatRemainingTime,
  isUsableAuth,
  operationTransition,
  pollLifecycleTransition,
  pollCompletionTransition,
  reserveTransferredGeneration,
  safeAuthorizeUrl,
  safeQrImage,
  sessionStatusPresentation
} from '../src/redappAuthUi.js';

test('safeAuthorizeUrl accepts only http and https links', () => {
  assert.equal(safeAuthorizeUrl('https://example.com/authorize'), 'https://example.com/authorize');
  assert.equal(safeAuthorizeUrl('http://localhost:3000/auth'), 'http://localhost:3000/auth');
  for (const value of ['javascript:alert(1)', 'file:///secret', 'xhsdiscover://auth', '/relative', '', null]) {
    assert.equal(safeAuthorizeUrl(value), '');
  }
});

test('safeQrImage accepts bounded PNG, JPEG, GIF, and WebP data images only', () => {
  assert.equal(safeQrImage('data:image/png;base64,cXI='), 'data:image/png;base64,cXI=');
  assert.equal(safeQrImage('data:image/webp;base64,AAAA'), 'data:image/webp;base64,AAAA');
  assert.equal(safeQrImage('https://example.com/qr.png'), '');
  assert.equal(safeQrImage('data:image/svg+xml,<svg onload=alert(1)>'), '');
  assert.equal(safeQrImage('data:image/png;base64,' + 'A'.repeat(MAX_QR_IMAGE_LENGTH)), '');
});

test('formatRemainingTime clamps expired values and rounds up active seconds', () => {
  assert.equal(formatRemainingTime(61_001, 1_000), '01:01');
  assert.equal(formatRemainingTime(1_001, 1_000), '00:01');
  assert.equal(formatRemainingTime(999, 1_000), '已到期');
  assert.equal(formatRemainingTime(null, 1_000), '等待授权');
});

test('formatAuthExpiry handles seconds, milliseconds, and invalid values safely', () => {
  assert.equal(formatAuthExpiry(1_700_000_000, { locale: 'zh-CN', timeZone: 'UTC' }), '2023/11/14 22:13');
  assert.equal(formatAuthExpiry(1_700_000_000_000, { locale: 'zh-CN', timeZone: 'UTC' }), '2023/11/14 22:13');
  assert.equal(formatAuthExpiry(null), '未提供');
  assert.equal(formatAuthExpiry('C:/credentials.json'), '未提供');
});

test('authStatusPresentation distinguishes unknown, unavailable, reauth, connected, and disconnected states', () => {
  assert.deepEqual(authStatusPresentation(null), { tone: 'unknown', label: '状态未知' });
  assert.deepEqual(authStatusPresentation({ available: false }), { tone: 'unavailable', label: 'CLI 不可用' });
  assert.deepEqual(authStatusPresentation({ available: true, loggedIn: true, needsReauth: true }), { tone: 'warning', label: '需要重新授权' });
  assert.deepEqual(authStatusPresentation({ available: true, loggedIn: true, needsReauth: false }), { tone: 'connected', label: '已连接' });
  assert.deepEqual(authStatusPresentation({ available: true, loggedIn: false }), { tone: 'idle', label: '未连接' });
});

test('safeQrImage accepts the full encoded form of a 2 MiB raster and rejects beyond it', () => {
  const prefix = 'data:image/png;base64,';
  assert.equal(MAX_QR_IMAGE_LENGTH, Math.ceil(2 * 1024 * 1024 / 3) * 4 + 64);
  const valid = prefix + 'A'.repeat(MAX_QR_IMAGE_LENGTH - prefix.length);
  assert.equal(safeQrImage(valid), valid);
  assert.equal(safeQrImage(valid + 'A'), '');
});

test('session presentation takes priority and labels every shared-session state', () => {
  const labels = {
    waiting_prompt: '准备中', waiting_scan: '等待扫码', expired: '已过期',
    failed: '失败', cancelled: '已取消', done: '成功待刷新', 'not-found': '已失效'
  };
  for (const [status, label] of Object.entries(labels)) {
    assert.equal(sessionStatusPresentation({ status }, { available: true, loggedIn: true }).label, label);
  }
  assert.deepEqual(sessionStatusPresentation(null, null), { tone: 'unknown', label: '状态未知' });
});

test('poll terminal failures preserve their status', () => {
  assert.deepEqual(pollCompletionTransition('failed', null), { status: 'failed' });
});

test('operation generation permits only the latest operation to commit', () => {
  const first = operationTransition({ generation: 0 }, 'start');
  const second = operationTransition(first.state, 'start');
  assert.equal(operationTransition(second.state, 'commit', first.generation).commit, false);
  assert.equal(operationTransition(second.state, 'commit', second.generation).commit, true);
});

test('lifecycle commits require the current generation and exact session', () => {
  const lifecycle = { generation: 4, sessionId: 'session-new' };
  assert.equal(canCommitLifecycle(lifecycle, 4, 'session-new'), true);
  assert.equal(canCommitLifecycle(lifecycle, 3, 'session-new'), false);
  assert.equal(canCommitLifecycle(lifecycle, 4, 'session-old'), false);
  assert.equal(canCommitLifecycle({ generation: 5, sessionId: null }, 4, 'session-old'), false);
});

test('active sessions allow only refresh and explicit cancel mutations', () => {
  const auth = { available: true, loggedIn: true, needsReauth: false };
  assert.deepEqual(authActionPermissions({ auth, activeSession: true, loading: false, busy: false }), {
    connect: false, refresh: false, cancel: true, logout: false
  });
  assert.deepEqual(authActionPermissions({ auth: null, activeSession: false, loading: false, busy: false }), {
    connect: false, refresh: true, cancel: false, logout: false
  });
});

test('current failed cancellation restarts polling and releases its busy ownership', () => {
  const transition = cancelOperationCompletion({
    lifecycle: { generation: 8, sessionId: 'session-a' },
    operationGeneration: 8,
    sessionId: 'session-a',
    succeeded: false
  });
  assert.deepEqual(transition, {
    commit: true,
    lifecycle: { generation: 9, sessionId: 'session-a' },
    busy: false,
    pollGeneration: 9
  });
  assert.deepEqual(authActionPermissions({
    auth: { available: true, loggedIn: false, needsReauth: false },
    activeSession: true,
    loading: false,
    busy: transition.busy
  }), { connect: false, refresh: false, cancel: true, logout: false });
});

test('cancel transfer reserves its generation before releasing the UI lock', () => {
  assert.equal(reserveTransferredGeneration(8, 9), 9);
  assert.equal(reserveTransferredGeneration(10, 9), 10);
  const nextOperation = operationTransition({ generation: reserveTransferredGeneration(8, 9) }, 'start');
  assert.equal(nextOperation.generation, 10);
});

test('failed cancel wiring reserves transferred generation before unlock and rejects its poll after a retry', () => {
  const source = readFileSync(new URL('../src/RedappAuth.jsx', import.meta.url), 'utf8');
  const catchBranch = source.match(/    \} catch \{([\s\S]*?)\n    \} finally \{/u)?.[1] || '';
  const guardedCommit = catchBranch.match(
    /if \(transition\.commit && !controller\.signal\.aborted\) \{([\s\S]*?)\n      \}/u
  )?.[1] || '';
  const reservationMatch = guardedCommit.match(
    /operationGeneration\.current = reserveTransferredGeneration\(\r?\n\s*operationGeneration\.current,\r?\n\s*transition\.pollGeneration\r?\n\s*\);/u
  );
  const reserveIndex = reservationMatch?.index ?? -1;
  const unlockIndex = guardedCommit.indexOf('setBusy(transition.busy);');
  const lifecycleIndex = guardedCommit.indexOf('lifecycle.current = transition.lifecycle;');
  const sessionIndex = guardedCommit.indexOf('pollGeneration: transition.pollGeneration');

  assert.ok(guardedCommit, 'failed cancel catch must preserve current transition and controller guards');
  assert.equal(catchBranch.slice(0, catchBranch.indexOf(guardedCommit)).includes('reserveTransferredGeneration('), false,
    'stale failed cancel must not reserve outside the current-completion guard');
  assert.ok(reserveIndex >= 0, 'failed cancel catch must reserve its exact transferred generation');
  assert.ok(reserveIndex < unlockIndex, 'reservation must happen before busy unlock');
  assert.ok(unlockIndex < lifecycleIndex && lifecycleIndex < sessionIndex,
    'unlock must precede lifecycle and exact-session poll publication');

  const transition = cancelOperationCompletion({
    lifecycle: { generation: 8, sessionId: 'session-a' },
    operationGeneration: 8,
    sessionId: 'session-a',
    succeeded: false
  });
  const reservedGeneration = reserveTransferredGeneration(8, transition.pollGeneration);
  assert.equal(reservedGeneration, 9);
  const retry = operationTransition({ generation: reservedGeneration }, 'start');
  assert.equal(retry.generation, 10);
  assert.equal(pollLifecycleTransition(
    { generation: retry.generation, sessionId: 'session-a' },
    'session-a',
    transition.pollGeneration
  ).commit, false);

  const stale = cancelOperationCompletion({
    lifecycle: { generation: retry.generation, sessionId: 'session-a' },
    operationGeneration: 8,
    sessionId: 'session-a',
    succeeded: false
  });
  assert.equal(stale.commit, false);
  assert.equal(stale.busy, true);
  assert.equal(reserveTransferredGeneration(retry.generation, stale.pollGeneration), retry.generation);
});

test('replacement poll adopts the transferred lifecycle without invalidating a new operation', () => {
  const transferred = { generation: 9, sessionId: 'session-a' };
  assert.deepEqual(pollLifecycleTransition(transferred, 'session-a', 9), {
    lifecycle: transferred,
    generation: 9
  });
  const newer = { generation: 10, sessionId: 'session-a' };
  assert.deepEqual(pollLifecycleTransition(newer, 'session-a', 9), {
    lifecycle: newer,
    generation: 10,
    commit: false
  });
});

test('stale failed cancellation cannot release or commit over a newer operation', () => {
  assert.deepEqual(cancelOperationCompletion({
    lifecycle: { generation: 9, sessionId: 'session-a' },
    operationGeneration: 8,
    sessionId: 'session-a',
    succeeded: false
  }), {
    commit: false,
    lifecycle: { generation: 9, sessionId: 'session-a' },
    busy: true
  });
});

test('raced terminal cancel responses restart exact-session polling instead of clearing lifecycle', () => {
  const input = {
    lifecycle: { generation: 8, sessionId: 'session-a' },
    operationGeneration: 8,
    sessionId: 'session-a',
    succeeded: true
  };
  for (const responseStatus of ['done', 'failed', 'expired']) {
    assert.deepEqual(cancelOperationCompletion({ ...input, responseStatus }), {
      commit: true,
      lifecycle: { generation: 9, sessionId: 'session-a' },
      busy: false,
      pollGeneration: 9
    });
  }
  assert.equal(cancelOperationCompletion({ ...input, responseStatus: 'cancelled' }).commit, true);
});

test('cancel success wiring transfers raced done to a replacement poll without direct success', () => {
  const response = { sessionId: 'session-a', status: 'done', authorizeUrl: 'https://example.test/stale' };
  const completion = cancelOperationCompletion({
    lifecycle: { generation: 8, sessionId: 'session-a' },
    operationGeneration: 8,
    sessionId: 'session-a',
    responseStatus: response.status,
    succeeded: true
  });
  assert.deepEqual(cancelSessionStateCompletion({
    currentSession: { sessionId: 'session-a', status: 'waiting_scan' },
    response,
    transition: completion
  }), {
    session: { ...response, pollGeneration: 9 },
    close: false,
    announceSuccess: false
  });
  assert.notEqual(completion.pollGeneration, 8);
  assert.deepEqual(pollCompletionTransition('done', {
    available: true, loggedIn: true, needsReauth: false
  }), { close: true, clearSession: true });
  assert.deepEqual(pollCompletionTransition('done', {
    available: true, loggedIn: false, needsReauth: false
  }), { status: 'done', refreshError: '授权完成，但当前账号状态仍不可用' });
});

test('cancel success wiring sends raced failed and expired through replacement polling', () => {
  for (const status of ['failed', 'expired']) {
    const response = { sessionId: 'session-a', status, error: `${status} response` };
    const completion = cancelOperationCompletion({
      lifecycle: { generation: 8, sessionId: 'session-a' },
      operationGeneration: 8,
      sessionId: 'session-a',
      responseStatus: status,
      succeeded: true
    });
    assert.deepEqual(cancelSessionStateCompletion({
      currentSession: { sessionId: 'session-a', status: 'waiting_scan' },
      response,
      transition: completion
    }), {
      session: { ...response, pollGeneration: 9 },
      close: false,
      announceSuccess: false
    });
  }
});

test('cancel success wiring commits an exact cancelled response terminally', () => {
  const response = { sessionId: 'session-a', status: 'cancelled' };
  const completion = cancelOperationCompletion({
    lifecycle: { generation: 8, sessionId: 'session-a' },
    operationGeneration: 8,
    sessionId: 'session-a',
    responseStatus: response.status,
    succeeded: true
  });
  assert.deepEqual(cancelSessionStateCompletion({
    currentSession: { sessionId: 'session-a', status: 'waiting_scan' },
    response,
    transition: completion
  }), { session: response, close: false, announceSuccess: false });
  assert.equal(completion.pollGeneration, undefined);
});

test('current successful cancellation is terminal and releases busy', () => {
  assert.deepEqual(cancelOperationCompletion({
    lifecycle: { generation: 8, sessionId: 'session-a' },
    operationGeneration: 8,
    sessionId: 'session-a',
    responseStatus: 'cancelled',
    succeeded: true
  }), {
    commit: true,
    lifecycle: { generation: 8, sessionId: null },
    busy: false
  });
});

test('usable auth requires strict authoritative booleans', () => {
  assert.equal(isUsableAuth({ available: true, loggedIn: true, needsReauth: false }), true);
  for (const auth of [
    null,
    { available: false, loggedIn: true, needsReauth: false },
    { available: true, loggedIn: false, needsReauth: false },
    { available: true, loggedIn: true, needsReauth: true },
    { available: 1, loggedIn: true, needsReauth: false },
    { available: true, loggedIn: 1, needsReauth: false },
    { available: true, loggedIn: true, needsReauth: 0 }
  ]) assert.equal(isUsableAuth(auth), false);
});

test('done completion closes only for usable refreshed auth', () => {
  const unusable = [
    { available: false, loggedIn: true, needsReauth: false },
    { available: true, loggedIn: false, needsReauth: false },
    { available: true, loggedIn: true, needsReauth: true }
  ];
  assert.deepEqual(pollCompletionTransition('done', { available: true, loggedIn: true, needsReauth: false }), { close: true, clearSession: true });
  for (const auth of unusable) {
    assert.deepEqual(pollCompletionTransition('done', auth), {
      status: 'done', refreshError: '授权完成，但当前账号状态仍不可用'
    });
  }
  assert.deepEqual(pollCompletionTransition('done', null), { status: 'done', refreshError: '授权成功，状态刷新失败' });
});

test('fetchWithDeadline aborts hung fetches and preserves caller aborts', async () => {
  let timeoutSignal;
  await assert.rejects(
    fetchWithDeadline((_url, options) => {
      timeoutSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }, '/hung', {}, 5),
    error => error?.name === 'TimeoutError'
  );
  assert.equal(timeoutSignal.aborted, true);

  const controller = new AbortController();
  const pending = fetchWithDeadline((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }), '/abort', { signal: controller.signal }, 1000);
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(pending, error => error?.name === 'AbortError');
});

test('resume publish UI exposes timeout guidance, retry wiring, and usable reopen layering', () => {
  const modalSource = readFileSync(new URL('../src/RedappAuth.jsx', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const cssSource = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
  assert.match(modalSource, /timeout:\s*'授权等待已超时'/u);
  assert.match(modalSource, /timeout:\s*'授权等待已超时，请重新发起授权。'/u);
  assert.match(appSource, /flow\.phase === 'outcome-unknown'/u);
  assert.match(appSource, /publish-outcome-unknown/u);
  assert.match(appSource, /已确认上传结果未知/u);
  assert.doesNotMatch(appSource, /PUBLISH_JOB_OUTCOME_UNKNOWN'[\s\S]{0,300}phase = 'uncertain'/u);
  assert.match(appSource, /onRetry=\{retryMinitoolPublish\}/u);
  const zIndex = Number(cssSource.match(/\.auth-progress-reopen\s*\{[\s\S]*?z-index:\s*(\d+)/u)?.[1]);
  assert.ok(zIndex > 1200, 'reopen control must sit above publish confirmation backdrop');
  assert.match(cssSource, /\.auth-qr-backdrop\s*\{\s*z-index:\s*(\d+)/u);
  const modalZ = Number(cssSource.match(/\.auth-qr-backdrop\s*\{\s*z-index:\s*(\d+)/u)?.[1]);
  assert.ok(modalZ > zIndex, 'auth modal must sit above reopen control');
});

test('dashboard poll failures only treat cancellation and 404 as immediate', () => {
  assert.equal(dashboardPollFailureDisposition(Object.assign(new Error('cancelled'), { code: 'AUTH_POLL_CANCELLED' })), 'abort');
  assert.equal(dashboardPollFailureDisposition(new DOMException('aborted', 'AbortError')), 'abort');
  assert.equal(dashboardPollFailureDisposition(Object.assign(new Error('missing'), { status: 404 })), 'not-found');
  assert.equal(dashboardPollFailureDisposition(new TypeError('network down')), 'retry');
  assert.equal(dashboardPollFailureDisposition(new DOMException('timed out', 'TimeoutError')), 'retry');
  assert.equal(dashboardPollFailureDisposition(Object.assign(new Error('boom'), { status: 500 })), 'retry');
});

test('dashboard poller tolerates transient failures within the session budget', () => {
  const source = readFileSync(new URL('../src/RedappAuth.jsx', import.meta.url), 'utf8');
  assert.match(source, /dashboardPollFailureDisposition/u);
  assert.match(source, /transientFailures/u);
});

test('publish POST wiring uses the gated server-envelope deadline', () => {
  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(appSource, /MINITOOL_PUBLISH_REQUEST_DEADLINE_MS/u);
});

test('countdown supports an immediate deterministic initial time', () => {
  const initialNow = 10_000;
  assert.equal(formatRemainingTime(71_000, initialNow), '01:01');
});

test('terminal errors are bounded and focus navigation wraps', () => {
  assert.equal(boundedSessionError(' x '.repeat(200), 20).length, 20);
  assert.equal(boundedSessionError('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(focusNavigationIndex(-1, 3, 1), 0);
  assert.equal(focusNavigationIndex(-1, 3, -1), 2);
  assert.equal(focusNavigationIndex(2, 3, 1), 0);
  assert.equal(focusNavigationIndex(0, 3, -1), 2);
  assert.equal(focusNavigationIndex(1, 0, 1), -1);
});
