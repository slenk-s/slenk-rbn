import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERIC_AUTH_DEADLINE_MS,
  MINITOOL_PUBLISH_DEADLINE_MS,
  canCommitPublishFlow,
  createPublishFlow,
  createPublishRequestSnapshot,
  createPublishAttemptId,
  interpretMiniToolPublishResponse,
  recoverInitialPublish,
  createRedappAuthClient,
  createRedappFetchAdapter,
  interpretCancelResponse,
  mergeDisplayedAuth,
  pollMiniToolPublishJob,
  publishAuthTerminal,
  publishWithAuth,
  readApiError
} from '../src/redappAuthFlow.js';

test('UUID fallback uses getRandomValues and produces a safe attempt id', () => {
  const id = createPublishAttemptId({
    randomUUID: undefined,
    getRandomValues(bytes) { for (let i = 0; i < bytes.length; i++) bytes[i] = i; return bytes; }
  });
  assert.match(id, /^[A-Za-z0-9_-]{8,80}$/);
  assert.equal(id, '00010203-0405-4607-8809-0a0b0c0d0e0f');
});

test('initial POST uncertainty immediately polls the same attempt id', async () => {
  const calls = [];
  const result = await recoverInitialPublish({
    attemptId: 'attempt-fixed',
    post: async () => { calls.push('post'); throw new TypeError('lost response'); },
    poll: async id => { calls.push(id); return { attemptId: id, status: 'done', previewUrl: 'https://safe.test' }; }
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(calls, ['post', 'attempt-fixed']);
});

test('initial POST authoritative client errors do not poll', async () => {
  let polls = 0;
  const error = Object.assign(new Error('conflict'), { status: 409, code: 'PUBLISH_ATTEMPT_CONFLICT' });
  await assert.rejects(() => recoverInitialPublish({
    attemptId: 'attempt-fixed', post: async () => { throw error; }, poll: async () => { polls++; }
  }), value => value === error);
  assert.equal(polls, 0);
});

test('POST parser handles queued running done and failed explicitly', async () => {
  assert.deepEqual(interpretMiniToolPublishResponse({ attemptId: 'a', status: 'queued' }, 'a'), { action: 'poll' });
  assert.deepEqual(interpretMiniToolPublishResponse({ attemptId: 'a', status: 'running' }, 'a'), { action: 'poll' });
  assert.deepEqual(interpretMiniToolPublishResponse({ attemptId: 'a', status: 'done', previewUrl: 'x' }, 'a'), { action: 'done', job: { attemptId: 'a', status: 'done', previewUrl: 'x' } });
  assert.throws(() => interpretMiniToolPublishResponse({ attemptId: 'a', status: 'failed', error: 'failed' }, 'a'), e => e.code === 'PUBLISH_JOB_FAILED');
  assert.throws(() => interpretMiniToolPublishResponse({ attemptId: 'a', status: 'unknown' }, 'a'), e => e.code === 'PUBLISH_JOB_UNCERTAIN');
});

test('publish snapshot includes one immutable attempt id', () => {
  const snapshot = createPublishRequestSnapshot({
    attemptId: 'attempt-fixed', title: 'title', content: 'body', tags: [], images: ['a']
  });
  assert.equal(snapshot.attemptId, 'attempt-fixed');
  assert.equal(Object.isFrozen(snapshot), true);
});

test('polls one minitool job through running to done without resubmitting', async () => {
  const calls = [];
  const result = await pollMiniToolPublishJob({
    attemptId: 'attempt-fixed',
    pollMs: 0,
    timeoutMs: 30 * 60 * 1000,
    request: async path => {
      calls.push(path);
      return calls.length === 1
        ? { attemptId: 'attempt-fixed', status: 'running' }
        : { attemptId: 'attempt-fixed', status: 'done', qrImage: 'data:image/png;base64,cXI=' };
    }
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(calls, [
    '/api/publish/minitool/jobs/attempt-fixed',
    '/api/publish/minitool/jobs/attempt-fixed'
  ]);
});

test('poll failure is uncertain and retains the attempt id', async () => {
  await assert.rejects(
    pollMiniToolPublishJob({
      attemptId: 'attempt-fixed', pollMs: 0,
      request: async () => { throw new TypeError('network down'); }
    }),
    error => error.code === 'PUBLISH_JOB_UNCERTAIN' && error.attemptId === 'attempt-fixed'
  );
});

test('cancel done maps to cancel-not-applied terminal guidance', () => {
  assert.deepEqual(interpretCancelResponse('s1', { sessionId: 's1', status: 'done' }), {
    cancelled: false,
    status: 'cancel-not-applied',
    error: '授权已完成，正在查询同一次发布结果'
  });
});

function response(status, body, statusText = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    }
  };
}

function authRequired(...args) {
  const sessionId = args.length ? args[0] : 's1';
  return Object.assign(new Error('需要连接小红书后继续'), {
    code: 'AUTH_REQUIRED',
    status: 401,
    auth: { sessionId, status: 'waiting_prompt' }
  });
}

test('publish request snapshot copies all mutable input fields', () => {
  const tags = ['旅行'];
  const images = ['/one.jpg'];
  const request = createPublishRequestSnapshot({ title: 123, content: null, tags, images });

  tags.push('后来新增');
  images[0] = '/changed.jpg';

  assert.deepEqual(request, {
    attemptId: request.attemptId,
    title: '123',
    content: 'null',
    tags: ['旅行'],
    images: ['/one.jpg']
  });
});

test('publish flow commits require identity, generation, active phase, and live controller', () => {
  const flow = createPublishFlow({ request: Object.freeze({}), generation: 7 });
  assert.equal(canCommitPublishFlow(flow, flow, 7), true);
  flow.phase = 'replaying';
  assert.equal(canCommitPublishFlow(flow, flow, 7), true);
  flow.cancelled = true;
  assert.equal(canCommitPublishFlow(flow, flow, 7), false);
  flow.cancelled = false;
  flow.phase = 'cancelling';
  assert.equal(canCommitPublishFlow(flow, flow, 7), false);
  flow.phase = 'publishing';
  flow.controller.abort();
  assert.equal(canCommitPublishFlow(flow, flow, 7), false);
  assert.equal(canCommitPublishFlow(flow, createPublishFlow({ request: {}, generation: 7 }), 7), false);
  assert.equal(canCommitPublishFlow(flow, flow, 8), false);
});

test('resolved replay cannot commit preview after cancellation wins the continuation boundary', async () => {
  const flow = createPublishFlow({ request: Object.freeze({}), generation: 9 });
  flow.phase = 'replaying';
  let resolveReplay;
  const replay = new Promise(resolve => { resolveReplay = resolve; });
  const continuation = replay.then(result => canCommitPublishFlow(flow, flow, 9) ? result : null);
  resolveReplay({ qrImage: 'data:image/png;base64,cXI=' });
  flow.cancelled = true;
  flow.phase = 'cancelling';
  flow.controller.abort();
  assert.equal(await continuation, null);
});

test('auth presentation merge preserves object identity when displayed fields do not change', () => {
  const previous = { sessionId: 's1', status: 'waiting_scan', qrImage: 'qr', mode: 'resume-publish', ignored: 'old' };
  assert.equal(mergeDisplayedAuth(previous, { sessionId: 's1', status: 'waiting_scan', ignored: 'new' }), previous);
  const changed = mergeDisplayedAuth(previous, { sessionId: 's1', status: 'done' });
  assert.notEqual(changed, previous);
  assert.equal(changed.status, 'done');
});

test('replay AUTH_REQUIRED is retained as terminal instead of starting a second auth loop', () => {
  assert.deepEqual(publishAuthTerminal({ code: 'AUTH_REQUIRED', message: '仍需授权' }, { replay: true }), {
    status: 'failed', error: '仍需授权'
  });
  assert.equal(publishAuthTerminal({ code: 'AUTH_REQUIRED', message: '首次授权' }), null);
});

test('publish timeout is retained as a retryable terminal state', () => {
  assert.deepEqual(publishAuthTerminal({ code: 'AUTH_POLL_TIMEOUT', status: 'timeout', message: '授权轮询超时' }), {
    status: 'timeout', error: '授权轮询超时'
  });
  for (const code of ['AUTH_FAILED', 'AUTH_EXPIRED', 'AUTH_CANCELLED', 'AUTH_SESSION_NOT_FOUND', 'AUTH_NOT_COMPLETED']) {
    assert.ok(publishAuthTerminal({ code, status: code === 'AUTH_SESSION_NOT_FOUND' ? 404 : 'failed', message: code }));
  }
});

test('cancel response only claims cancellation for exact cancelled session', () => {
  assert.deepEqual(interpretCancelResponse('s1', { sessionId: 's1', status: 'cancelled' }), { cancelled: true });
  assert.deepEqual(interpretCancelResponse('s1', { sessionId: 's1', status: 'done' }), {
    cancelled: false, status: 'cancel-not-applied', error: '授权已完成，正在查询同一次发布结果'
  });
  assert.deepEqual(interpretCancelResponse('s1', { sessionId: 'other', status: 'cancelled' }), {
    cancelled: false, status: 'not-found', error: '取消结果与当前授权会话不一致，请重新提交。'
  });
});

test('publish adapter deadline covers the server operation envelope', () => {
  assert.equal(GENERIC_AUTH_DEADLINE_MS, 20_000);
  assert.ok(MINITOOL_PUBLISH_DEADLINE_MS >= 900_000);
});

test('adapter fallback composes caller and deadline aborts and cleans listeners', async () => {
  const originalAny = AbortSignal.any;
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  try {
    const caller = new AbortController();
    const callerAdapter = createRedappFetchAdapter({
      apiBase: '', token: 't', getSignal: caller.signal, deadlineMs: 1000,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    });
    const callerPending = callerAdapter('/caller');
    caller.abort(new DOMException('caller cancelled', 'AbortError'));
    await assert.rejects(callerPending, error => error?.name === 'AbortError');

    const deadlineCaller = new AbortController();
    const deadlineAdapter = createRedappFetchAdapter({
      apiBase: '', token: 't', getSignal: deadlineCaller.signal, deadlineMs: 5,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    });
    await assert.rejects(deadlineAdapter('/deadline'), error => error?.name === 'TimeoutError');

    let added = 0;
    let removed = 0;
    const cleanupCaller = new AbortController();
    const add = cleanupCaller.signal.addEventListener.bind(cleanupCaller.signal);
    const remove = cleanupCaller.signal.removeEventListener.bind(cleanupCaller.signal);
    cleanupCaller.signal.addEventListener = (...args) => { added++; return add(...args); };
    cleanupCaller.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
    const cleanupAdapter = createRedappFetchAdapter({ apiBase: '', token: 't', getSignal: cleanupCaller.signal, fetchImpl: async () => response(200, {}) });
    await cleanupAdapter('/cleanup');
    assert.equal(added, 1);
    assert.equal(removed, 1);
  } finally {
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: originalAny });
  }
});

