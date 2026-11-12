import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

process.env.TEST_DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test?sslmode=disable';
const publish = await import('../src/routes/publish.js');
const cli = await import('../src/lib/redappCli.js');
const { createMiniToolPublishJobRegistry, createMiniToolPublishHandler, createArtifactAuditor, canonicalizeMiniToolPublishRequest } = publish;

const tick = () => new Promise(resolve => setImmediate(resolve));
function response() { return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
async function invoke(handler, body, userId = 'u1') { const res = response(); await handler({ body, user: { userId }, params: { attemptId: body.attemptId } }, res, error => { throw error; }); return res; }
const auth = { getStatus: async () => ({ available: true, loggedIn: true, needsReauth: false }) };

function operationDeps(overrides = {}) {
  return {
    authManager: auth,
    buildMiniToolZip: async () => ({ dir: '/safe/dir', zipPath: '/safe/a.zip', size: 1, imageCount: 1 }),
    runAudit: async () => ({ status: 'passed' }),
    uploadPackage: async () => ({ fileId: 'f', md5: 'm' }),
    createPreview: async () => ({ previewUrl: 'https://safe.test/p', qrCodePath: null }),
    readQrImage: () => null,
    ...overrides
  };
}

const valid = { attemptId: 'attempt-1234', title: ' title ', content: ' body ', tags: [' #tag '], images: ['/uploads/a.png'] };

test('canonical validation rejects wrong types and bounds before auth', async () => {
  let authCalls = 0;
  const handler = createMiniToolPublishHandler(operationDeps({ authManager: { getStatus: async () => { authCalls++; return { available: true, loggedIn: true }; } } }));
  const bad = [
    { ...valid, attemptId: '../bad' }, { ...valid, title: {} }, { ...valid, title: 'x'.repeat(101) },
    { ...valid, content: 'x'.repeat(1001) }, { ...valid, tags: 'tag' }, { ...valid, tags: Array(21).fill('x') },
    { ...valid, tags: [{}] }, { ...valid, images: 'x' }, { ...valid, images: [] },
    { ...valid, images: ['file:///secret'] }, { ...valid, images: ['x'.repeat(8193)] }
  ];
  for (const body of bad) assert.equal((await invoke(handler, body)).statusCode, 400);
  assert.equal(authCalls, 0);
});

test('canonical request matches operation values and has stable SHA-256 fingerprint', () => {
  const one = canonicalizeMiniToolPublishRequest(valid);
  const two = canonicalizeMiniToolPublishRequest({ ...valid, tags: [' #tag '] });
  assert.deepEqual(one.request, { title: 'title', content: 'body', tags: ['tag'], images: ['/uploads/a.png'] });
  assert.match(one.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(one.fingerprint, two.fingerprint);
  const hashes = canonicalizeMiniToolPublishRequest({ ...valid, tags: ['##tag'] });
  assert.equal(one.fingerprint, hashes.fingerprint);
});

test('canonical title exactly matches the builder 20-character operation value', () => {
  const prefix = '12345678901234567890';
  const one = canonicalizeMiniToolPublishRequest({ ...valid, title: `${prefix}first suffix` });
  const two = canonicalizeMiniToolPublishRequest({ ...valid, title: `${prefix}other suffix` });
  assert.equal(one.request.title, prefix);
  assert.equal(one.fingerprint, two.fingerprint);
});

test('canonical title truncates Unicode code points without splitting emoji', () => {
  const title = `${'a'.repeat(19)}😀tail`;
  const canonical = canonicalizeMiniToolPublishRequest({ ...valid, title });
  assert.equal(canonical.request.title, `${'a'.repeat(19)}😀`);
  assert.equal([...canonical.request.title].length, 20);
  assert.equal(canonical.request.title.includes('\ud83d') && !canonical.request.title.includes('😀'), false);
});

test('alias saturation rejects the unregistered identity while existing aliases remain recoverable', async () => {
  let release;
  const registry = createMiniToolPublishJobRegistry({ maxAliasesPerJob: 2 });
  const canonical = registry.createOrReuse('u', 'attempt-one', 'fp', () => new Promise(resolve => { release = resolve; }));
  registry.createOrReuse('u', 'attempt-two', 'fp', async () => ({ duplicate: true }));
  assert.throws(
    () => registry.createOrReuse('u', 'attempt-three', 'fp', async () => ({ duplicate: true })),
    error => error.code === 'PUBLISH_ALIAS_CAPACITY'
  );
  assert.equal(registry.get('u', 'attempt-one'), canonical);
  assert.equal(registry.get('u', 'attempt-two'), canonical);
  assert.equal(registry.get('u', 'attempt-three'), null);
  await tick(); release({ ok: true }); await canonical.promise; registry.dispose();
});

test('ninth saturated alias is authoritatively rejected and existing aliases still poll', async () => {
  let release;
  const registry = createMiniToolPublishJobRegistry({ maxAliasesPerJob: 2 });
  const fingerprint = canonicalizeMiniToolPublishRequest(valid).fingerprint;
  const canonical = registry.createOrReuse('u1', valid.attemptId, fingerprint, () => new Promise(resolve => { release = resolve; }));
  registry.createOrReuse('u1', 'attempt-alias2', fingerprint, async () => ({}));
  const handler = createMiniToolPublishHandler(operationDeps({ registry }));
  const rejected = await invoke(handler, { ...valid, attemptId: 'attempt-alias9' });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.body.code, 'PUBLISH_ALIAS_CAPACITY');
  assert.equal(registry.get('u1', 'attempt-alias9'), null);
  assert.equal(registry.get('u1', 'attempt-alias2'), canonical);
  release({ ok: true }); await canonical.promise; registry.dispose();
});

test('same owner fingerprint retained work is reused before auth under a new attempt id', async () => {
  let authCalls = 0;
  const registry = createMiniToolPublishJobRegistry();
  const fingerprint = canonicalizeMiniToolPublishRequest(valid).fingerprint;
  const first = registry.createOrReuse('u1', 'attempt-first', fingerprint, async () => ({ ok: true, previewUrl: 'https://safe.test' }));
  await first.promise;
  const handler = createMiniToolPublishHandler(operationDeps({ registry, authManager: { getStatus: async () => { authCalls++; return { available: true, loggedIn: false }; } } }));
  const reused = await invoke(handler, { ...valid, attemptId: 'attempt-second' });
  assert.equal(reused.statusCode, 200);
  assert.equal(reused.body.attemptId, 'attempt-first');
  assert.equal(authCalls, 0);
  registry.dispose();
});

test('dry-run failure stays retryable and confirm timeout becomes outcome unknown', async () => {
  for (const [uploadPackage, expected] of [
    [async () => { throw new Error('dry-run'); }, 'failed'],
    [async (_path, { onBeforeConfirm }) => { onBeforeConfirm(); throw new Error('confirm timeout'); }, 'failed_after_side_effect']
  ]) {
    const registry = createMiniToolPublishJobRegistry();
    const handler = createMiniToolPublishHandler(operationDeps({ registry, uploadPackage }));
    const body = { ...valid, attemptId: `attempt-boundary-${expected}` };
    await invoke(handler, body);
    const job = registry.get('u1', body.attemptId);
    await job.promise;
    assert.equal(job.status, expected);
    registry.dispose();
  }
});

test('protected unknown jobs survive capacity pressure and reject admission', async () => {
  const registry = createMiniToolPublishJobRegistry({ maxEntries: 1 });
  const unknown = registry.createOrReuse('u1', 'attempt-one', 'fp1', async ({ markSideEffectStarted }) => {
    markSideEffectStarted();
    throw new Error('unknown');
  });
  await unknown.promise;
  assert.equal(unknown.status, 'failed_after_side_effect');
  assert.throws(() => registry.createOrReuse('u2', 'attempt-two', 'fp2', async () => ({})), error => error.code === 'PUBLISH_JOB_CAPACITY');
  assert.equal(registry.get('u1', 'attempt-one'), unknown);
  assert.equal(registry.getByFingerprint('u1', 'fp1'), unknown);
  assert.equal(registry.acknowledgeUnknown('u2', 'attempt-one'), false);
  assert.equal(registry.acknowledgeUnknown('u1', 'attempt-one'), true);
  assert.equal(registry.get('u1', 'attempt-one'), null);
  const replacement = registry.createOrReuse('u1', 'attempt-two', 'fp1', async () => ({ ok: true }));
  await replacement.promise;
  assert.equal(replacement.status, 'done');
  registry.dispose();
});

test('failed_after_side_effect tombstone survives terminal TTL and is retired only by acknowledgement', async () => {
  let current = 1_000_000;
  const registry = createMiniToolPublishJobRegistry({ now: () => current });
  let uploads = 0;
  const handler = createMiniToolPublishHandler(operationDeps({
    registry,
    uploadPackage: async () => { uploads++; return { fileId: 'f-ttl', md5: 'm-ttl' }; },
    createPreview: async () => { throw new Error('preview down'); }
  }));
  await invoke(handler, valid);
  const job = registry.get('u1', valid.attemptId);
  await job.promise;
  assert.equal(job.status, 'failed_after_side_effect');
  current += 31 * 60 * 1000;
  registry.cleanup();
  assert.equal(registry.get('u1', valid.attemptId), job);
  assert.equal(registry.getByFingerprint('u1', canonicalizeMiniToolPublishRequest(valid).fingerprint), job);
  const resubmit = await invoke(handler, { ...valid, attemptId: 'attempt-second' });
  assert.equal(resubmit.body.status, 'failed_after_side_effect');
  assert.equal(uploads, 1);
  assert.equal(registry.acknowledgeUnknown('u1', valid.attemptId), true);
  assert.equal(registry.get('u1', valid.attemptId), null);
  registry.dispose();
});

test('done DTO keeps authoritative identity and status over hostile result keys', async () => {
  const registry = createMiniToolPublishJobRegistry();
  const job = registry.createOrReuse('u1', 'attempt-safe', 'fp', async () => ({
    attemptId: 'hostile', requestedAttemptId: 'hostile', status: 'failed', ok: true
  }));
  await job.promise;
  const dto = registry.toDto(job, 'attempt-safe');
  assert.equal(dto.attemptId, 'attempt-safe');
  assert.equal(dto.status, 'done');
  assert.equal(dto.ok, true);
  assert.equal(dto.requestedAttemptId, undefined);
  registry.dispose();
});

test('unknown-outcome DTO surfaces only a sanitized upload receipt', async () => {
  const registry = createMiniToolPublishJobRegistry();
  const handler = createMiniToolPublishHandler(operationDeps({
    registry,
    uploadPackage: async () => ({ fileId: 'file-123', md5: 'md5abc', raw: '/private/path' }),
    createPreview: async () => { throw new Error('preview down'); }
  }));
  await invoke(handler, valid);
  const job = registry.get('u1', valid.attemptId);
  await job.promise;
  const dto = registry.toDto(job, valid.attemptId);
  assert.equal(dto.status, 'failed_after_side_effect');
  assert.deepEqual(dto.uploadReceipt, { fileId: 'file-123', md5: 'md5abc' });
  assert.equal(JSON.stringify(dto).includes('/private'), false);
  registry.dispose();
});

test('post-upload failure retains fingerprint and prevents automatic re-upload', async () => {
  let uploads = 0;
  const registry = createMiniToolPublishJobRegistry();
  const handler = createMiniToolPublishHandler(operationDeps({
    registry,
    uploadPackage: async () => { uploads++; return { fileId: 'receipt', md5: 'md5' }; },
    createPreview: async () => { throw new Error('preview failed'); }
  }));
  await invoke(handler, valid); const failed = registry.get('u1', valid.attemptId); await failed.promise;
  assert.equal(registry.toDto(failed).status, 'failed_after_side_effect');
  const retry = await invoke(handler, { ...valid, attemptId: 'attempt-second' });
  assert.equal(retry.body.status, 'failed_after_side_effect');
  assert.equal(uploads, 1);
  registry.dispose();
});

test('upload dispatch failure is retained as unknown because side effects may have begun', async () => {
  let uploads = 0;
  const registry = createMiniToolPublishJobRegistry();
  const handler = createMiniToolPublishHandler(operationDeps({ registry, uploadPackage: async (_path, { onBeforeConfirm }) => { uploads++; onBeforeConfirm(); throw new Error('transport lost'); } }));
  await invoke(handler, valid); const failed = registry.get('u1', valid.attemptId); await failed.promise;
  assert.equal(registry.toDto(failed).status, 'failed_after_side_effect');
  await invoke(handler, { ...valid, attemptId: 'attempt-second' });
  assert.equal(uploads, 1);
  registry.dispose();
});

test('existing owner reuse and conflict are resolved before redapp auth', async () => {
  let authCalls = 0;
  const registry = createMiniToolPublishJobRegistry();
  const first = registry.createOrReuse('u1', valid.attemptId, canonicalizeMiniToolPublishRequest(valid).fingerprint, async () => ({ ok: true }));
  await first.promise;
  const handler = createMiniToolPublishHandler(operationDeps({ registry, authManager: { getStatus: async () => { authCalls++; return { available: true, loggedIn: false }; } } }));
  const reuse = await invoke(handler, valid);
  assert.equal(reuse.statusCode, 200);
  assert.equal(reuse.body.status, 'done');
  const conflict = await invoke(handler, { ...valid, title: 'different' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(authCalls, 0);
  registry.dispose();
});

test('same attempt conflicts on another fingerprint and same fingerprint aliases one job', async () => {
  let calls = 0;
  let finish;
  const registry = createMiniToolPublishJobRegistry({ maxConcurrent: 2, perUserLimit: 3 });
  const first = registry.createOrReuse('u', 'attempt-one', 'fp1', async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  assert.throws(() => registry.createOrReuse('u', 'attempt-one', 'fp2', async () => ({})), e => e.code === 'PUBLISH_ATTEMPT_CONFLICT');
  const alias = registry.createOrReuse('u', 'attempt-two', 'fp1', async () => { calls++; });
  await tick();
  assert.equal(first, alias);
  assert.equal(calls, 1);
  assert.equal(registry.toDto(alias, 'attempt-two').attemptId, 'attempt-one');
  assert.equal(registry.toDto(alias, 'attempt-two').requestedAttemptId, 'attempt-two');
  finish({ ok: true }); await first.promise;
  registry.dispose();
});

test('failed fingerprints are removed so a new attempt can retry', async () => {
  const registry = createMiniToolPublishJobRegistry({ perUserLimit: 1 });
  const failed = registry.createOrReuse('u', 'attempt-one', 'fp', async () => { throw new Error('no'); });
  await failed.promise;
  const fresh = registry.createOrReuse('u', 'attempt-two', 'fp', async () => ({ ok: true }));
  assert.notEqual(fresh, failed);
  await fresh.promise;
  registry.dispose();
});

test('registry queues globally, enforces per-user admission, and starts next after deadline', async () => {
  let timeout;
  const timers = [];
  const starts = [];
  const registry = createMiniToolPublishJobRegistry({
    maxConcurrent: 1, perUserLimit: 1, jobDeadlineMs: 10,
    setTimer(fn) { const timer = { fn, unref() {} }; timers.push(timer); if (!timeout) timeout = timer; return timer; },
    clearTimer() {}
  });
  const late = registry.createOrReuse('u1', 'attempt-one', 'fp1', ({ signal }) => { starts.push('one'); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ late: true }))); });
  const queued = registry.createOrReuse('u2', 'attempt-two', 'fp2', async () => { starts.push('two'); return { ok: true }; });
  assert.equal(queued.status, 'queued');
  assert.throws(() => registry.createOrReuse('u2', 'attempt-three', 'fp3', async () => ({})), e => e.code === 'PUBLISH_USER_LIMIT');
  await tick(); timers.findLast(timer => timer !== queued.queueTimer).fn(); await tick(); await queued.promise;
  assert.equal(late.status, 'failed');
  assert.equal(queued.status, 'done');
  assert.deepEqual(starts, ['one', 'two']);
  registry.dispose();
});

