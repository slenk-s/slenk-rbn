import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRedappNpmEnv, createAsyncProcessRunner, createRedappOperationsAsync } from '../src/lib/redappCli.js';
import { createXhsAccountRegistry } from '../src/lib/xhsAccountRegistry.js';
import { matchLoginToAccount } from '../src/lib/xhsAccountMatcher.js';
import { paths } from '../src/paths.js';

test('injects SKILLHUB_UPLOAD_HOME when credentialHome is set', () => {
  const env = createRedappNpmEnv('win32', { credentialHome: 'C:/auth/u1/acct1' });
  assert.equal(env.SKILLHUB_UPLOAD_HOME, 'C:/auth/u1/acct1');
});

test('registry passes renameForUser through to the injected store', async () => {
  const registry = createXhsAccountRegistry({
    renameForUser: async (userId, accountId, nickname) => ({ userId, accountId, nickname })
  });
  const out = await registry.renameForUser('u1', 'acct-1', '大号');
  assert.deepEqual(out, { userId: 'u1', accountId: 'acct-1', nickname: '大号' });
});

test('omits SKILLHUB_UPLOAD_HOME when credentialHome is absent', () => {
  const env = createRedappNpmEnv('win32');
  assert.equal('SKILLHUB_UPLOAD_HOME' in env, false);
});

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('async process runner forwards per-call credentialHome into the child env', async () => {
  const child = createFakeChild();
  let capturedEnv = null;
  const run = createAsyncProcessRunner({
    spawnProcess: (cmd, args, options) => {
      capturedEnv = options.env;
      return child;
    }
  });
  const pending = run(['fake'], 1000, { credentialHome: 'C:/auth/u1/acct1' });
  child.emit('close', 0);
  await pending;
  assert.equal(capturedEnv.SKILLHUB_UPLOAD_HOME, 'C:/auth/u1/acct1');
});

test('async process runner omits SKILLHUB_UPLOAD_HOME when credentialHome is absent', async () => {
  const child = createFakeChild();
  let capturedEnv = null;
  const run = createAsyncProcessRunner({
    spawnProcess: (cmd, args, options) => {
      capturedEnv = options.env;
      return child;
    }
  });
  const pending = run(['fake'], 1000);
  child.emit('close', 0);
  await pending;
  assert.equal('SKILLHUB_UPLOAD_HOME' in capturedEnv, false);
});

test('async process runner accepts spawnProcess from per-call args with credentialHome env', async () => {
  const child = createFakeChild();
  let capturedEnv = null;
  let factorySpawnUsed = false;
  const run = createAsyncProcessRunner({
    spawnProcess: () => {
      factorySpawnUsed = true;
      return createFakeChild();
    }
  });
  const pending = run(['fake'], 1000, {
    credentialHome: 'C:/auth/u1/acct1',
    spawnProcess: (cmd, args, options) => {
      capturedEnv = options.env;
      return child;
    }
  });
  child.emit('close', 0);
  await pending;
  assert.equal(factorySpawnUsed, false);
  assert.equal(capturedEnv.SKILLHUB_UPLOAD_HOME, 'C:/auth/u1/acct1');
});

test('uploadPackageAsync forwards credentialHome to every runCommand invocation', async () => {
  const seen = [];
  const operations = createRedappOperationsAsync({
    runCommand: async (args, options) => {
      seen.push({ args, options });
      return args.includes('--dry-run') ? { plan: { planHash: 'plan-1' } } : { data: { fileId: 'file', md5: 'md5' } };
    },
    writeFile() {}, fileExists: () => false
  });
  await operations.uploadPackageAsync('package.zip', { credentialHome: 'C:/auth/u1/acct1' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].args.includes('--dry-run'), true);
  assert.equal(seen[1].args.includes('--confirm'), true);
  for (const { options } of seen) {
    assert.equal(options.credentialHome, 'C:/auth/u1/acct1');
  }
});

test('createPreviewAsync forwards credentialHome to every runCommand invocation', async () => {
  const seen = [];
  const operations = createRedappOperationsAsync({
    runCommand: async (args, options) => {
      seen.push({ args, options });
      return args.includes('--dry-run') ? { plan: { planHash: 'plan-1' } } : { data: { qrCodePath: 'qr.png', previewUrl: 'https://example.test/p' } };
    },
    writeFile() {}, fileExists: () => false
  });
  await operations.createPreviewAsync({ fileId: 'file', md5: 'md5', qrOut: 'qr.png', credentialHome: 'C:/auth/u1/acct1' });
  assert.equal(seen.length, 2);
  for (const { options } of seen) {
    assert.equal(options.credentialHome, 'C:/auth/u1/acct1');
  }
});

