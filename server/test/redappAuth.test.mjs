import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { createRedappAuthManager } from '../src/lib/redappAuth.js';
import { paths } from '../src/paths.js';
import {
  createAsyncProcessRunner,
  createRedappCliEnsurer,
  createRedappCliEnsurerAsync,
  createRedappCommandRunner,
  createRedappCommandRunnerAsync,
  createRedappOperations,
  createRedappOperationsAsync,
  createRedappNpmEnv,
  createRedappQrReader,
  parseTaggedOutput,
  redappSkillGatePath,
  sanitizeCredentials
} from '../src/lib/redappCli.js';

let createRedappAuthRouter;
let createMiniToolPublishHandler;
let createMiniToolPublishJobRegistry;
let createMiniToolPublishRouter;
let publishQueue;

test.before(async () => {
  process.env.TEST_DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test?sslmode=disable';
  ({ createRedappAuthRouter } = await import('../src/routes/redappAuth.js'));
  ({ createMiniToolPublishHandler, createMiniToolPublishJobRegistry, createMiniToolPublishRouter, publishQueue } = await import('../src/routes/publish.js'));
});

test.after(async () => {
  await publishQueue.disconnect();
});

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killCount = 0;
  child.kill = () => {
    child.killed = true;
    child.killCount += 1;
    return true;
  };
  return child;
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

async function invokeHandler(handler, body = {}, userId = 'user-1') {
  const response = createResponse();
  await handler({ body, user: { userId }, params: { attemptId: body.attemptId } }, response, error => { throw error; });
  return response;
}

test('maps only CLI AUTH_REQUIRED to safe available logged-out status', async () => {
  const parsed = parseTaggedOutput('RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED","message":"TEST_AUTH_SECRET"}');
  assert.deepEqual(parsed.results, [{ status: 'error', code: 'AUTH_REQUIRED' }]);
  assert.equal(JSON.stringify(parsed).includes('TEST_AUTH_SECRET'), false);
  assert.equal(parseTaggedOutput(`RESULT_JSON:${JSON.stringify({ status: 'error', code: 'x'.repeat(256) })}`).results[0].code.length, 128);

  const runCli = createRedappCommandRunnerAsync({
    ensureCli: async () => ({ status: 'current' }),
    execute: async () => ({
      status: 0,
      stdout: 'RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED","message":"TEST_AUTH_SECRET"}',
      stderr: '',
      error: null
    })
  });
  const manager = createRedappAuthManager({
    spawnCli: () => createFakeChild(),
    runCli,
    readFile: () => Buffer.from('qr')
  });
  assert.deepEqual(await manager.getStatus(), {
    available: true,
    loggedIn: false,
    openIdMasked: null,
    scope: [],
    expireTimeMs: null,
    refreshExpireTimeMs: null,
    needsReauth: true
  });
});

test('nonzero exact AUTH_REQUIRED remains a safe available logged-out status', async () => {
  const runCli = createRedappCommandRunnerAsync({
    ensureCli: async () => ({ status: 'current' }),
    execute: async () => ({
      status: 17,
      stdout: 'RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED","message":"TEST_AUTH_SECRET"}',
      stderr: '',
      error: null
    })
  });
  const manager = createRedappAuthManager({
    spawnCli: () => createFakeChild(),
    runCli,
    readFile: () => Buffer.from('qr')
  });

  assert.deepEqual(await manager.getStatus(), {
    available: true,
    loggedIn: false,
    openIdMasked: null,
    scope: [],
    expireTimeMs: null,
    refreshExpireTimeMs: null,
    needsReauth: true
  });
});

test('execution errors and non-AUTH_REQUIRED nonzero results stay unavailable', async () => {
  const executions = [
    { status: 17, stdout: 'RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED"}', stderr: '', error: new Error('compromised') },
    { status: 17, stdout: 'RESULT_JSON:{"status":"error","code":"OTHER"}', stderr: '', error: null },
    { status: 17, stdout: 'RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED","command":"whoami"}', stderr: '', error: null },
    { status: 17, stdout: 'RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true}}', stderr: '', error: null },
    { status: 17, stdout: 'RESULT_JSON:{malformed', stderr: '', error: null }
  ];

  for (const execution of executions) {
    const runCli = createRedappCommandRunnerAsync({
      ensureCli: async () => ({ status: 'current' }),
      execute: async () => execution
    });
    await assert.rejects(() => runCli(['whoami']), /redapp 命令执行失败/);
  }
});

test('exact AUTH_REQUIRED rejects abnormal process statuses', async () => {
  for (const status of [null, undefined, '1', NaN, Infinity]) {
    const runCli = createRedappCommandRunnerAsync({
      ensureCli: async () => ({ status: 'current' }),
      execute: async () => ({
        status,
        stdout: 'RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED"}',
        stderr: '',
        error: null
      })
    });
    await assert.rejects(() => runCli(['whoami']), { message: 'redapp 命令执行失败' });
  }
});

test('null process status projects manager status as unavailable', async () => {
  const runCli = createRedappCommandRunnerAsync({
    ensureCli: async () => ({ status: 'current' }),
    execute: async () => ({
      status: null,
      stdout: 'RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED"}',
      stderr: '',
      error: null
    })
  });
  const manager = createRedappAuthManager({
    spawnCli: () => createFakeChild(),
    runCli,
    readFile: () => Buffer.from('qr')
  });

  assert.deepEqual(await manager.getStatus(), {
    available: false,
    loggedIn: false,
    openIdMasked: null,
    scope: [],
    expireTimeMs: null,
    refreshExpireTimeMs: null,
    needsReauth: true,
    error: 'redapp CLI 不可用'
  });
});

test('null process status publish returns unavailable before all work', async () => {
  const calls = [];
  const runCli = createRedappCommandRunnerAsync({
    ensureCli: async () => ({ status: 'current' }),
    execute: async () => ({
      status: null,
      stdout: 'RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED"}',
      stderr: '',
      error: null
    })
  });
  const manager = createRedappAuthManager({
    spawnCli: () => { calls.push('login'); return createFakeChild(); },
    runCli,
    readFile: () => Buffer.from('qr')
  });
  const handler = createMiniToolPublishHandler({
    authManager: manager,
    buildMiniToolZip: async () => { calls.push('build'); },
    runAudit: () => { calls.push('audit'); return { output: '' }; },
    uploadPackage: async () => { calls.push('upload'); },
    createPreview: async () => { calls.push('preview'); }
  });

  const response = await invokeHandler(handler, { attemptId: 'attempt-auth', title: '标题', content: '', tags: [], images: ['https://example.test/a.jpg'] });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: 'redapp CLI 不可用', code: 'REDAPP_UNAVAILABLE' });
  assert.deepEqual(calls, []);
  manager.dispose();
});

test('nonzero AUTH_REQUIRED publish starts login before build audit upload or preview', async () => {
  const calls = [];
  const runCli = createRedappCommandRunnerAsync({
    ensureCli: async () => ({ status: 'current' }),
    execute: async () => ({ status: 17, stdout: 'RESULT_JSON:{"status":"error","code":"AUTH_REQUIRED"}', stderr: '', error: null })
  });
  const manager = createRedappAuthManager({
    spawnCli: () => { calls.push('login'); return createFakeChild(); },
    runCli,
    readFile: () => Buffer.from('qr')
  });
  const handler = createMiniToolPublishHandler({
    authManager: manager,
    buildMiniToolZip: async () => { calls.push('build'); },
    runAudit: () => { calls.push('audit'); return { output: '' }; },
    uploadPackage: async () => { calls.push('upload'); },
    createPreview: async () => { calls.push('preview'); }
  });
  const response = await invokeHandler(handler, { attemptId: 'attempt-auth', title: '标题', content: '', tags: [], images: ['https://example.test/a.jpg'] });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'AUTH_REQUIRED');
  assert.equal(response.body.auth.status, 'waiting_prompt');
  assert.deepEqual(calls, ['login']);
  manager.dispose();
});

test('production skill gate is rooted in the repository and independent of user skill junctions', () => {
  assert.equal(redappSkillGatePath, path.join(paths.root, '.skills', 'redapp-cli', 'scripts', 'ensure-cli.mjs'));
  assert.equal(redappSkillGatePath.includes(path.join('.claude', 'skills')), false);
});

test('async process runner finalizes error without close and removes listeners', async () => {
  const child = createFakeChild();
  const run = createAsyncProcessRunner({ spawnProcess: () => child });
  const resultPromise = run(['fake'], 1000);
  child.emit('error', new Error('TEST_PROCESS_SECRET'));
  const result = await resultPromise;
  assert.equal(result.status, null);
  assert.equal(result.error?.message, 'process_error');
  assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
});