test('registry keeps physical slot until abort-ignoring execution settles', async () => {
  const timers = [];
  let settleFirst;
  const starts = [];
  const registry = createMiniToolPublishJobRegistry({
    maxConcurrent: 1, perUserLimit: 1,
    setTimer(fn) { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}
  });
  const first = registry.createOrReuse('u1', 'attempt-one', 'fp1', async () => {
    starts.push('one');
    return new Promise(resolve => { settleFirst = resolve; });
  });
  const second = registry.createOrReuse('u2', 'attempt-two', 'fp2', async () => { starts.push('two'); return { ok: true }; });
  await tick();
  first.deadlineTimer.fn();
  await first.promise;
  assert.equal(first.status, 'failed');
  assert.equal(second.status, 'queued');
  assert.deepEqual(starts, ['one']);
  settleFirst({ late: true });
  await tick(); await second.promise;
  assert.deepEqual(starts, ['one', 'two']);
  assert.equal(first.status, 'failed');
  registry.dispose();
});

test('dispose resolves public running completion without waiting for physical execution', async () => {
  let settle;
  const registry = createMiniToolPublishJobRegistry();
  const running = registry.createOrReuse('u', 'attempt-one', 'fp1', () => new Promise(resolve => { settle = resolve; }));
  await tick(); registry.dispose();
  assert.equal(await Promise.race([running.promise.then(() => 'resolved'), new Promise(resolve => setTimeout(() => resolve('hung'), 20))]), 'resolved');
  assert.equal(running.status, 'failed');
  settle({ late: true }); await tick();
  assert.equal(running.status, 'failed');
});