test('redapp fetch adapter adds bearer token and preserves raw Fetch responses', async () => {
  const calls = [];
  const rawResponse = response(401, { code: 'AUTH_REQUIRED', auth: { sessionId: 's1' } });
  const adapter = createRedappFetchAdapter({
    apiBase: 'https://local.example',
    token: 'workspace-token',
    fetchImpl: async (url, options) => { calls.push([url, options]); return rawResponse; }
  });

  const result = await adapter('/api/publish/minitool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });

  assert.equal(result, rawResponse);
  assert.equal(calls[0][0], 'https://local.example/api/publish/minitool');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer workspace-token');
  assert.equal(calls[0][1].headers.Accept, 'application/json');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
});

test('readApiError preserves safe structured fields without exposing tokens', async () => {
  const error = await readApiError(response(401, {
    error: '需要连接小红书后继续',
    code: 'AUTH_REQUIRED',
    token: 'TEST_TOP_LEVEL_TOKEN',
    auth: {
      sessionId: 's1',
      status: 'waiting_scan',
      qrImage: 'data:image/png;base64,cXI=',
      authorizeUrl: 'https://auth.example/device',
      userCode: 'ABCD',
      expiresAt: 1234,
      token: 'TEST_AUTH_TOKEN',
      credentials: { accessToken: 'TEST_NESTED_TOKEN' }
    }
  }));

  assert.equal(error.message, '需要连接小红书后继续');
  assert.equal(error.message.includes('TEST_'), false);
  assert.equal(error.code, 'AUTH_REQUIRED');
  assert.equal(error.status, 401);
  assert.deepEqual(error.auth, {
    sessionId: 's1',
    status: 'waiting_scan',
    qrImage: 'data:image/png;base64,cXI=',
    authorizeUrl: 'https://auth.example/device',
    userCode: 'ABCD',
    expiresAt: 1234,
    error: null
  });
  assert.equal(JSON.stringify(error).includes('TEST_'), false);
});

test('readApiError returns a fixed safe error for an invalid response body', async () => {
  const error = await readApiError(response(502, new Error('TEST_PARSE_SECRET'), 'Bad Gateway'));
  assert.equal(error.message, 'Bad Gateway');
  assert.equal(error.code, 'API_ERROR');
  assert.equal(error.status, 502);
  assert.equal(JSON.stringify(error).includes('TEST_PARSE_SECRET'), false);
});

test('readApiError discards entire messages containing normalized sensitive markers', async () => {
  const cases = [
    ['openId=FULL_OPEN_ID', 'FULL_OPEN_ID'],
    ['access token is ACCESS_SECRET', 'ACCESS_SECRET'],
    ['apiKey=API_VALUE', 'API_VALUE'],
    ['MiXeD ReFrEsH__ToKeN is REFRESH_SECRET', 'REFRESH_SECRET'],
    ['credential-path C:/private/credentials.json', 'C:/private/credentials.json']
  ];

  for (const [message, secret] of cases) {
    const error = await readApiError(response(500, {
      error: `request failed: ${message}; arbitrary suffix must disappear`,
      code: 'SERVER_ERROR',
      auth: { sessionId: 's1', status: 'failed', error: `nested ${message}; nested suffix` }
    }));

    assert.equal(error.message, '请求失败');
    assert.equal(error.auth.error, '');
    assert.equal(error.message.includes('arbitrary suffix'), false);
    assert.equal(error.auth.error.includes('nested suffix'), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
  }
});

test('readApiError preserves ordinary messages and projects auth fields by type', async () => {
  const error = await readApiError(response(400, {
    error: 'ordinary request failure',
    code: 'SAFE_CODE',
    auth: {
      sessionId: 123,
      status: {},
      qrImage: 'qr',
      authorizeUrl: 42,
      userCode: 'code',
      expiresAt: Infinity,
      error: 'ordinary nested failure',
      unknown: 'drop me'
    }
  }));

  assert.equal(error.message, 'ordinary request failure');
  assert.equal(error.code, 'SAFE_CODE');
  assert.deepEqual(error.auth, {
    qrImage: 'qr',
    userCode: 'code',
    error: 'ordinary nested failure'
  });
});

test('auth client calls status, login, session, cancel, and logout endpoints', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push([path, options.method || 'GET']);
    return response(200, { path });
  };
  const client = createRedappAuthClient({ api, pollMs: 0 });

  await client.status();
  await client.login();
  await client.session('session / one');
  await client.cancel('session / one');
  await client.logout();

  assert.deepEqual(calls, [
    ['/api/redapp/auth', 'GET'],
    ['/api/redapp/auth/login', 'POST'],
    ['/api/redapp/auth/session/session%20%2F%20one', 'GET'],
    ['/api/redapp/auth/session/session%20%2F%20one/cancel', 'POST'],
    ['/api/redapp/auth/logout', 'POST']
  ]);
});