test('async process runner timeout kills and settles after close', async () => {
  const child = createFakeChild();
  let timeoutCallback;
  const cleared = [];
  const timer = { unref() {} };
  const run = createAsyncProcessRunner({
    spawnProcess: () => child,
    platform: 'linux',
    terminateTree: async () => true,
    setTimer(callback) { timeoutCallback = callback; return timer; },
    clearTimer(value) { cleared.push(value); }
  });
  let settled = false;
  const resultPromise = run(['fake'], 10).then(result => { settled = true; return result; });
  timeoutCallback(); await tick();
  assert.equal(child.killCount, 0);
  assert.equal(settled, true);
  const result = await resultPromise;
  assert.equal(result.error?.message, 'timeout');
  assert.equal(cleared.length, 3);
  assert.equal(cleared.every(value => value === timer), true);
  assert.equal(child.listenerCount('close'), 0);
});

test('async process runner close clears timer, caps output, and ignores late terminals', async () => {
  const child = createFakeChild();
  const baselineErrorHandler = () => {};
  child.on('error', baselineErrorHandler);
  let timeoutCallback;
  let resolveCount = 0;
  const timer = { unref() {} };
  const cleared = [];
  const run = createAsyncProcessRunner({
    spawnProcess: () => child,
    setTimer(callback) { timeoutCallback = callback; return timer; },
    clearTimer(value) { cleared.push(value); },
    maxOutputBytes: 4
  });
  const resultPromise = run(['fake'], 10).then(result => { resolveCount += 1; return result; });
  child.stdout.write('abcdef');
  child.stderr.write('uvwxyz');
  child.emit('close', 0);
  const result = await resultPromise;
  assert.deepEqual(result, { status: 0, stdout: 'abcd', stderr: 'uvwx', error: null });
  assert.deepEqual(cleared, [timer]);
  assert.equal(child.listenerCount('error'), 1);
  assert.equal(child.listeners('error')[0], baselineErrorHandler);
  assert.equal(child.listenerCount('close'), 0);
  assert.doesNotThrow(() => child.emit('close', 9));
  assert.doesNotThrow(() => child.emit('error', new Error('late')));
  timeoutCallback();
  await tick();
  assert.equal(resolveCount, 1);
  assert.equal(child.killCount, 0);
});

test('async process runner captures many tiny chunks exactly up to each byte cap', async () => {
  const child = createFakeChild();
  const run = createAsyncProcessRunner({ spawnProcess: () => child, maxOutputBytes: 4097 });
  const pending = run(['fake'], 1000);

  for (let index = 0; index < 5000; index += 1) {
    child.stdout.write(Buffer.from([97 + (index % 26)]));
    child.stderr.write(Buffer.from([65 + (index % 26)]));
  }
  child.emit('close', 0);

  const result = await pending;
  assert.equal(Buffer.byteLength(result.stdout), 4097);
  assert.equal(Buffer.byteLength(result.stderr), 4097);
  assert.equal(result.stdout, Array.from({ length: 4097 }, (_, index) => String.fromCharCode(97 + (index % 26))).join(''));
  assert.equal(result.stderr, Array.from({ length: 4097 }, (_, index) => String.fromCharCode(65 + (index % 26))).join(''));
});

test('async process runner safely handles missing output streams and synchronous spawn throws', async () => {
  const streamless = new EventEmitter();
  streamless.kill = () => true;
  const runStreamless = createAsyncProcessRunner({ spawnProcess: () => streamless });
  const pending = runStreamless(['fake'], 1000);
  streamless.emit('close', 0);
  assert.deepEqual(await pending, { status: 0, stdout: '', stderr: '', error: null });

  const runThrowing = createAsyncProcessRunner({ spawnProcess: () => { throw new Error('TEST_SPAWN_SECRET'); } });
  const thrown = await runThrowing(['fake'], 1000);
  assert.equal(thrown.error?.message, 'process_error');
  assert.equal(JSON.stringify(thrown).includes('TEST_SPAWN_SECRET'), false);
});

test('projects CLI failures as a safe unavailable auth status', async () => {
  const manager = createRedappAuthManager({
    spawnCli: () => createFakeChild(),
    runCli: () => { throw new Error('secret credential path C:/private/token.json'); },
    readFile: () => Buffer.from('qr')
  });
  assert.deepEqual(await manager.getStatus(), {
    available: false,
    loggedIn: false,
    openIdMasked: null,
    scope: [],
    expireTimeMs: null,
    refreshExpireTimeMs: null,
    needsReauth: true,
    error: 'redapp CLI 不可用'
  });
});

test('minitool publish returns AUTH_REQUIRED before building files', async () => {
  let built = false;
  const handler = createMiniToolPublishHandler({
    authManager: {
      getStatus: () => ({ available: true, loggedIn: false }),
      startLogin: () => ({ sessionId: 's1', status: 'waiting_scan' })
    },
    buildMiniToolZip: async () => { built = true; },
    runAudit: () => ({ output: '' }),
    uploadPackage: async () => ({}),
    createPreview: async () => ({})
  });
  const response = await invokeHandler(handler, { attemptId: 'attempt-auth', title: '标题', content: '', tags: [], images: ['https://example.test/a.jpg'] });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'AUTH_REQUIRED');
  assert.deepEqual(response.body.auth, { sessionId: 's1', status: 'waiting_scan' });
  assert.equal(built, false);
});

test('minitool publish treats expired credentials as AUTH_REQUIRED before building', async () => {
  let built = false;
  const handler = createMiniToolPublishHandler({
    authManager: {
      getStatus: () => ({ available: true, loggedIn: true, needsReauth: true }),
      startLogin: () => ({ sessionId: 'expired', status: 'waiting_prompt' })
    },
    buildMiniToolZip: async () => { built = true; },
    runAudit: () => ({ output: '' }),
    uploadPackage: async () => ({}),
    createPreview: async () => ({})
  });
  const response = await invokeHandler(handler, { attemptId: 'attempt-auth', title: '标题', content: '', tags: [], images: ['https://example.test/a.jpg'] });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'AUTH_REQUIRED');
  assert.equal(response.body.auth.sessionId, 'expired');
  assert.equal(built, false);
});

test('minitool publish returns safe unavailable response before building files', async () => {
  let built = false;
  const handler = createMiniToolPublishHandler({
    authManager: { getStatus: () => ({ available: false, loggedIn: false, error: 'safe unavailable' }) },
    buildMiniToolZip: async () => { built = true; },
    runAudit: () => ({ output: '' }),
    uploadPackage: async () => ({}),
    createPreview: async () => ({})
  });
  const response = await invokeHandler(handler, { attemptId: 'attempt-auth', title: '标题', content: '', tags: [], images: ['https://example.test/a.jpg'] });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: 'safe unavailable', code: 'REDAPP_UNAVAILABLE' });
  assert.equal(built, false);
});

test('minitool publish job returns immediately and concurrent duplicates execute once', async () => {
  let resolveBuild;
  let builds = 0;
  let uploads = 0;
  let previews = 0;
  const registry = createMiniToolPublishJobRegistry({ terminalTtlMs: 60_000, maxEntries: 100 });
  const handler = createMiniToolPublishHandler({
    authManager: { getStatus: () => ({ available: true, loggedIn: true, needsReauth: false }) },
    registry,
    buildMiniToolZip: async () => {
      builds += 1;
      await new Promise(resolve => { resolveBuild = resolve; });
      return { dir: '/safe/build', zipPath: '/safe/build/package.zip', size: 12, imageCount: 1 };
    },
    runAudit: target => ({ target, output: 'OK' }),
    uploadPackage: async () => { uploads += 1; return { fileId: 'file', md5: 'md5' }; },
    createPreview: async () => { previews += 1; return { previewUrl: 'https://safe.test/preview' }; },
    readQrImage: () => null
  });
  const body = { attemptId: 'attempt-1234', title: '标题', content: '', tags: [], images: ['https://example.test/a.jpg'] };
  const [first, duplicate] = await Promise.all([invokeHandler(handler, body), invokeHandler(handler, body)]);
  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.body, { attemptId: body.attemptId, status: 'running' });
  assert.equal(duplicate.statusCode, 202);
  assert.equal(builds, 1);
  resolveBuild();
  await registry.get('user-1', body.attemptId).promise;
  assert.equal(uploads, 1);
  assert.equal(previews, 1);
  assert.equal(registry.toDto(registry.get('user-1', body.attemptId)).status, 'done');
  registry.dispose();
});

test('minitool job lookup is owner-bound and failures are safe', async () => {
  const registry = createMiniToolPublishJobRegistry({ terminalTtlMs: 60_000, maxEntries: 100 });
  registry.createOrReuse('owner', 'attempt-safe', async () => { throw new Error('TOKEN=/private/raw'); });
  await registry.get('owner', 'attempt-safe').promise;
  const owner = registry.toDto(registry.get('owner', 'attempt-safe'));
  assert.deepEqual(owner, { attemptId: 'attempt-safe', status: 'failed', error: '扫码直达发布失败，请重新提交' });
  assert.equal(registry.get('other', 'attempt-safe'), null);
  assert.equal(JSON.stringify(owner).includes('TOKEN'), false);
  registry.dispose();
});