test('dispose aborts running work, clears queue, and ignores late results', async () => {
  let release;
  let aborted = false;
  const registry = createMiniToolPublishJobRegistry({ maxConcurrent: 1, perUserLimit: 2 });
  const running = registry.createOrReuse('u', 'attempt-one', 'fp1', ({ signal }) => new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => { aborted = true; }); }));
  const queued = registry.createOrReuse('u', 'attempt-two', 'fp2', async () => ({ ok: true }));
  await tick(); registry.dispose();
  assert.equal(aborted, true);
  assert.equal(running.status, 'failed');
  assert.equal(queued.status, 'failed');
  release({ leaked: '/private/path' }); await tick();
  assert.deepEqual(registry.toDto(running, 'attempt-one'), { attemptId: 'attempt-one', status: 'failed', error: '扫码直达发布失败，请重新提交' });
});

test('audit fails closed for missing nonzero timeout ERROR and no PASS', async () => {
  for (const execution of [
    null,
    { status: 1, stdout: 'PASS', stderr: '', error: null },
    { status: null, stdout: '', stderr: '', error: new Error('timeout') },
    { status: 0, stdout: 'ERROR /private/path', stderr: '', error: null },
    { status: 0, stdout: 'all fine', stderr: '', error: null }
  ]) {
    const audit = createArtifactAuditor({ scriptExists: () => execution !== null, runProcess: async () => execution });
    await assert.rejects(() => audit('/private/target'), { message: 'artifact_audit_failed' });
  }
  const audit = createArtifactAuditor({ scriptExists: () => true, runProcess: async () => ({ status: 0, stdout: 'PASS', stderr: '', error: null }) });
  assert.deepEqual(await audit('/safe'), { status: 'passed' });
});