test('auth client methods reject failed responses with structured safe errors', async () => {
  const client = createRedappAuthClient({
    api: async () => response(401, {
      error: 'auth',
      code: 'AUTH_REQUIRED',
      auth: { sessionId: 's1', status: 'waiting_prompt', token: 'TEST_TOKEN' }
    }),
    pollMs: 0
  });

  await assert.rejects(client.login, error => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.equal(error.status, 401);
    assert.equal(error.auth.sessionId, 's1');
    assert.equal(JSON.stringify(error).includes('TEST_TOKEN'), false);
    return true;
  });
});

test('polling returns the exact session only when it reaches done', async () => {
  const seen = [];
  const updates = [];
  const states = ['waiting_prompt', 'waiting_scan', 'done'];
  const client = createRedappAuthClient({
    api: async path => {
      seen.push(path);
      return response(200, { sessionId: 'exact', status: states.shift() });
    },
    pollMs: 0
  });

  const session = await client.pollSession('exact', {
    timeoutMs: 1000,
    onUpdate: current => updates.push(current.status)
  });
  assert.deepEqual(session, { sessionId: 'exact', status: 'done' });
  assert.equal(seen.length, 3);
  assert.ok(seen.every(path => path.endsWith('/exact')));
  assert.deepEqual(updates, ['waiting_prompt', 'waiting_scan', 'done']);
});

