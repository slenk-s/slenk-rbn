import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRedappAuthManager } from '../src/lib/redappAuth.js';

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

// 同用户同一时刻最多一个登录会话；不同用户可并行（每用户独立 active / sessions / lock）。
test('blocks concurrent login for same user but allows different users', () => {
  const spawns = [];
  let sessionCounter = 0;
  const manager = createRedappAuthManager({
    spawnCli: options => {
      const child = createFakeChild();
      spawns.push({ credentialHome: options?.credentialHome, child });
      return child;
    },
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => `session-${++sessionCounter}`
  });

  // 用户 a 在 account1 发起登录，成功进入等待提示词状态。
  const first = manager.startLogin('a', 'account1', '/cred/a/account1');
  assert.equal(first.status, 'waiting_prompt');

  // 用户 a 试图在同一时刻登录另一个账号 → 必须被锁拒绝。
  assert.throws(
    () => manager.startLogin('a', 'account2', '/cred/a/account2'),
    error => error.code === 'XHS_LOGIN_BUSY'
  );

  // 同一账号重复发起 → 复用当前会话，不新增子进程。
  const reused = manager.startLogin('a', 'account1', '/cred/a/account1');
  assert.equal(reused.sessionId, first.sessionId);
  assert.equal(spawns.length, 1);

  // 用户 b 独立登录自己的 account1 → 并行成功，spawnCount 互不影响。
  const other = manager.startLogin('b', 'account1', '/cred/b/account1');
  assert.equal(other.status, 'waiting_prompt');
  assert.notEqual(other.sessionId, first.sessionId);
  assert.equal(spawns.length, 2);

  // 每个账号的登录都用自己的凭证目录。
  assert.equal(spawns[0].credentialHome, '/cred/a/account1');
  assert.equal(spawns[1].credentialHome, '/cred/b/account1');

  manager.dispose();
});

// 登录成功后，onLoginDone 必须以完整 openId（非掩码）回调，且发生在会话进入 done 之前。
test('fires onLoginDone with user account credentialDir and raw openId before done', async () => {
  const fake = createFakeChild();
  const doneEvents = [];
  let onLoginDoneSawActive = null;
  const manager = createRedappAuthManager({
    spawnCli: () => fake,
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-done',
    onLoginDone: info => {
      doneEvents.push(info);
      onLoginDoneSawActive = manager.getSession('u1', 'acct-1', 'session-done').status;
    }
  });

  manager.startLogin('u1', 'acct-1', '/cred/u1/acct-1');
  fake.stdout.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openId":"OPENID-123","accessToken":"hidden","scope":"base_info"}}\n');
  await tick();

  assert.equal(doneEvents.length, 1);
  assert.deepEqual(doneEvents[0], {
    userId: 'u1',
    accountId: 'acct-1',
    credentialDir: '/cred/u1/acct-1',
    openId: 'OPENID-123'
  });
  // onLoginDone 先于 finish('done')：回调执行时会话尚未进入终态。
  assert.equal(onLoginDoneSawActive, 'waiting_prompt');
  const session = manager.getSession('u1', 'acct-1', 'session-done');
  assert.equal(session.status, 'done');
  assert.equal(session.auth.loggedIn, true);
  assert.equal(JSON.stringify(session).includes('OPENID-123'), false);
});

// 登录成功进入 done 终态后，同账号再次 startLogin 应开启全新会话（旧终态不视为 active）。
test('allows a fresh login for the same account after the prior session finishes', async () => {
  const fake = createFakeChild();
  let spawnCount = 0;
  const manager = createRedappAuthManager({
    spawnCli: () => { spawnCount += 1; return fake; },
    runCli: async () => ({ credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    randomId: () => 'session-1'
  });

  manager.startLogin('u1', 'acct-1', '/cred/u1/acct-1');
  fake.stdout.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openId":"OPENID-1"}}\n');
  await tick();
  assert.equal(manager.getSession('u1', 'acct-1', 'session-1').status, 'done');

  // done 为终态，同账号再次 startLogin 复用的是新会话（旧终态不视为 active）。
  const again = manager.startLogin('u1', 'acct-1', '/cred/u1/acct-1');
  assert.equal(again.status, 'waiting_prompt');
  assert.equal(spawnCount, 2);
  manager.dispose();
});