test('publish audits both targets asynchronously and returns only safe summary', async () => {
  const targets = [];
  const registry = createMiniToolPublishJobRegistry();
  const handler = createMiniToolPublishHandler(operationDeps({ registry, runAudit: async target => { targets.push(target); return { status: 'passed', raw: '/private/path' }; } }));
  const res = await invoke(handler, valid);
  assert.equal(res.statusCode, 202);
  await registry.get('u1', valid.attemptId).promise;
  const dto = registry.toDto(registry.get('u1', valid.attemptId), valid.attemptId);
  assert.deepEqual(targets, ['/safe/dir', '/safe/a.zip']);
  assert.deepEqual(dto.audit, { directory: 'passed', zip: 'passed' });
  assert.equal(JSON.stringify(dto).includes('/private'), false);
  registry.dispose();
});

test('failed terminal POST is authoritative and fingerprint conflict is safe 409', async () => {
  const registry = createMiniToolPublishJobRegistry();
  const handler = createMiniToolPublishHandler(operationDeps({ registry, buildMiniToolZip: async () => { throw new Error('/private/raw'); } }));
  await invoke(handler, valid); await registry.get('u1', valid.attemptId).promise;
  const failed = await invoke(handler, valid);
  assert.equal(failed.statusCode, 200); assert.equal(failed.body.status, 'failed');
  const conflict = await invoke(handler, { ...valid, title: 'different' });
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.body.code, 'PUBLISH_ATTEMPT_CONFLICT');
  assert.equal(JSON.stringify(conflict.body).includes('/private'), false);
  registry.dispose();
});

