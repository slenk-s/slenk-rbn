import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRedappAuthManager } from '../src/lib/redappAuth.js';
import {
  createRedappCliEnsurer,
  createRedappCommandRunner,
  createRedappOperations,
  parseTaggedOutput,
  sanitizeCredentials
} from '../src/lib/redappCli.js';

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

test('cancels locally before invoking the exact remote cancel command', () => {
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
  const cancelled = manager.cancelLogin('session-1');
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

test('removes terminal sessions after five minutes', () => {
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
  manager.cancelLogin('session-1');
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
  manager.cancelLogin('session-1');
  manager.startLogin();
  manager.dispose();

  assert.equal(activeChild.killed, true);
  assert.equal(manager.getSession('session-1'), null);
  assert.equal(manager.getSession('session-2'), null);
  assert.equal(timers.every(timer => timer.cleared), true);
});

test('projects credential status and logout results through safe DTOs', () => {
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

  for (const result of [manager.getStatus(), manager.logout()]) {
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
  assert.deepEqual(manager.getStatus(), expected);
  assert.deepEqual(manager.logout(), expected);

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

  manager.cancelLogin('session-1');
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
  const result = manager.logout();
  assert.deepEqual(calls, [['logout']]);
  assert.equal(result.loggedIn, false);
  assert.equal(manager.getSession('session-1'), null);

  fake.stdout.write('PROMPT:{"qrCodePath":"late.png","expiresInSeconds":10}\n');
  fake.stdout.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true}}\n');
  fake.emit('close', 0);
  await tick();
  assert.equal(manager.getSession('session-1'), null);
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

test('keeps every work-creating method closed after disposal', () => {
  let spawnCount = 0;
  let runCount = 0;
  const manager = createRedappAuthManager({
    spawnCli: () => { spawnCount += 1; return createFakeChild(); },
    runCli: () => { runCount += 1; return { credentials: { loggedIn: false } }; },
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.dispose();
  for (const call of [
    () => manager.startLogin(),
    () => manager.getStatus(),
    () => manager.cancelLogin('session-1'),
    () => manager.logout()
  ]) {
    assert.throws(call, { message: '授权管理器已关闭' });
  }
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