for (const status of ['failed', 'expired', 'cancelled']) {
  test(`polling rejects terminal ${status} sessions with a fixed safe error`, async () => {
    const client = createRedappAuthClient({
      api: async () => response(200, { sessionId: 's1', status, error: 'TEST_SERVER_SECRET' }),
      pollMs: 0
    });

    await assert.rejects(() => client.pollSession('s1'), error => {
      assert.equal(error.code, `AUTH_${status.toUpperCase()}`);
      assert.equal(error.status, status);
      assert.equal(error.message.includes('TEST_SERVER_SECRET'), false);
      return true;
    });
  });
}

test('polling rejects responses without the exact string session id before status handling', async () => {
  for (const sessionId of [undefined, 123, '', 'other']) {
    const client = createRedappAuthClient({
      api: async () => response(200, { sessionId, status: 'done' }),
      pollMs: 0
    });

    await assert.rejects(() => client.pollSession('expected'), error => {
      assert.equal(error.code, 'AUTH_SESSION_NOT_FOUND');
      assert.equal(error.message, '授权会话不存在或已失效');
      return true;
    });
  }
});

test('polling requires a nonempty expected session id without requesting', async () => {
  for (const id of [undefined, null, 123, '', '   ']) {
    let calls = 0;
    const client = createRedappAuthClient({
      api: async () => { calls++; return response(200, { sessionId: id, status: 'done' }); },
      pollMs: 0
    });

    await assert.rejects(() => client.pollSession(id), error => error.code === 'AUTH_SESSION_NOT_FOUND');
    assert.equal(calls, 0);
  }
});

