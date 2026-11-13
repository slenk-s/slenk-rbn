import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout } from '../src/fetchWithTimeout.js';

function fakeFetch({ resolveMs, record }) {
  return (url, options = {}) => new Promise((resolve, reject) => {
    record.push({ url, at: Date.now() });
    const timer = setTimeout(() => resolve({ ok: true, headers: { get: () => 'application/json' } }), resolveMs);
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

test('请求在预算内返回，调用方拿到服务端响应', async () => {
  const record = [];
  globalThis.fetch = fakeFetch({ resolveMs: 5, record });

  const res = await fetchWithTimeout('/api/notes/parse', { method: 'POST' }, 1000);

  assert.equal(res.ok, true);
  assert.equal(record[0].url, '/api/notes/parse');
});

test('超过预算时中断并抛出可读的超时错误', async () => {
  const record = [];
  globalThis.fetch = fakeFetch({ resolveMs: 300, record });

  const started = Date.now();
  await assert.rejects(() => fetchWithTimeout('/api/notes/parse', { method: 'POST' }, 50), /超时/);
  assert.ok(Date.now() - started < 300, '应在服务端响应之前就放弃，而不是等它回来');
  assert.equal(record.length, 1, '只发起了这一次请求');
});

test('调用方中断会取消请求并保留原始 abort 错误', async () => {
  const caller = new AbortController();
  let receivedSignal = null;
  const callerError = new Error('login flow invalidated');
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    receivedSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });

  const pending = fetchWithTimeout('/api/auth/login', { method: 'POST', signal: caller.signal }, 1000);
  caller.abort(callerError);

  await assert.rejects(pending, error => error === callerError);
  assert.equal(receivedSignal.aborted, true);
});

test('deadline 与调用方 signal 组合且超时仍使用既有错误文案', async () => {
  const caller = new AbortController();
  let receivedSignal = null;
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    receivedSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });

  await assert.rejects(
    () => fetchWithTimeout('/api/auth/login', { method: 'POST', signal: caller.signal }, 25),
    /请求超时（0 秒），请稍后重试/
  );
  assert.equal(receivedSignal.aborted, true);
  assert.equal(caller.signal.aborted, false, 'deadline must not abort the caller-owned controller');
});

test('服务端正常报错时保留原来的错误信息', async () => {
  globalThis.fetch = () => Promise.reject(new Error('网络不可达'));

  await assert.rejects(() => fetchWithTimeout('/api/notes/parse', { method: 'POST' }, 1000), /网络不可达/);
});