// ---- 账号绑定注册表（Task 2）：隔离、待绑定、冲突与凭证目录生命周期 ----

const a1 = { id: 'a-acct-1', userId: 'a', credentialDir: '/auth/a/a-acct-1', openId: 'ob1', nickname: 'A1', createdAt: 1, updatedAt: 1 };
const a2 = { id: 'a-acct-2', userId: 'a', credentialDir: '/auth/a/a-acct-2', openId: null, nickname: '', createdAt: 2, updatedAt: 2 };
const b1 = { id: 'b-acct', userId: 'b', credentialDir: '/auth/b/b-acct', openId: null, nickname: '', createdAt: 3, updatedAt: 3 };

// 模拟 store：内存行集合，按 user_id 过滤；bind 时模拟 unique(user_id, open_id) 冲突。
function createFakeXhsStore(initial = []) {
  const rows = initial.map(r => ({ ...r }));
  return {
    listForUser: async userId => rows.filter(r => r.userId === userId),
    getForUser: async (userId, id) => rows.find(r => r.userId === userId && r.id === id) || null,
    createPendingForUser: async (userId, { id, credentialDir }) => {
      const row = { id, userId, credentialDir, openId: null, nickname: '', createdAt: Date.now(), updatedAt: Date.now() };
      rows.push(row);
      return row;
    },
    bindOpenIdForUser: async (userId, id, { openId, nickname } = {}) => {
      const row = rows.find(r => r.userId === userId && r.id === id);
      if (!row) return null;
      if (rows.some(r => r.userId === userId && r.id !== id && r.openId === openId)) {
        const e = new Error('duplicate openId');
        e.code = 'XHS_ACCOUNT_DUPLICATE';
        throw e;
      }
      row.openId = openId;
      if (nickname !== undefined) row.nickname = nickname;
      return row;
    },
    findByOpenIdForUser: async (userId, openId) => rows.find(r => r.userId === userId && r.openId === openId) || null,
    deleteForUser: async (userId, id) => {
      const idx = rows.findIndex(r => r.userId === userId && r.id === id);
      return idx < 0 ? null : rows.splice(idx, 1)[0];
    }
  };
}

test('lists only own accounts and rejects cross-user access', async () => {
  // 注入 fake store：A 用户两个账号，B 用户一个账号。
  const registry = createXhsAccountRegistry(createFakeXhsStore([a1, a2, b1]));
  assert.deepEqual(await registry.listForUser('a'), [a1, a2]);
  assert.equal(await registry.getForUser('a', 'b-acct'), null);
});

test('creates pending account with null openId, then binds openId', async () => {
  const registry = createXhsAccountRegistry(createFakeXhsStore([a2, b1]));
  const pending = await registry.createPendingForUser('a', { credentialDir: 'd1' });
  assert.equal(pending.openId, null);
  const bound = await registry.bindOpenIdForUser('a', pending.id, { openId: 'ob1' });
  assert.equal(bound.openId, 'ob1');
});

test('rejects duplicate openId for same user but allows it across users', async () => {
  const registry = createXhsAccountRegistry(createFakeXhsStore([a1, a2, b1]));
  await assert.rejects(
    () => registry.bindOpenIdForUser('a', 'a-acct-2', { openId: 'ob1' }),
    { code: 'XHS_ACCOUNT_DUPLICATE' }
  );
  // 用户 b 绑定同一 openId 不冲突
  const b = await registry.bindOpenIdForUser('b', 'b-acct', { openId: 'ob1' });
  assert.equal(b.openId, 'ob1');
});

test('bindOpenIdForUser stores nickname and returns null for cross-user account', async () => {
  const registry = createXhsAccountRegistry(createFakeXhsStore([a1, a2, b1]));
  const bound = await registry.bindOpenIdForUser('a', 'a-acct-2', { openId: 'ob2', nickname: '昵称' });
  assert.equal(bound.openId, 'ob2');
  assert.equal(bound.nickname, '昵称');
  assert.equal(await registry.bindOpenIdForUser('a', 'b-acct', { openId: 'obX' }), null);
});

