import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_QR_IMAGE_LENGTH,
  authStatusPresentation,
  boundedSessionError,
  dashboardPollFailureDisposition,
  fetchWithDeadline,
  focusNavigationIndex,
  formatAuthExpiry,
  formatRemainingTime,
  operationTransition,
  safeAuthorizeUrl,
  safeQrImage
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

test('operation generation permits only the latest operation to commit', () => {
  const first = operationTransition({ generation: 0 }, 'start');
  const second = operationTransition(first.state, 'start');
  assert.equal(operationTransition(second.state, 'commit', first.generation).commit, false);
  assert.equal(operationTransition(second.state, 'commit', second.generation).commit, true);
});

test('account-scoped cancel keeps polling on failure and applies terminal state on success', () => {
  const source = readFileSync(new URL('../src/RedappAuth.jsx', import.meta.url), 'utf8');
  const cancelBody = source.match(/async function cancelSession\(\) \{([\s\S]*?)\n  \}/u)?.[1] || '';
  assert.ok(cancelBody, 'cancelSession wiring must exist');
  // 取消必须带账号上下文：服务端按 ?accountId= 校验归属。
  assert.match(cancelBody, /client\.cancel\(cancelling\.sessionId, \{ accountId: cancelling\.accountId/u);
  const tryBranch = cancelBody.match(/try \{([\s\S]*?)\} catch \{/u)?.[1] || '';
  const catchBranch = cancelBody.match(/\} catch \{([\s\S]*?)\} finally \{/u)?.[1] || '';
  assert.ok(tryBranch && catchBranch, 'cancel wiring must have try/catch branches');
  // 成功路径：先停轮询，再写入服务端返回的终态会话。
  const abortIndex = tryBranch.indexOf('pollController.current?.abort();');
  const applyIndex = tryBranch.indexOf('setSession(');
  assert.ok(abortIndex >= 0 && applyIndex > abortIndex, 'successful cancel must stop polling before publishing the terminal session');
  // 授权已完成的竞态：cancel 返回 done 时按完成处理并刷新账号列表。
  assert.match(tryBranch, /cancelled\.status === 'done'/u);
  assert.match(tryBranch, /refreshAccounts/u);
  // 失败路径：只提示，绝不停轮询——授权可能仍在进行。
  assert.match(catchBranch, /取消授权失败/u);
  assert.equal(catchBranch.includes('pollController'), false, 'failed cancel must not abort the in-flight poll');
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

test('publish account picker keeps the previous account list when refresh fails', () => {
  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const body = appSource.match(/async function loadPublishAccounts\(\) \{([\s\S]*?)\n  \}/u)?.[1] || '';
  assert.ok(body, 'loadPublishAccounts must exist');
  // 成功路径仍写入新列表；失败路径必须保留旧列表而不是清空成“暂无账号”空态。
  assert.match(body, /setXhsAccounts\(accounts\)/u);
  assert.doesNotMatch(body, /setXhsAccounts\(\[\]\)/u);
  assert.match(body, /setStatus\([^)]*账号列表刷新失败/u);
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