test('minitool registry expires terminal jobs, keeps running jobs, and caps entries', async () => {
  let now = 0;
  let finish;
  const registry = createMiniToolPublishJobRegistry({ terminalTtlMs: 30, maxEntries: 2, perUserLimit: 2, now: () => now });
  registry.createOrReuse('u', 'done-1', async () => ({ ok: true }));
  await registry.get('u', 'done-1').promise;
  registry.createOrReuse('u', 'running-1', () => new Promise(resolve => { finish = resolve; }));
  now = 31;
  registry.cleanup();
  assert.equal(registry.get('u', 'done-1'), null);
  assert.equal(registry.get('u', 'running-1').status, 'running');
  registry.createOrReuse('u', 'done-2', async () => ({ ok: true }));
  await registry.get('u', 'done-2').promise;
  registry.createOrReuse('u', 'done-3', async () => ({ ok: true }));
  await registry.get('u', 'done-3').promise;
  assert.equal(registry.get('u', 'running-1').status, 'running');
  finish({ ok: true });
  registry.dispose();
});

test('minitool registry rejects new jobs at capacity without evicting running work', async () => {
  const registry = createMiniToolPublishJobRegistry({ maxEntries: 1, terminalTtlMs: 60_000 });
  let finish;
  const running = registry.createOrReuse('u', 'running-1', () => new Promise(resolve => { finish = resolve; }));
  await tick();
  assert.throws(
    () => registry.createOrReuse('u', 'running-2', async () => ({ ok: true })),
    error => error.code === 'PUBLISH_JOB_CAPACITY'
  );
  assert.equal(registry.get('u', 'running-1').status, 'running');
  finish({ ok: true });
  await running.promise;
  registry.dispose();
});

test('minitool router rejects invalid attempt ids and applies auth before job creation', async () => {
  let created = 0;
  const registry = {
    get() { return null; },
    createOrReuse() { created += 1; throw new Error('must not run'); },
    toDto() { return null; }
  };
  const router = createMiniToolPublishRouter({
    verify: (req, res) => res.status(401).json({ error: 'unauthorized' }),
    registry,
    authManager: { getStatus: () => ({ available: true, loggedIn: true }) },
    buildMiniToolZip: async () => ({}), runAudit: () => ({}), uploadPackage: async () => ({}), createPreview: async () => ({})
  });
  const unauthorized = createResponse();
  await new Promise(resolve => {
    router.handle({ method: 'POST', url: '/', originalUrl: '/', path: '/', body: { attemptId: 'attempt-1234' } }, unauthorized, resolve);
    setImmediate(resolve);
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(created, 0);

  const handler = createMiniToolPublishHandler({
    authManager: { getStatus: () => ({ available: true, loggedIn: true }) }, registry,
    buildMiniToolZip: async () => ({}), runAudit: () => ({}), uploadPackage: async () => ({}), createPreview: async () => ({})
  });
  const invalid = await invokeHandler(handler, { attemptId: '../bad', title: 'x', images: ['x'] });
  assert.equal(invalid.statusCode, 400);
  assert.equal(created, 0);
});

test('authorization router applies JWT middleware before route handlers', async () => {
  let statusCalls = 0;
  const router = createRedappAuthRouter({
    authManager: { getStatus: () => { statusCalls += 1; return {}; } },
    verify: (req, res) => res.status(401).json({ error: 'unauthorized' })
  });
  const response = createResponse();
  const request = { method: 'GET', url: '/', originalUrl: '/', path: '/' };
  await new Promise((resolve, reject) => {
    router.handle(request, response, error => error ? reject(error) : resolve());
    setImmediate(resolve);
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: 'unauthorized' });
  assert.equal(statusCalls, 0);
});

test('authorization router protects every endpoint and delegates safe manager DTOs', async () => {
  const calls = [];
  const manager = {
    getStatus: () => ({ available: true, loggedIn: false }),
    startLogin: () => ({ sessionId: 's1', status: 'waiting_prompt' }),
    getSession: id => id === 's1' ? ({ sessionId: id, status: 'waiting_scan', qrImage: 'data:image/png;base64,cXI=' }) : null,
    cancelLogin: id => { calls.push(['cancel', id]); return { sessionId: id, status: 'cancelled' }; },
    logout: () => { calls.push(['logout']); return { available: true, loggedIn: false }; }
  };
  const verified = [];
  const router = createRedappAuthRouter({
    authManager: manager,
    verify: (req, res, next) => { verified.push(req.path); next(); }
  });
  const stack = router.stack;
  assert.equal(stack[0].handle, router.stack[0].handle);
  const route = (method, path) => stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
  const requests = [
    ['get', '/', {}, { available: true, loggedIn: false }],
    ['post', '/login', {}, { sessionId: 's1', status: 'waiting_prompt' }],
    ['get', '/session/:id', { params: { id: 's1' } }, { sessionId: 's1', status: 'waiting_scan', qrImage: 'data:image/png;base64,cXI=' }],
    ['post', '/session/:id/cancel', { params: { id: 's1' } }, { sessionId: 's1', status: 'cancelled' }],
    ['post', '/logout', {}, { available: true, loggedIn: false }]
  ];
  for (const [method, path, request, expected] of requests) {
    const response = createResponse();
    await route(method, path)(request, response, error => { throw error; });
    assert.deepEqual(response.body, expected);
  }
  assert.deepEqual(calls, [['cancel', 's1'], ['logout']]);
});

test('authorization router returns 404 when a session is not found', async () => {
  const router = createRedappAuthRouter({
    authManager: { getSession: () => null },
    verify: (req, res, next) => next()
  });
  const handler = router.stack.find(layer => layer.route?.path === '/session/:id' && layer.route.methods.get).route.stack[0].handle;
  const response = createResponse();
  await handler({ params: { id: 'missing' } }, response, error => { throw error; });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { error: 'session_not_found' });
});

test('accepts URL and code only prompts without reading a QR file', async () => {
  const fake = createFakeChild();
  let readCount = 0;
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => { readCount += 1; throw new Error('must not read'); },
    now: () => 1000,
    randomId: () => 'link-session'
  });

  manager.startLogin();
  fake.stdout.write('PROMPT:{"authorizeUrl":"https://auth.example/device","userCode":"ABCD-EFGH","expiresInSeconds":30}\n');
  await tick();

  assert.deepEqual(manager.getSession('link-session'), {
    sessionId: 'link-session',
    status: 'waiting_scan',
    qrImage: null,
    authorizeUrl: 'https://auth.example/device',
    userCode: 'ABCD-EFGH',
    expiresAt: 31000,
    auth: null,
    error: null
  });
  assert.equal(readCount, 0);
});

test('accepts URL and code only prompts from stderr without exposing raw output', async () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => { throw new Error('must not read'); },
    now: () => 1000,
    randomId: () => 'stderr-link-session'
  });

  manager.startLogin();
  fake.stderr.write('raw secret TEST_STDERR_SECRET\n');
  fake.stderr.write('PROMPT:{"authorizeUrl":"https://auth.example/device","userCode":"STDERR-CODE","expiresInSeconds":30}\n');
  await tick();

  const session = manager.getSession('stderr-link-session');
  assert.equal(session.status, 'waiting_scan');
  assert.equal(session.authorizeUrl, 'https://auth.example/device');
  assert.equal(session.userCode, 'STDERR-CODE');
  assert.equal(JSON.stringify(session).includes('TEST_STDERR_SECRET'), false);
});

test('accepts successful RESULT_JSON entirely from stderr and releases both streams', async () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'stderr-result-session'
  });

  manager.startLogin();
  fake.stderr.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openIdMasked":"ob12…7890"}}\n');
  await tick();

  const session = manager.getSession('stderr-result-session');
  assert.equal(session.status, 'done');
  assert.equal(session.auth.loggedIn, true);
  assert.equal(fake.stdout.listenerCount('data'), 0);
  assert.equal(fake.stderr.listenerCount('data'), 0);
  assert.equal(fake.listenerCount('close'), 0);
});

test('decodes split multibyte stderr without mixing stdout fragments', async () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'stderr-utf8-session'
  });

  manager.startLogin();
  fake.stdout.write('PROMPT:{"authorizeUrl":"https://must-not-combine/');
  const line = Buffer.from('PROMPT:{"authorizeUrl":"https://auth.example/登录","userCode":"中文"}\n');
  const splitAt = line.indexOf(Buffer.from('登')) + 1;
  fake.stderr.write(line.subarray(0, splitAt));
  fake.stderr.write(line.subarray(splitAt));
  await tick();

  const session = manager.getSession('stderr-utf8-session');
  assert.equal(session.status, 'waiting_scan');
  assert.equal(session.authorizeUrl, 'https://auth.example/登录');
  assert.equal(session.userCode, '中文');
});