test('finds account by openId scoped to user', async () => {
  const registry = createXhsAccountRegistry(createFakeXhsStore([a1, a2, b1]));
  assert.equal((await registry.findByOpenIdForUser('a', 'ob1')).id, 'a-acct-1');
  assert.equal(await registry.findByOpenIdForUser('a', 'ob-unknown'), null);
});

test('resolveCredentialDir returns dir for bound and pending accounts, null otherwise', async () => {
  const registry = createXhsAccountRegistry(createFakeXhsStore([a1, a2, b1]));
  assert.equal(await registry.resolveCredentialDir('a', 'a-acct-1'), '/auth/a/a-acct-1');
  assert.equal(await registry.resolveCredentialDir('a', 'a-acct-2'), '/auth/a/a-acct-2');
  assert.equal(await registry.resolveCredentialDir('a', 'b-acct'), null);
});

test('deleteForUser removes credential dir when deleteCredentials is true', async () => {
  const removed = [];
  const registry = createXhsAccountRegistry({
    ...createFakeXhsStore([a1, a2, b1]),
    removeCredentialDir: async dir => { removed.push(dir); }
  });
  const ok = await registry.deleteForUser('a', 'a-acct-2', { deleteCredentials: true });
  assert.equal(ok, true);
  assert.deepEqual(removed, ['/auth/a/a-acct-2']);
});

test('deleteForUser keeps credential dir when deleteCredentials is false', async () => {
  const removed = [];
  const registry = createXhsAccountRegistry({
    ...createFakeXhsStore([a1, a2, b1]),
    removeCredentialDir: async dir => { removed.push(dir); }
  });
  const ok = await registry.deleteForUser('a', 'a-acct-2', { deleteCredentials: false });
  assert.equal(ok, true);
  assert.deepEqual(removed, []);
});

test('deleteForUser returns false for cross-user account and removes nothing', async () => {
  const removed = [];
  const registry = createXhsAccountRegistry({
    ...createFakeXhsStore([a1, a2, b1]),
    removeCredentialDir: async dir => { removed.push(dir); }
  });
  const ok = await registry.deleteForUser('a', 'b-acct', { deleteCredentials: true });
  assert.equal(ok, false);
  assert.deepEqual(removed, []);
});

test('createPendingForUser uses injected id/dir generators when dir omitted', async () => {
  const registry = createXhsAccountRegistry({
    ...createFakeXhsStore([]),
    generateAccountId: () => 'acct-gen-1',
    generateCredentialDir: (userId, accountId) => `/custom/${userId}/${accountId}`
  });
  const pending = await registry.createPendingForUser('a', {});
  assert.equal(pending.id, 'acct-gen-1');
  assert.equal(pending.credentialDir, '/custom/a/acct-gen-1');
  assert.equal(pending.openId, null);
});

test('default credential dir resolves to storage/auth/<userId>/<accountId> under app root', async () => {
  const saved = process.env.SLENK_XHS_AUTH_ROOT;
  try {
    delete process.env.SLENK_XHS_AUTH_ROOT;
    const registry = createXhsAccountRegistry({
      ...createFakeXhsStore([]),
      generateAccountId: () => 'acct-7'
    });
    const pending = await registry.createPendingForUser('u1', {});
    assert.equal(pending.credentialDir, path.join(paths.root, 'storage', 'auth', 'u1', 'acct-7'));
  } finally {
    if (saved === undefined) delete process.env.SLENK_XHS_AUTH_ROOT;
    else process.env.SLENK_XHS_AUTH_ROOT = saved;
  }
});

test('SLENK_XHS_AUTH_ROOT overrides the default credential dir root', async () => {
  const saved = process.env.SLENK_XHS_AUTH_ROOT;
  try {
    process.env.SLENK_XHS_AUTH_ROOT = '/custom/auth-root';
    const registry = createXhsAccountRegistry({
      ...createFakeXhsStore([]),
      generateAccountId: () => 'acct-7'
    });
    const pending = await registry.createPendingForUser('u1', {});
    assert.equal(pending.credentialDir, path.join('/custom/auth-root', 'u1', 'acct-7'));
  } finally {
    if (saved === undefined) delete process.env.SLENK_XHS_AUTH_ROOT;
    else process.env.SLENK_XHS_AUTH_ROOT = saved;
  }
});