test('cleanup failures never overwrite a successful publish result', async () => {
  const registry = createMiniToolPublishJobRegistry();
  const handler = createMiniToolPublishHandler(operationDeps({
    registry,
    cleanupArtifacts: () => { throw new Error('C:/private/locked.zip'); }
  }));
  await invoke(handler, valid);
  const job = registry.get('u1', valid.attemptId);
  await job.promise;
  const dto = registry.toDto(job, valid.attemptId);
  assert.equal(dto.status, 'done');
  assert.equal(JSON.stringify(dto).includes('private'), false);
  registry.dispose();
});

test('attempt artifacts are cleaned after success and preview failure', async () => {
  const cleaned = [];
  for (const createPreview of [async () => ({ previewUrl: 'https://safe.test', qrCodePath: null }), async () => { throw new Error('preview'); }]) {
    const registry = createMiniToolPublishJobRegistry();
    const handler = createMiniToolPublishHandler(operationDeps({ registry, createPreview, cleanupArtifacts: id => cleaned.push(id) }));
    const body = { ...valid, attemptId: `attempt-clean-${cleaned.length}` };
    await invoke(handler, body); await registry.get('u1', body.attemptId).promise; registry.dispose();
  }
  assert.equal(cleaned.length, 2);
  assert.equal(cleaned.every(id => /^[A-Za-z0-9_-]+$/.test(id)), true);
});