test('fails safely on overlong complete or unterminated stderr lines', async () => {
  for (const [id, suffix] of [['stderr-complete', '\n'], ['stderr-incomplete', '']]) {
    const fake = createFakeChild();
    const manager = createRedappAuthManager({
      spawnCli: () => fake,
      runCli: async () => ({ credentials: { loggedIn: false } }),
      readFile: () => Buffer.from('png'),
      randomId: () => id
    });

    manager.startLogin();
    fake.stderr.write('x'.repeat(64 * 1024 + 1) + suffix);
    await tick();

    const session = manager.getSession(id);
    assert.equal(session.status, 'failed');
    assert.equal(session.error, '登录进程输出异常');
    assert.equal(JSON.stringify(session).includes('x'.repeat(100)), false);
  }
});

test('reuses one active login session and sanitizes completion', async () => {
  const fake = createFakeChild();
  let spawnCount = 0;
  const manager = createRedappAuthManager({
    spawnCli: () => { spawnCount += 1; return fake; },
    runCli: () => ({ status: 'ok', credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    now: () => 1000,
    randomId: () => 'session-1'
  });

  const first = manager.startLogin();
  const second = manager.startLogin();
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(spawnCount, 1);

  fake.stdout.write('PROMPT:{"type":"auth_device_code","qrCodePath":"x.png","authorizeH5Url":"https://auth","userCode":"ABCD","expiresInSeconds":600}\n');
  await tick();
  const waiting = manager.getSession('session-1');
  assert.equal(waiting.status, 'waiting_scan');
  assert.match(waiting.qrImage, /^data:image\/png;base64,/);
  assert.equal(waiting.authorizeUrl, 'https://auth');
  assert.equal(waiting.userCode, 'ABCD');
  assert.equal(waiting.expiresAt, 601000);
  assert.equal(JSON.stringify(waiting).includes('x.png'), false);

  fake.stdout.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openId":"ob1234567890","accessToken":"hidden","scope":"base_info,skill_publish"}}\n');
  fake.emit('close', 0);
  await tick();
  const done = manager.getSession('session-1');
  assert.equal(done.status, 'done');
  assert.equal(done.auth.loggedIn, true);
  assert.equal(JSON.stringify(done).includes('hidden'), false);
  assert.equal(JSON.stringify(done).includes('ob1234567890'), false);
});

test('cancels locally before invoking the exact remote cancel command', async () => {
  const fake = createFakeChild();
  const calls = [];
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: args => {
      calls.push(args);
      assert.equal(manager.getSession('session-1').status, 'cancelled');
      assert.equal(fake.killed, true);
      throw new Error('TEST_CANCEL_SECRET');
    },
    readFile: () => Buffer.from('png'),
    now: () => 1000,
    randomId: () => 'session-1'
  });

  manager.startLogin();
  const cancelled = await manager.cancelLogin('session-1');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(calls, [['login', '--cancel']]);
  assert.equal(fake.killed, true);
  assert.equal(JSON.stringify(cancelled).includes('TEST_CANCEL_SECRET'), false);
  assert.equal(manager.getSession('session-1').status, 'cancelled');
  assert.equal(manager.getSession('missing'), null);
});

test('keeps the original ten-minute deadline when a prompt arrives after nine minutes', async () => {
  const fake = createFakeChild();
  const timers = [];
  let currentTime = 1000;
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    now: () => currentTime,
    randomId: () => 'session-1',
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; }
  });

  manager.startLogin();
  assert.equal(timers[0].delay, 600000);
  currentTime += 9 * 60 * 1000;
  fake.stdout.write('PROMPT:{"qrCodePath":"x.png","expiresInSeconds":600}\n');
  await tick();

  assert.equal(manager.getSession('session-1').expiresAt, 601000);
  assert.equal(timers.at(-1).delay, 60000);
});

test('rejects prompts and results that arrive after the absolute deadline', async () => {
  for (const lateLine of [
    'PROMPT:{"qrCodePath":"late.png","expiresInSeconds":600}\n',
    'RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openIdMasked":"ob12…7890"}}\n'
  ]) {
    const fake = createFakeChild();
    let currentTime = 1000;
    const manager = createRedappAuthManager({
      spawnCli: () => fake,
      runCli: () => ({ credentials: { loggedIn: false } }),
      readFile: () => Buffer.from('png'),
      now: () => currentTime,
      randomId: () => 'session-1',
      setTimer: (callback, delay) => ({ callback, delay }),
      clearTimer() {}
    });

    manager.startLogin();
    currentTime = 601001;
    fake.stdout.write(lateLine);
    await tick();

    const expired = manager.getSession('session-1');
    assert.equal(expired.status, 'expired');
    assert.equal(expired.auth, null);
    assert.equal(expired.qrImage, null);
    assert.equal(fake.killed, true);
  }
});

test('expires a login using injected timers and caps prompt expiry at ten minutes', async () => {
  const fake = createFakeChild();
  const timers = [];
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    now: () => 2000,
    randomId: () => 'session-1',
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; }
  });

  manager.startLogin();
  fake.stdout.write('PROMPT:{"qrCodePath":"x.png","expiresInSeconds":9999}\n');
  await tick();
  assert.equal(manager.getSession('session-1').expiresAt, 602000);
  assert.equal(timers[0].delay, 600000);

  const expiryTimer = timers.find(timer => timer.delay === 600000 && !timer.cleared);
  expiryTimer.callback();
  assert.equal(fake.killed, true);
  assert.equal(manager.getSession('session-1').status, 'expired');
  assert.equal(timers.at(-1).delay, 300000);
});

test('marks premature process close and spawn errors as failed without leaking output', () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'closed-session'
  });
  manager.startLogin();
  fake.stderr.write('accessToken=TEST_PROCESS_SECRET');
  fake.emit('close', 1);
  const failed = manager.getSession('closed-session');
  assert.equal(failed.status, 'failed');
  assert.equal(JSON.stringify(failed).includes('TEST_PROCESS_SECRET'), false);

  const throwing = createRedappAuthManager({
    spawnCli: () => { throw new Error('TEST_SPAWN_SECRET'); },
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'spawn-session'
  });
  assert.equal(throwing.startLogin().status, 'failed');
  assert.equal(JSON.stringify(throwing.getSession('spawn-session')).includes('TEST_SPAWN_SECRET'), false);
});

test('clears temporary session state when spawn throws or returns an unusable child', () => {
  for (const [id, spawnCli] of [
    ['throw-session', () => { throw new Error('TEST_SPAWN_SECRET'); }],
    ['null-session', () => null],
    ['malformed-session', () => ({})]
  ]) {
    const manager = createRedappAuthManager({
      spawnCli,
      runCli: () => ({ credentials: { loggedIn: false } }),
      readFile: () => Buffer.from('png'),
      randomId: () => id
    });

    assert.equal(manager.startLogin().status, 'failed');
    const retained = manager.getSession(id);
    assert.equal(retained.status, 'failed');
    assert.equal(JSON.stringify(retained).includes('TEST_SPAWN_SECRET'), false);
  }
});

test('removes terminal sessions after five minutes', async () => {
  const fake = createFakeChild();
  const timers = [];
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1',
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer() {}
  });

  manager.startLogin();
  await manager.cancelLogin('session-1');
  assert.equal(timers.at(-1).delay, 300000);
  timers.at(-1).callback();
  assert.equal(manager.getSession('session-1'), null);
});

test('dispose kills active children, clears timers, and removes every session', async () => {
  const activeChild = createFakeChild();
  const terminalChild = createFakeChild();
  const timers = [];
  let nextId = 0;
  let nextChild = 0;
  const manager = createRedappAuthManager({
    spawnCli: () => [terminalChild, activeChild][nextChild++],
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => `session-${++nextId}`,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; }
  });

  manager.startLogin();
  terminalChild.stdout.write('PROMPT:{"qrCodePath":"x.png","expiresInSeconds":10}\n');
  await tick();
  await manager.cancelLogin('session-1');
  manager.startLogin();
  manager.dispose();

  assert.equal(activeChild.killed, true);
  assert.equal(manager.getSession('session-1'), null);
  assert.equal(manager.getSession('session-2'), null);
  assert.equal(timers.every(timer => timer.cleared), true);
});

test('projects credential status and logout results through safe DTOs', async () => {
  const calls = [];
  const manager = createRedappAuthManager({
    spawnCli: () => createFakeChild(),
    runCli: args => {
      calls.push(args);
      return {
        status: 'ok',
        credentials: {
          available: true,
          loggedIn: true,
          openIdMasked: 'ob12…7890',
          scope: ['base_info'],
          expireTimeMs: null,
          refreshExpireTimeMs: null,
          needsReauth: false,
          accessToken: 'TEST_AUTH_SECRET'
        }
      };
    },
    readFile: () => Buffer.from('png')
  });

  for (const result of [await manager.getStatus(), await manager.logout()]) {
    assert.equal(result.loggedIn, true);
    assert.equal(result.openIdMasked, 'ob12…7890');
    assert.equal(JSON.stringify(result).includes('TEST_AUTH_SECRET'), false);
  }
  assert.deepEqual(calls, [['whoami'], ['logout']]);
});