test('polling returns valid exact done response', async () => {
  const client = createRedappAuthClient({
    api: async () => response(200, { sessionId: 'expected', status: 'done' }),
    pollMs: 0
  });

  assert.deepEqual(await client.pollSession('expected'), { sessionId: 'expected', status: 'done' });
});

test('polling maps a missing session to a fixed safe not-found error', async () => {
  const client = createRedappAuthClient({
    api: async () => response(404, { error: 'session_not_found', token: 'TEST_TOKEN' }),
    pollMs: 0
  });

  await assert.rejects(() => client.pollSession('missing'), error => {
    assert.equal(error.code, 'AUTH_SESSION_NOT_FOUND');
    assert.equal(error.status, 404);
    assert.equal(error.message, '授权会话不存在或已失效');
    assert.equal(JSON.stringify(error).includes('TEST_TOKEN'), false);
    return true;
  });
});

test('polling timeout is explicit and does not perform an API request', async () => {
  let calls = 0;
  const client = createRedappAuthClient({
    api: async () => { calls++; return response(200, { status: 'waiting_scan' }); },
    pollMs: 0
  });

  await assert.rejects(() => client.pollSession('s1', { timeoutMs: 0 }), error => {
    assert.equal(error.code, 'AUTH_POLL_TIMEOUT');
    assert.equal(error.status, 'timeout');
    return true;
  });
  assert.equal(calls, 0);
});

test('polling cancellation is explicit and does not perform another API request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = createRedappAuthClient({
    api: async () => { calls++; return response(200, { status: 'waiting_scan' }); },
    pollMs: 0
  });

  await assert.rejects(() => client.pollSession('s1', { signal: controller.signal }), error => {
    assert.equal(error.code, 'AUTH_POLL_CANCELLED');
    assert.equal(error.status, 'cancelled');
    return true;
  });
  assert.equal(calls, 0);
});

test('polling cancellation wins while a session request is pending', async () => {
  const controller = new AbortController();
  const client = createRedappAuthClient({
    api: () => new Promise(() => {}),
    pollMs: 0
  });

  const pending = client.pollSession('s1', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'AUTH_POLL_CANCELLED');
});

test('polling timeout wins while a session request is pending', async () => {
  const client = createRedappAuthClient({
    api: () => new Promise(() => {}),
    pollMs: 0
  });

  await assert.rejects(() => client.pollSession('s1', { timeoutMs: 5 }), error => error.code === 'AUTH_POLL_TIMEOUT');
});