test('QR candidate paths are deduplicated before bounded read', async () => {
  const reads = [];
  const registry = createMiniToolPublishJobRegistry();
  const handler = createMiniToolPublishHandler(operationDeps({
    registry,
    createPreview: async ({ qrOut }) => ({ qrCodePath: qrOut, previewUrl: '' }),
    readQrImage: candidate => { reads.push(candidate); throw new Error('invalid'); }
  }));
  await invoke(handler, valid); const job = registry.get('u1', valid.attemptId); await job.promise;
  assert.equal(reads.length, 1);
  registry.dispose();
});

test('QR stale path falls back to bounded valid PNG output', async () => {
  const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('x')]);
  const reads = [];
  const registry = createMiniToolPublishJobRegistry();
  const handler = createMiniToolPublishHandler(operationDeps({
    registry,
    createPreview: async () => ({ qrCodePath: '/stale.png', previewUrl: '' }),
    readQrImage: path => { reads.push(path); if (path.endsWith('-qr.png')) return 'data:image/png;base64,' + png.toString('base64'); throw new Error('二维码文件无效'); }
  }));
  await invoke(handler, valid); const job = registry.get('u1', valid.attemptId); await job.promise;
  assert.equal(registry.toDto(job, valid.attemptId).qrImage.startsWith('data:image/png;base64,'), true);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].endsWith('-qr.png'), true);
  registry.dispose();
});

test('async process runner keeps supervising Windows descendants after leader close', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4242; child.kill = () => true;
  const treeKills = [];
  const timers = [];
  const run = cli.createAsyncProcessRunner({
    platform: 'win32', spawnProcess: () => child,
    terminateTree: async (pid, force) => { treeKills.push([pid, force]); return force; },
    setTimer(fn) { const timer = { fn, unref() {} }; timers.push(timer); return timer; }, clearTimer() {}
  });
  const controller = new AbortController();
  const pending = run(['fake'], 1000, { signal: controller.signal });
  controller.abort(); await tick();
  assert.deepEqual(treeKills, [[4242, false]]);
  child.emit('close', null); await tick();
  assert.equal(await Promise.race([pending.then(() => 'settled'), tick().then(() => 'pending')]), 'pending');
  timers[1].fn(); await tick();
  assert.deepEqual(treeKills, [[4242, false], [4242, true]]);
  assert.equal((await pending).error.message, 'aborted');
});

test('async process runner abort signal kills then resolves only after child close', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killCount = 0; child.kill = () => { child.killCount++; };
  const controller = new AbortController();
  const run = cli.createAsyncProcessRunner({ spawnProcess: () => child, platform: 'linux', terminateTree: async () => true });
  let settled = false;
  const pending = run(['fake'], 1000, { signal: controller.signal }).then(result => { settled = true; return result; });
  controller.abort(); await tick();
  assert.equal(child.killCount, 0); assert.equal(settled, true);
  const result = await pending;
  assert.equal(result.error.message, 'aborted');
  assert.equal(child.listenerCount('close'), 0); assert.equal(controller.signal.onabort, null);
});

test('async process runner escalates an abort-ignoring child and settles at supervisor bound', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const kills = []; child.kill = signal => { kills.push(signal); return true; }; child.pid = 4242;
  const timers = [];
  const run = cli.createAsyncProcessRunner({
    spawnProcess: () => child,
    platform: 'linux',
    terminateTree: () => new Promise(() => {}),
    setTimer(fn) { const timer = { fn, unref() {} }; timers.push(timer); return timer; },
    clearTimer() {}
  });
  const controller = new AbortController();
  const pending = run(['fake'], 1000, { signal: controller.signal });
  controller.abort(); await tick();
  timers[2].fn();
  const result = await pending;
  assert.equal(result.error.message, 'process_termination_unconfirmed');
  assert.deepEqual(kills, []);
});

await publish.publishQueue.disconnect();