test('preserves already-sanitized auth DTOs and drops raw or unknown fields', async () => {
  const safeCredentials = {
    available: true,
    loggedIn: true,
    openIdMasked: 'ob12…7890',
    scope: ['base_info', 42],
    expireTimeMs: 4102444800000,
    refreshExpireTimeMs: 4102448400000,
    needsReauth: false,
    openId: 'ob1234567890',
    accessToken: 'TEST_AUTH_SECRET',
    unknown: 'TEST_UNKNOWN_SECRET'
  };
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ status: 'ok', credentials: safeCredentials }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  const expected = {
    available: true,
    loggedIn: true,
    openIdMasked: 'ob12…7890',
    scope: ['base_info'],
    expireTimeMs: 4102444800000,
    refreshExpireTimeMs: 4102448400000,
    needsReauth: false
  };
  assert.deepEqual(await manager.getStatus(), expected);
  assert.deepEqual(await manager.logout(), expected);

  manager.startLogin();
  fake.stdout.write(`RESULT_JSON:${JSON.stringify({ status: 'ok', credentials: safeCredentials })}\n`);
  await tick();
  assert.deepEqual(manager.getSession('session-1').auth, expected);
  const exposed = JSON.stringify(manager.getSession('session-1'));
  assert.equal(exposed.includes('ob1234567890'), false);
  assert.equal(exposed.includes('TEST_AUTH_SECRET'), false);
  assert.equal(exposed.includes('TEST_UNKNOWN_SECRET'), false);
});

test('ignores late prompts and replaces prompt expiry timers safely', async () => {
  const fake = createFakeChild();
  const timers = [];
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    now: () => 1000,
    randomId: () => 'session-1',
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => { timer.cleared = true; }
  });

  manager.startLogin();
  fake.stdout.write('PROMPT:{"qrCodePath":"first.png","expiresInSeconds":10}\n');
  await tick();
  fake.stdout.write('PROMPT:{"qrCodePath":"second.png","expiresInSeconds":20}\n');
  await tick();
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].cleared, true);
  assert.equal(timers[2].delay, 20000);

  await manager.cancelLogin('session-1');
  fake.stdout.write('PROMPT:{"qrCodePath":"late.png","expiresInSeconds":30}\n');
  await tick();
  assert.equal(manager.getSession('session-1').status, 'cancelled');
});

test('expires a session that never emits a prompt', () => {
  const fake = createFakeChild();
  const timers = [];
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1',
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.at(-1);
    },
    clearTimer() {}
  });

  manager.startLogin();
  assert.equal(timers[0].delay, 600000);
  timers[0].callback();
  assert.equal(fake.killed, true);
  assert.equal(manager.getSession('session-1').status, 'expired');
});

test('drains stderr and does not schedule cleanup after disposal close', () => {
  const fake = createFakeChild();
  const timers = [];
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1',
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.at(-1);
    },
    clearTimer() {}
  });

  manager.startLogin();
  assert.ok(fake.stderr.listenerCount('data') > 0);
  manager.dispose();
  const timerCount = timers.length;
  fake.emit('close', 0);
  assert.equal(timers.length, timerCount);
  assert.equal(manager.getSession('session-1'), null);
});

test('cleans up child streams and listeners on done and process error', async () => {
  for (const terminalEvent of ['done', 'error']) {
    const fake = createFakeChild();
    const manager = createRedappAuthManager({
      spawnCli: () => fake,
      runCli: () => ({ credentials: { loggedIn: false } }),
      readFile: () => Buffer.from('png'),
      randomId: () => `${terminalEvent}-session`
    });

    manager.startLogin();
    if (terminalEvent === 'done') {
      fake.stdout.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true}}\n');
      await tick();
    } else {
      fake.emit('error', new Error('TEST_CHILD_SECRET'));
    }

    const terminal = manager.getSession(`${terminalEvent}-session`);
    assert.equal(terminal.status, terminalEvent === 'done' ? 'done' : 'failed');
    assert.equal(fake.killed, true);
    assert.equal(fake.stdout.listenerCount('data'), 0);
    assert.equal(fake.stderr.listenerCount('data'), 0);
    assert.equal(fake.listenerCount('error'), 0);
    assert.equal(fake.listenerCount('close'), 0);

    fake.stdout.write('PROMPT:{"qrCodePath":"late.png"}\n');
    fake.emit('close', 1);
    await tick();
    assert.equal(manager.getSession(`${terminalEvent}-session`).status, terminal.status);
    assert.equal(fake.killCount, 1);
  }
});

test('logout invalidates sessions first and rejects with a fixed safe error on CLI failure', async () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: async args => {
      assert.deepEqual(args, ['logout']);
      assert.equal(manager.getSession('session-1'), null);
      assert.equal(fake.killed, true);
      throw new Error('TEST_LOGOUT_SECRET');
    },
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });
  manager.startLogin();

  await assert.rejects(manager.logout(), error => {
    assert.equal(error.message, 'redapp 退出登录失败');
    assert.equal(error.message.includes('TEST_LOGOUT_SECRET'), false);
    return true;
  });
  assert.equal(manager.getSession('session-1'), null);
});

test('logout router passes failure to middleware without writing a success DTO', async () => {
  const router = createRedappAuthRouter({
    authManager: { logout: async () => { throw new Error('redapp 退出登录失败'); } },
    verify: (req, res, next) => next()
  });
  const handler = router.stack.find(layer => layer.route?.path === '/logout').route.stack[0].handle;
  const response = createResponse();
  let routedError;
  await handler({}, response, error => { routedError = error; });
  await tick();
  assert.equal(routedError?.message, 'redapp 退出登录失败');
  assert.equal(response.body, undefined);
});

test('logout atomically invalidates sessions and ignores all late child events', async () => {
  const fake = createFakeChild();
  const calls = [];
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: args => {
      calls.push(args);
      assert.equal(manager.getSession('session-1'), null);
      assert.equal(fake.killed, true);
      return { credentials: { loggedIn: false } };
    },
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.startLogin();
  assert.equal(manager.getSession('session-1').status, 'waiting_prompt');
  const result = await manager.logout();
  assert.deepEqual(calls, [['logout']]);
  assert.equal(result.loggedIn, false);
  assert.equal(manager.getSession('session-1'), null);

  fake.stdout.write('PROMPT:{"qrCodePath":"late.png","expiresInSeconds":10}\n');
  fake.stdout.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true}}\n');
  fake.emit('close', 0);
  await tick();
  assert.equal(manager.getSession('session-1'), null);
});

test('logout during the pending spawn window kills the late child without throwing', async () => {
  const late = createFakeChild();
  let resolveSpawn;
  const manager = createRedappAuthManager({
    spawnCli: () => new Promise(resolve => { resolveSpawn = resolve; }),
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });
  manager.startLogin();
  await manager.logout();
  resolveSpawn(late);
  await tick();
  assert.equal(late.killed, true);
  assert.doesNotThrow(() => {
    late.stdout.write('PROMPT:{"qrCodePath":"x.png"}\n');
    late.stdout.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true}}\n');
    late.emit('close', 0);
  });
  await tick();
  assert.equal(manager.getSession('session-1'), null);
});

test('release during the pending spawn window keeps late stream events inert', async () => {
  const late = createFakeChild();
  let resolveSpawn;
  const manager = createRedappAuthManager({
    spawnCli: () => new Promise(resolve => { resolveSpawn = resolve; }),
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });
  manager.startLogin();
  manager.dispose();
  resolveSpawn(late);
  await tick();
  assert.equal(late.killed, true);
  assert.equal(late.stdout.listenerCount('data'), 0);
  assert.equal(late.listenerCount('close'), 0);
});

test('termination racing a successful exit-0 child salvages the completed receipt', async () => {
  const child = createFakeChild();
  const timers = [];
  const run = createAsyncProcessRunner({
    spawnProcess: () => child,
    platform: 'win32',
    terminateTree: async () => false,
    setTimer(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}
  });
  const controller = new AbortController();
  const pending = run(['fake'], 1000, { signal: controller.signal });
  controller.abort();
  await tick();
  child.stdout.write('RESULT_JSON:{"status":"ok","data":{"fileId":"f","md5":"m"}}\n');
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.status, 0);
  assert.equal(result.error, null);
  assert.match(result.stdout, /RESULT_JSON/);
});

test('termination with an unsuccessful exit-0 close still reaches the supervisor bound', async () => {
  const child = createFakeChild();
  const timers = [];
  const run = createAsyncProcessRunner({
    spawnProcess: () => child,
    platform: 'win32',
    terminateTree: async () => false,
    setTimer(callback) { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}
  });
  const controller = new AbortController();
  const pending = run(['fake'], 1000, { signal: controller.signal });
  controller.abort();
  await tick();
  child.stdout.write('garbage without a receipt\n');
  child.emit('close', 0);
  await tick();
  assert.equal(await Promise.race([pending.then(() => 'settled'), tick().then(() => 'pending')]), 'pending');
  timers.at(-1).callback();
  const result = await pending;
  assert.equal(result.error?.message, 'process_termination_unconfirmed');
});