// ---- 扫码自动匹配（Task 4）：首次回填 / 冲突清理 / 同账号重扫 / 仅用户内匹配 ----

// 记录调用的最小匹配器注册表：matcher 只依赖 findByOpenIdForUser / bindOpenIdForUser / deleteForUser。
function createFakeMatcherRegistry({ existing = null, duplicateOnBind = false } = {}) {
  const calls = { find: 0, bind: 0, delete: [] };
  return {
    calls,
    findByOpenIdForUser: async () => { calls.find += 1; return existing; },
    bindOpenIdForUser: async (userId, id, options) => {
      calls.bind += 1;
      calls.lastBind = { userId, id, options };
      if (duplicateOnBind) {
        const error = new Error('XHS 账号已绑定');
        error.code = 'XHS_ACCOUNT_DUPLICATE';
        throw error;
      }
      return { id, userId, openId: options.openId };
    },
    deleteForUser: async (userId, id, options) => { calls.delete.push({ userId, id, options }); return { id, userId }; }
  };
}

test('binds openId on first scan and returns a matched account', async () => {
  const registry = createFakeMatcherRegistry();
  const result = await matchLoginToAccount({
    userId: 'u1', accountId: 'acct-new', credentialDir: '/cred/new', openId: 'ob1', registry
  });
  assert.deepEqual(result, { matched: true, accountId: 'acct-new' });
  assert.equal(registry.calls.find, 1);
  assert.equal(registry.calls.bind, 1);
  assert.deepEqual(registry.calls.lastBind, { userId: 'u1', id: 'acct-new', options: { openId: 'ob1' } });
  assert.equal(registry.calls.delete.length, 0);
});

test('cleans the pending row and credential dir when the openId belongs to a different account', async () => {
  const registry = createFakeMatcherRegistry({ existing: { id: 'acct-old', userId: 'u1', openId: 'ob1' } });
  const result = await matchLoginToAccount({
    userId: 'u1', accountId: 'acct-new', credentialDir: '/cred/new', openId: 'ob1', registry
  });
  assert.deepEqual(result, { matched: false, conflict: true, existingId: 'acct-old' });
  assert.deepEqual(registry.calls.delete, [{ userId: 'u1', id: 'acct-new', options: { deleteCredentials: true } }]);
  assert.equal(registry.calls.bind, 0);
});

test('rebinding the same account is a no-op match', async () => {
  const registry = createFakeMatcherRegistry({ existing: { id: 'acct-1', userId: 'u1', openId: 'ob1' } });
  const result = await matchLoginToAccount({
    userId: 'u1', accountId: 'acct-1', credentialDir: '/cred/1', openId: 'ob1', registry
  });
  assert.deepEqual(result, { matched: true, accountId: 'acct-1' });
  assert.equal(registry.calls.bind, 0);
  assert.equal(registry.calls.delete.length, 0);
});

test('matches only within the current user: another user binding the same openId is untouched', async () => {
  // 用户 a 已绑定 ob1；用户 b 扫同一 openId 视为首次绑定，不受 a 影响。
  const registry = createFakeMatcherRegistry();
  const result = await matchLoginToAccount({
    userId: 'b', accountId: 'b-acct', credentialDir: '/cred/b', openId: 'ob1', registry
  });
  assert.deepEqual(result, { matched: true, accountId: 'b-acct' });
  assert.equal(registry.calls.bind, 1);
});

test('rejects a missing or non-string openId without querying or binding', async () => {
  const registry = createFakeMatcherRegistry();
  for (const openId of [undefined, null, '', '   ']) {
    const result = await matchLoginToAccount({
      userId: 'u1', accountId: 'acct-new', credentialDir: '/cred/new', openId, registry
    });
    assert.equal(result.matched, false);
    assert.equal(typeof result.error, 'string');
  }
  assert.equal(registry.calls.find, 0);
  assert.equal(registry.calls.bind, 0);
  assert.equal(registry.calls.delete.length, 0);
});

test('maps a concurrent unique collision to XHS_ACCOUNT_DUPLICATE', async () => {
  const registry = createFakeMatcherRegistry({ duplicateOnBind: true });
  await assert.rejects(
    () => matchLoginToAccount({
      userId: 'u1', accountId: 'acct-new', credentialDir: '/cred/new', openId: 'ob1', registry
    }),
    { code: 'XHS_ACCOUNT_DUPLICATE' }
  );
});