test('polling rejects unknown session states instead of waiting indefinitely', async () => {
  const client = createRedappAuthClient({
    api: async () => response(200, { sessionId: 's1', status: 'unexpected' }),
    pollMs: 0
  });

  await assert.rejects(() => client.pollSession('s1'), error => error.code === 'AUTH_NOT_COMPLETED');
});

test('replays publish exactly once after login succeeds', async () => {
  let calls = 0;
  const events = [];
  const result = await publishWithAuth({
    publish: async () => {
      calls++;
      if (calls === 1) throw authRequired('s1');
      return { ok: true };
    },
    pollSession: async id => {
      assert.equal(id, 's1');
      return { sessionId: id, status: 'done' };
    },
    onAuthRequired: auth => events.push(['required', auth.sessionId]),
    onAuthorized: session => events.push(['authorized', session.sessionId])
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(events, [['required', 's1'], ['authorized', 's1']]);
});

test('explicit polling cancellation becomes AUTH_NOT_COMPLETED and never replays', async () => {
  let calls = 0;
  await assert.rejects(() => publishWithAuth({
    publish: async () => { calls++; throw authRequired('s1'); },
    pollSession: async () => { throw Object.assign(new Error('stopped'), { code: 'AUTH_POLL_CANCELLED' }); }
  }), error => error.code === 'AUTH_NOT_COMPLETED' && error.status === 'cancelled');
  assert.equal(calls, 1);
});

test('does not loop when replay also returns AUTH_REQUIRED', async () => {
  let calls = 0;
  await assert.rejects(() => publishWithAuth({
    publish: async () => { calls++; throw authRequired('s1'); },
    pollSession: async () => ({ sessionId: 's1', status: 'done' }),
    onAuthRequired: () => {},
    onAuthorized: () => {}
  }), error => error.code === 'AUTH_REQUIRED');
  assert.equal(calls, 2);
});

test('does not replay when polling result lacks the exact string session id', async () => {
  for (const sessionId of [undefined, 123, '', 'other']) {
    let calls = 0;
    await assert.rejects(() => publishWithAuth({
      publish: async () => { calls++; throw authRequired('s1'); },
      pollSession: async () => ({ sessionId, status: 'done' }),
      onAuthRequired: () => {},
      onAuthorized: () => { throw new Error('must not authorize'); }
    }), error => error.code === 'AUTH_SESSION_NOT_FOUND');
    assert.equal(calls, 1);
  }
});

test('does not replay when AUTH_REQUIRED lacks a nonempty string session id', async () => {
  for (const sessionId of [undefined, 123, '', '   ']) {
    let calls = 0;
    let polls = 0;
    await assert.rejects(() => publishWithAuth({
      publish: async () => { calls++; throw authRequired(sessionId); },
      pollSession: async () => { polls++; return { sessionId, status: 'done' }; },
      onAuthRequired: () => {},
      onAuthorized: () => {}
    }), error => error.code === 'AUTH_SESSION_NOT_FOUND');
    assert.equal(calls, 1);
    assert.equal(polls, 0);
  }
});

for (const status of ['failed', 'expired', 'cancelled', 'not-found']) {
  test(`does not replay publish when authorization is ${status}`, async () => {
    let calls = 0;
    await assert.rejects(() => publishWithAuth({
      publish: async () => { calls++; throw authRequired('s1'); },
      pollSession: async id => ({ sessionId: id, status }),
      onAuthRequired: () => {},
      onAuthorized: () => { throw new Error('must not authorize'); }
    }), error => error.code === (status === 'not-found' ? 'AUTH_SESSION_NOT_FOUND' : `AUTH_${status.toUpperCase()}`));
    assert.equal(calls, 1);
  });
}

test('does not enter authorization flow for unrelated publish errors', async () => {
  const original = Object.assign(new Error('publish failed'), { code: 'PUBLISH_FAILED' });
  let polled = false;
  await assert.rejects(() => publishWithAuth({
    publish: async () => { throw original; },
    pollSession: async () => { polled = true; },
    onAuthRequired: () => {},
    onAuthorized: () => {}
  }), error => error === original);
  assert.equal(polled, false);
});