test('default randomId produces a valid session id without injection', () => {
  const manager = createRedappAuthManager({
    spawnCli: () => createFakeChild(),
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png')
  });
  const session = manager.startLogin();
  assert.match(session.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  manager.dispose();
});

test('projection recomputes needsReauth from expiry instead of trusting the stored flag', async () => {
  const past = Date.now() - 1000;
  const manager = createRedappAuthManager({
    spawnCli: () => createFakeChild(),
    runCli: () => ({
      status: 'ok',
      credentials: {
        available: true, loggedIn: true, openIdMasked: 'ob12…7890', scope: [],
        expireTimeMs: past, refreshExpireTimeMs: null, needsReauth: false
      }
    }),
    readFile: () => Buffer.from('png')
  });
  const status = await manager.getStatus();
  assert.equal(status.loggedIn, true);
  assert.equal(status.needsReauth, true);
});

test('retained session auth recomputes needsReauth as expiry passes within retention', async () => {
  let current = 1_000_000;
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1',
    now: () => current
  });
  manager.startLogin();
  fake.stdout.write(`RESULT_JSON:${JSON.stringify({ status: 'ok', credentials: { loggedIn: true, expireTimeMs: current + 1000 } })}\n`);
  await tick();
  assert.equal(manager.getSession('session-1').auth.needsReauth, false);
  current += 2000;
  const retained = manager.getSession('session-1');
  assert.equal(retained.status, 'done');
  assert.equal(retained.auth.loggedIn, true);
  assert.equal(retained.auth.needsReauth, true);
  manager.dispose();
});

test('accepts a chunk over 64 KiB when every complete line is short', () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.startLogin();
  fake.stdout.write(Buffer.from('noise\n'.repeat(11000)));
  assert.equal(manager.getSession('session-1').status, 'waiting_prompt');
  assert.equal(fake.killed, false);
});

test('fails safely when an individual complete stdout line exceeds 64 KiB', () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.startLogin();
  fake.stdout.write(Buffer.from(`TEST_OUTPUT_SECRET${'x'.repeat(64 * 1024)}\n`));
  const failed = manager.getSession('session-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '登录进程输出异常');
  assert.equal(fake.killed, true);
  assert.equal(JSON.stringify(failed).includes('TEST_OUTPUT_SECRET'), false);
});

test('fails generically and kills the child when an unterminated stdout line exceeds 64 KiB', () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.startLogin();
  fake.stdout.write(Buffer.from(`TEST_OUTPUT_SECRET${'x'.repeat(64 * 1024)}`));
  const failed = manager.getSession('session-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, '登录进程输出异常');
  assert.equal(fake.killed, true);
  assert.equal(JSON.stringify(failed).includes('TEST_OUTPUT_SECRET'), false);
});

test('keeps every work-creating method closed after disposal', async () => {
  let spawnCount = 0;
  let runCount = 0;
  const manager = createRedappAuthManager({
    spawnCli: () => { spawnCount += 1; return createFakeChild(); },
    runCli: () => { runCount += 1; return { credentials: { loggedIn: false } }; },
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.dispose();
  assert.throws(() => manager.startLogin(), { message: '授权管理器已关闭' });
  await assert.rejects(manager.getStatus(), { message: '授权管理器已关闭' });
  await assert.rejects(manager.cancelLogin('session-1'), { message: '授权管理器已关闭' });
  await assert.rejects(manager.logout(), { message: '授权管理器已关闭' });
  assert.equal(spawnCount, 0);
  assert.equal(runCount, 0);
  assert.equal(manager.getSession('session-1'), null);
});

test('rejects login starts permanently after disposal', () => {
  let spawnCount = 0;
  const manager = createRedappAuthManager({
    spawnCli: () => { spawnCount += 1; return createFakeChild(); },
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.dispose();
  assert.throws(() => manager.startLogin(), { message: '授权管理器已关闭' });
  assert.equal(spawnCount, 0);
  assert.equal(manager.getSession('session-1'), null);
});

test('decodes split UTF-8 characters in prompt and result lines', async () => {
  const fake = createFakeChild();
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.startLogin();
  const prompt = Buffer.from('PROMPT:{"qrCodePath":"x.png","userCode":"授权码"}\n');
  const promptSplit = prompt.indexOf(Buffer.from('授')) + 1;
  fake.stdout.write(prompt.subarray(0, promptSplit));
  fake.stdout.write(prompt.subarray(promptSplit));
  await tick();
  assert.equal(manager.getSession('session-1').status, 'waiting_scan');
  assert.equal(manager.getSession('session-1').userCode, '授权码');

  const result = Buffer.from('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"scope":"基础信息"}}\n');
  const resultSplit = result.indexOf(Buffer.from('基')) + 1;
  fake.stdout.write(result.subarray(0, resultSplit));
  fake.stdout.write(result.subarray(resultSplit));
  await tick();
  const done = manager.getSession('session-1');
  assert.equal(done.status, 'done');
  assert.deepEqual(done.auth.scope, ['基础信息']);
});

test('parses PROMPT and RESULT_JSON lines', () => {
  const parsed = parseTaggedOutput([
    'PROMPT:{"type":"auth_device_code","userCode":"ABCD-EFGH"}',
    'RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openId":"ob1234567890","accessToken":"secret","refreshToken":"secret2","credentialPath":"C:/Users/example/.redapp/credentials.json","scope":"base_info,skill_publish","expireTimeMs":"1794"}}'
  ].join('\n'));
  assert.equal(parsed.prompts[0].userCode, 'ABCD-EFGH');
  assert.equal(parsed.results[0].status, 'ok');
  assert.deepEqual(parsed.results[0].credentials, {
    available: true,
    loggedIn: true,
    openIdMasked: 'ob12…7890',
    scope: ['base_info', 'skill_publish'],
    expireTimeMs: 1794,
    refreshExpireTimeMs: null,
    needsReauth: true
  });
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('ob1234567890'), false);
  assert.equal(serialized.toLowerCase().includes('credentialpath'), false);
  assert.equal(serialized.toLowerCase().includes('credentialsfile'), false);
});

test('sanitizes credentials and never serializes tokens', () => {
  const dto = sanitizeCredentials({
    loggedIn: true,
    openId: 'ob1234567890',
    accessToken: 'secret',
    refreshToken: 'secret2',
    scope: 'base_info,skill_publish',
    expireTimeMs: '1794'
  });
  assert.equal(dto.openIdMasked, 'ob12…7890');
  assert.deepEqual(dto.scope, ['base_info', 'skill_publish']);
  assert.equal(JSON.stringify(dto).includes('secret'), false);
  assert.equal('accessToken' in dto, false);
  assert.equal('refreshToken' in dto, false);
});

test('preserves numeric zero expiry and marks it for reauthorization', () => {
  const dto = sanitizeCredentials({
    loggedIn: true,
    expireTimeMs: 0,
    refreshExpireTimeMs: '0'
  });
  assert.equal(dto.expireTimeMs, 0);
  assert.equal(dto.refreshExpireTimeMs, 0);
  assert.equal(dto.needsReauth, true);
});

test('async command runner gates before command and stays pending without blocking', async () => {
  const calls = [];
  let releaseGate;
  const pendingGate = new Promise(resolve => { releaseGate = resolve; });
  const ensureCli = createRedappCliEnsurerAsync({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate: async () => {
      calls.push('gate');
      await pendingGate;
      return { status: 0, stdout: 'CLI_VERSION_JSON:{"status":"current"}', stderr: '', error: null };
    }
  });
  const run = createRedappCommandRunnerAsync({
    ensureCli,
    execute: async args => {
      calls.push(args);
      return { status: 0, stdout: 'RESULT_JSON:{"status":"ok","credentials":{"loggedIn":false}}', stderr: '', error: null };
    }
  });

  let settled = false;
  const resultPromise = run(['whoami']).then(value => { settled = true; return value; });
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(calls, ['gate']);
  releaseGate();
  assert.equal((await resultPromise).credentials.loggedIn, false);
  assert.deepEqual(calls, ['gate', ['whoami']]);
});

test('async command runner rejects bounded execution failures safely', async () => {
  const run = createRedappCommandRunnerAsync({
    ensureCli: async () => ({ status: 'current' }),
    execute: async () => ({ status: null, stdout: 'x'.repeat(1024), stderr: 'TEST_ASYNC_SECRET', error: new Error('timeout') })
  });
  await assert.rejects(run(['whoami']), error => {
    assert.equal(error.message, 'redapp 命令执行失败');
    assert.equal(error.message.includes('TEST_ASYNC_SECRET'), false);
    return true;
  });
});

test('QR reader uses one handle, enforces strict cap, and validates PNG signature', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body')]);
  const calls = [];
  const reader = createRedappQrReader({
    open: () => {
      calls.push('open');
      return {
        stat: () => ({ isFile: () => true, size: png.length }),
        read: buffer => { png.copy(buffer); return png.length; },
        close: () => calls.push('close')
      };
    }
  });
  assert.deepEqual(reader('ignored-path'), png);
  assert.deepEqual(calls, ['open', 'close']);

  const tooLarge = createRedappQrReader({
    open: () => ({
      stat: () => ({ isFile: () => true, size: 2 * 1024 * 1024 + 1 }),
      read: () => { throw new Error('must not read'); },
      close() {}
    })
  });
  assert.throws(() => tooLarge('secret-path'), { message: '二维码文件无效' });

  const wrongSignature = createRedappQrReader({
    open: () => ({
      stat: () => ({ isFile: () => true, size: 8 }),
      read: buffer => { Buffer.from('not png!').copy(buffer); return 8; },
      close() {}
    })
  });
  assert.throws(() => wrongSignature('secret-path'), { message: '二维码文件无效' });
});

test('blocks business commands when the version gate fails', () => {
  let commandExecutions = 0;
  const run = createRedappCommandRunner({
    ensureCli() {
      throw new Error('gate failed');
    },
    execute() {
      commandExecutions += 1;
      return { status: 0, stdout: '', stderr: '', error: null };
    }
  });

  assert.throws(() => run(['upload']), /gate failed/);
  assert.equal(commandExecutions, 0);
});

test('public command runner sanitizes successful command credentials', () => {
  const accessToken = 'runner-access-token';
  const refreshToken = 'runner-refresh-token';
  const rawResult = {
    status: 'ok',
    credentials: {
      loggedIn: true,
      openId: 'ob1234567890',
      accessToken,
      refreshToken,
      credentialPath: 'C:/private/credentials.json',
      scope: 'base_info'
    }
  };
  const run = createRedappCommandRunner({
    ensureCli() {},
    execute() {
      return {
        status: 0,
        stdout: `RESULT_JSON:${JSON.stringify(rawResult)}`,
        stderr: '',
        error: null
      };
    }
  });

  const result = run(['whoami']);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.credentials, {
    available: true,
    loggedIn: true,
    openIdMasked: 'ob12…7890',
    scope: ['base_info'],
    expireTimeMs: null,
    refreshExpireTimeMs: null,
    needsReauth: false
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(accessToken), false);
  assert.equal(serialized.includes(refreshToken), false);
  assert.equal(serialized.includes('ob1234567890'), false);
  assert.equal(serialized.toLowerCase().includes('credentialpath'), false);
});

test('result schemas drop alternate tokens, nested unknowns, and decorated credential structures', () => {
  const parsed = parseTaggedOutput(`RESULT_JSON:${JSON.stringify({
    status: 'ok',
    command: 'upload',
    token: 'generic-secret',
    access_token: 'access-secret',
    'id-token': 'id-secret',
    credentials: {
      loggedIn: true,
      openId: 'ob1234567890',
      openIdMasked: 'ob1234567890',
      userOpenId: 'ob1234567890',
      credential: { path: 'C:/private/credentials.json' },
      credentialData: { location: '/private/credentials.json' },
      nested: { generic: 'unknown-secret' }
    },
    credential: { file: 'C:/private/credentials.json' },
    plan: { planHash: 'plan-1', credentialPath: 'C:/private/credentials.json', extra: 'drop-me' },
    data: {
      fileId: 'file-1',
      md5: 'abc123',
      previewUrl: 'https://preview.example',
      qrCodePath: 'preview.png',
      qrError: 'safe operational error',
      access_token: 'nested-access-secret',
      nested: { generic: 'unknown-secret' }
    },
    unknownTopLevel: 'drop-me'
  })}`);

  assert.deepEqual(parsed.results[0], {
    status: 'ok',
    command: 'upload',
    credentials: {
      available: true,
      loggedIn: true,
      openIdMasked: 'ob12…7890',
      scope: [],
      expireTimeMs: null,
      refreshExpireTimeMs: null,
      needsReauth: false
    },
    plan: { planHash: 'plan-1' },
    data: {
      fileId: 'file-1',
      md5: 'abc123',
      qrCodePath: 'preview.png',
      previewUrl: 'https://preview.example',
      qrError: 'safe operational error'
    }
  });
  const serialized = JSON.stringify(parsed);
  for (const secret of [
    'generic-secret', 'access-secret', 'id-secret', 'credentials.json',
    'unknown-secret', 'nested-access-secret', 'drop-me'
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('credentials use exact allowlisted source keys and drop decorated openId keys', () => {
  const parsed = parseTaggedOutput(`RESULT_JSON:${JSON.stringify({
    credentials: {
      loggedIn: true,
      open_id: 'abcd',
      openIdValue: 'abcdefgh',
      userOpenId: 'ob1234567890',
      credential: { path: 'C:/private/credentials.json' }
    }
  })}`);
  assert.equal(parsed.results[0].credentials.openIdMasked, null);
  assert.equal(JSON.stringify(parsed).includes('abcd'), false);
  assert.equal(JSON.stringify(parsed).includes('ob1234567890'), false);
  assert.equal(JSON.stringify(parsed).includes('credentials.json'), false);
});

test('openId masking never reveals the complete source at any length', () => {
  for (const source of ['a', 'ab', 'abcd', 'abcdefgh', 'ob1234567890']) {
    const dto = sanitizeCredentials({ openId: source });
    assert.notEqual(dto.openIdMasked, source);
    const revealed = [...source].filter(character => dto.openIdMasked.includes(character)).length;
    assert.ok(revealed < source.length, `${source} must reveal fewer source characters`);
  }
});

test('prompt schema preserves auth fields and drops unknown or token-like fields', () => {
  const prompt = parseTaggedOutput(`PROMPT:${JSON.stringify({
    type: 'auth_device_code',
    authorizeCommonUrl: 'https://common.example',
    authorizeH5Url: 'https://h5.example',
    authorizeUrl: 'https://authorize.example',
    userCode: 'ABCD-EFGH',
    expiresInSeconds: 300,
    message: 'Scan to authorize',
    qrCodePath: 'auth.png',
    access_token: 'access-secret',
    token: 'token-secret',
    nested: { generic: 'unknown-secret' },
    unknown: 'drop-me'
  })}`).prompts[0];

  assert.deepEqual(prompt, {
    type: 'auth_device_code',
    authorizeCommonUrl: 'https://common.example',
    authorizeH5Url: 'https://h5.example',
    authorizeUrl: 'https://authorize.example',
    userCode: 'ABCD-EFGH',
    expiresInSeconds: 300,
    message: 'Scan to authorize',
    qrCodePath: 'auth.png'
  });
});

test('version gate errors never expose malformed output', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate() {
      return { status: 0, stdout: 'TEST_GATE_SECRET', stderr: 'TEST_GATE_SECRET', error: null };
    }
  });

  assert.throws(() => ensureCli(), error => {
    assert.equal(error.message, 'CLI 版本门禁输出无法解析');
    assert.equal(error.message.includes('TEST_GATE_SECRET'), false);
    return true;
  });
});

test('version gate errors never expose untrusted verdict messages', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate() {
      return {
        status: 0,
        stdout: 'CLI_VERSION_JSON:{"status":"error","message":"TEST_GATE_SECRET"}',
        stderr: '',
        error: null
      };
    }
  });

  assert.throws(() => ensureCli(), error => {
    assert.equal(error.message, 'CLI 版本门禁未通过');
    assert.equal(error.message.includes('TEST_GATE_SECRET'), false);
    return true;
  });
});

test('version gate accepts current, installed, and updated statuses', () => {
  for (const status of ['current', 'installed', 'updated']) {
    const ensureCli = createRedappCliEnsurer({
      gateExists: () => true,
      cliExists: () => true,
      prepareCache() {},
      executeGate: () => ({
        status: 0,
        stdout: `CLI_VERSION_JSON:${JSON.stringify({ status })}`,
        stderr: '',
        error: null
      })
    });
    assert.equal(ensureCli().status, status);
  }
});

test('version gate rejects allowed verdict after nonzero exit', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate: () => ({
      status: 1,
      stdout: 'CLI_VERSION_JSON:{"status":"current"}',
      stderr: 'TEST_GATE_SECRET',
      error: null
    })
  });
  assert.throws(() => ensureCli(), { message: 'CLI 版本门禁执行失败' });
});

test('version gate rejects allowed verdict after execution error', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate: () => ({
      status: 0,
      stdout: 'CLI_VERSION_JSON:{"status":"current"}',
      stderr: '',
      error: new Error('TEST_GATE_SECRET')
    })
  });
  assert.throws(() => ensureCli(), { message: 'CLI 版本门禁执行失败' });
});

test('business runner rejects successful result after nonzero exit', () => {
  const run = createRedappCommandRunner({
    ensureCli() {},
    execute: () => ({
      status: 1,
      stdout: 'RESULT_JSON:{"status":"ok","data":{"fileId":"file-1"}}',
      stderr: 'TEST_BUSINESS_SECRET',
      error: null
    })
  });
  assert.throws(() => run(['upload']), { message: 'redapp 命令执行失败' });
});

test('business runner rejects successful result after execution error', () => {
  const run = createRedappCommandRunner({
    ensureCli() {},
    execute: () => ({
      status: 0,
      stdout: 'RESULT_JSON:{"status":"ok","data":{"fileId":"file-1"}}',
      stderr: '',
      error: new Error('TEST_BUSINESS_SECRET')
    })
  });
  assert.throws(() => run(['upload']), { message: 'redapp 命令执行失败' });
});

test('process-scoped npm PATH uses the platform executable directory', () => {
  assert.equal(createRedappNpmEnv('win32').PATH.split(path.delimiter)[0].endsWith(path.join('redapp-npm', 'prefix')), true);
  assert.equal(createRedappNpmEnv('linux').PATH.split(path.delimiter)[0].endsWith(path.join('redapp-npm', 'prefix', 'bin')), true);
});

test('async upload invokes side-effect callback only after a valid dry-run plan', async () => {
  const events = [];
  const operations = createRedappOperationsAsync({
    runCommand: async (args, options) => {
      if (!args.includes('--dry-run')) options.onBeforeDispatch?.();
      events.push(args.includes('--dry-run') ? 'dry-run' : 'confirm');
      return args.includes('--dry-run') ? { plan: { planHash: 'plan-1' } } : { data: { fileId: 'file', md5: 'md5' } };
    },
    writeFile() {}, fileExists: () => false
  });
  await operations.uploadPackageAsync('package.zip', { onBeforeConfirm: () => events.push('marker') });
  assert.deepEqual(events, ['dry-run', 'marker', 'confirm']);

  let marked = false;
  const failing = createRedappOperationsAsync({
    runCommand: async () => ({ plan: {} }), writeFile() {}, fileExists: () => false
  });
  await assert.rejects(() => failing.uploadPackageAsync('package.zip', { onBeforeConfirm: () => { marked = true; } }), /planHash/u);
  assert.equal(marked, false);
});

test('upload and preview preserve existing command flow and return shapes', () => {
  const calls = [];
  const runCommand = (args, options) => {
    calls.push({ args, options });
    if (args.includes('--dry-run')) return { plan: { planHash: `plan-${calls.length}` } };
    if (args[0] === 'upload') return { data: { fileId: 'file-1', md5: 'abc123' } };
    return {
      data: {
        qrCodePath: 'preview.png',
        previewUrl: 'https://preview.example',
        fileId: 'file-1',
        token: 'preview-secret',
        nested: { generic: 'unknown-secret' }
      }
    };
  };
  const written = [];
  const operations = createRedappOperations({
    runCommand,
    writeFile: (...args) => written.push(args),
    fileExists: () => false
  });

  assert.deepEqual(operations.uploadPackage('package.zip'), { fileId: 'file-1', md5: 'abc123' });
  assert.deepEqual(operations.createPreview({
    fileId: 'file-1', md5: 'abc123', appName: 'App', qrOut: 'preview.png'
  }), {
    qrCodePath: 'preview.png',
    previewUrl: 'https://preview.example',
    raw: { qrCodePath: 'preview.png', previewUrl: 'https://preview.example', fileId: 'file-1' }
  });
  assert.deepEqual(calls.map(call => call.args), [
    ['upload', '--file', 'package.zip', '--type', 'pkg', '--dry-run'],
    ['upload', '--file', 'package.zip', '--type', 'pkg', '--confirm', 'plan-1'],
    ['preview', '--source', 'thirdAgent', '--file', 'preview.json', '--dry-run'],
    ['preview', '--source', 'thirdAgent', '--file', 'preview.json', '--qr-out', 'preview.png', '--confirm', 'plan-3']
  ]);
  assert.deepEqual(calls.map(call => call.options.timeoutMs), [180000, 180000, 120000, 120000]);
  assert.equal(written.length, 1);
});

test('public command runner does not copy malformed raw output into errors', () => {
  const run = createRedappCommandRunner({
    ensureCli() {},
    execute() {
      return {
        status: 1,
        stdout: 'RESULT_JSON:{"accessToken":"malformed-secret"',
        stderr: 'refreshToken=stderr-secret openId=ob-full-secret',
        error: null
      };
    }
  });

  assert.throws(
    () => run(['whoami']),
    error => {
      assert.equal(error.message, 'redapp 命令执行失败');
      assert.equal(error.message.includes('malformed-secret'), false);
      assert.equal(error.message.includes('stderr-secret'), false);
      assert.equal(error.message.includes('ob-full-secret'), false);
      return true;
    }
  );
});

test('allowed prompt and result fields project only expected primitive types', () => {
  const injected = { accessToken: 'TEST_SECRET', openId: 'complete-open-id' };
  const parsed = parseTaggedOutput([
    `PROMPT:${JSON.stringify({
      type: 't'.repeat(300),
      authorizeCommonUrl: 'u'.repeat(5000),
      authorizeH5Url: ['TEST_SECRET'],
      authorizeUrl: 'https://authorize.example',
      userCode: 'c'.repeat(300),
      expiresInSeconds: 0,
      message: injected,
      qrCodePath: 'p'.repeat(5000)
    })}`,
    `RESULT_JSON:${JSON.stringify({
      status: 's'.repeat(100),
      command: injected,
      plan: { planHash: injected },
      data: {
        fileId: injected,
        md5: 'm'.repeat(200),
        qrCodePath: 'preview.png',
        previewUrl: ['TEST_SECRET'],
        qrError: injected
      }
    })}`
  ].join('\n'));

  assert.deepEqual(parsed.prompts[0], {
    type: 't'.repeat(256),
    authorizeCommonUrl: 'u'.repeat(4096),
    authorizeUrl: 'https://authorize.example',
    userCode: 'c'.repeat(256),
    expiresInSeconds: 0,
    qrCodePath: 'p'.repeat(4096)
  });
  assert.deepEqual(parsed.results[0], {
    status: 's'.repeat(64),
    data: { md5: 'm'.repeat(128), qrCodePath: 'preview.png' }
  });
  assert.equal(JSON.stringify(parsed).includes('TEST_SECRET'), false);
});

test('credentials accept only typed scope and finite numeric expiry values', () => {
  assert.deepEqual(sanitizeCredentials({
    loggedIn: true,
    scope: ['base_info', { token: 'TEST_SECRET' }, 42, 'skill_publish'],
    expireTimeMs: '0',
    refreshExpireTimeMs: { token: 'TEST_SECRET' }
  }), {
    available: true,
    loggedIn: true,
    openIdMasked: null,
    scope: ['base_info', 'skill_publish'],
    expireTimeMs: 0,
    refreshExpireTimeMs: null,
    needsReauth: true
  });
  assert.deepEqual(sanitizeCredentials({ scope: { token: 'TEST_SECRET' }, expireTimeMs: 'Infinity' }).scope, []);
});

test('credentials require exact boolean true for authenticated state', () => {
  for (const loggedIn of ['false', 1, {}, [], undefined]) {
    const credentials = loggedIn === undefined ? {} : { loggedIn };
    const dto = sanitizeCredentials(credentials);
    assert.equal(dto.loggedIn, false);
    assert.equal(dto.needsReauth, true);
  }

  assert.equal(sanitizeCredentials({ loggedIn: true }).loggedIn, true);
  assert.equal(sanitizeCredentials({ loggedIn: false }).loggedIn, false);
});

test('version gate returns only its accepted status', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate: () => ({
      status: 0,
      stdout: 'CLI_VERSION_JSON:{"status":"current","token":"TEST_SECRET","openId":"complete-open-id","path":"C:/private"}',
      stderr: '',
      error: null
    })
  });

  assert.deepEqual(ensureCli(), { status: 'current' });
});

test('operation validation errors never reflect CLI-controlled results', () => {
  const planOperations = createRedappOperations({
    runCommand: () => ({ command: 'TEST_SECRET' }),
    writeFile() {},
    fileExists: () => false
  });
  assert.throws(() => planOperations.uploadPackage('package.zip'), error => {
    assert.equal(error.message, 'dry-run 未返回 planHash');
    assert.equal(error.message.includes('TEST_SECRET'), false);
    return true;
  });

  let calls = 0;
  const uploadOperations = createRedappOperations({
    runCommand: () => {
      calls += 1;
      if (calls === 1) return { plan: { planHash: 'plan-1' } };
      return { data: { fileId: 'file-1', qrError: 'TEST_SECRET' } };
    },
    writeFile() {},
    fileExists: () => false
  });
  assert.throws(() => uploadOperations.uploadPackage('package.zip'), error => {
    assert.equal(error.message, '上传回执缺少 fileId/md5');
    assert.equal(error.message.includes('TEST_SECRET'), false);
    return true;
  });
});
