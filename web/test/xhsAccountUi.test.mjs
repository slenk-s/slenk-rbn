import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountDisplayName,
  accountLoginHint,
  accountStatusLabel,
  buildPublishAccountOptions,
  createPublishRequestSnapshot,
  createRedappAuthClient
} from '../src/redappAuthFlow.js';

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test('publish request snapshot preserves accountId', () => {
  const req = createPublishRequestSnapshot({
    title: '标题', content: '正文', tags: ['#学习'], images: ['/a.png'], accountId: 'acct-1'
  });
  assert.equal(req.accountId, 'acct-1');
});

test('publish request snapshot without accountId does not synthesize one', () => {
  const req = createPublishRequestSnapshot({ title: 't', content: 'c', tags: [], images: [] });
  assert.equal(req.accountId, undefined);
});

test('account picker excludes pending_bind accounts', () => {
  const options = buildPublishAccountOptions([
    { id: 'a1', status: 'bound', openIdMasked: 'ob5c…fa90' },
    { id: 'a2', status: 'pending_bind', openIdMasked: null }
  ]);
  assert.deepEqual(options.map(o => o.id), ['a1']);
});

test('account picker label prefers nickname, then masked openId, then id', () => {
  const options = buildPublishAccountOptions([
    { id: 'a1', status: 'bound', nickname: '小号', openIdMasked: 'ob5c…fa90' },
    { id: 'a2', status: 'bound', nickname: '', openIdMasked: 'ob11…zz22' },
    { id: 'a3', status: 'bound', nickname: '', openIdMasked: null }
  ]);
  assert.deepEqual(options.map(o => o.label), ['小号', 'ob11…zz22', 'a3']);
  assert.deepEqual(options.map(o => o.value), ['a1', 'a2', 'a3']);
});

test('account picker flags needsReauth accounts in the label', () => {
  const options = buildPublishAccountOptions([
    { id: 'a1', status: 'bound', openIdMasked: 'ob5c…fa90', needsReauth: true }
  ]);
  assert.equal(options.length, 1);
  assert.equal(options[0].needsReauth, true);
  assert.match(options[0].label, /需重新授权/);
});

test('account picker tolerates non-array input', () => {
  assert.deepEqual(buildPublishAccountOptions(null), []);
  assert.deepEqual(buildPublishAccountOptions(undefined), []);
});

test('accountStatusLabel maps bind status to Chinese labels', () => {
  assert.equal(accountStatusLabel('bound'), '已绑定');
  assert.equal(accountStatusLabel('pending_bind'), '待绑定');
  assert.equal(accountStatusLabel('anything-else'), '待绑定');
});

test('accountDisplayName prefers nickname, then masked openId, then fallback', () => {
  assert.equal(accountDisplayName({ nickname: '大号', openIdMasked: 'ob…90' }), '大号');
  assert.equal(accountDisplayName({ nickname: '', openIdMasked: 'ob…90' }), 'ob…90');
  assert.equal(accountDisplayName({ nickname: '', openIdMasked: null }), '待绑定账号');
});

test('accountLoginHint describes login state per account', () => {
  assert.equal(accountLoginHint({ status: 'pending_bind' }), '尚未扫码绑定');
  assert.equal(accountLoginHint({ status: 'bound', loggedIn: true, needsReauth: false }), '已登录');
  assert.equal(accountLoginHint({ status: 'bound', loggedIn: true, needsReauth: true }), '需要重新授权');
  assert.equal(accountLoginHint({ status: 'bound', loggedIn: false }), '未登录');
});

test('client account methods hit the accounts endpoints', async () => {
  const calls = [];
  const api = async (path, options) => {
    calls.push({ path, method: options?.method || 'GET' });
    if (path === '/api/redapp/accounts' && !options?.method) return fakeResponse([{ id: 'a1' }]);
    if (path === '/api/redapp/accounts') return fakeResponse({ id: 'a2', status: 'pending_bind' });
    return fakeResponse({ deleted: true });
  };
  const client = createRedappAuthClient({ api });
  assert.deepEqual(await client.listAccounts(), [{ id: 'a1' }]);
  assert.deepEqual(await client.createAccount(), { id: 'a2', status: 'pending_bind' });
  await client.deleteAccount('a1');
  await client.deleteAccount('a2', { deleteCredentials: false });
  assert.deepEqual(calls, [
    { path: '/api/redapp/accounts', method: 'GET' },
    { path: '/api/redapp/accounts', method: 'POST' },
    { path: '/api/redapp/accounts/a1?deleteCredentials=true', method: 'DELETE' },
    { path: '/api/redapp/accounts/a2?deleteCredentials=false', method: 'DELETE' }
  ]);
});

test('client threads accountId through auth endpoints as a query param', async () => {
  const calls = [];
  const api = async path => {
    calls.push(path);
    return fakeResponse({ sessionId: 's1', status: 'done' });
  };
  const client = createRedappAuthClient({ api });
  await client.status({ accountId: 'acct-1' });
  await client.login({ accountId: 'acct-1' });
  await client.session('s1', { accountId: 'acct-1' });
  await client.cancel('s1', { accountId: 'acct-1' });
  await client.logout({ accountId: 'acct-1' });
  assert.deepEqual(calls, [
    '/api/redapp/auth?accountId=acct-1',
    '/api/redapp/auth/login?accountId=acct-1',
    '/api/redapp/auth/session/s1?accountId=acct-1',
    '/api/redapp/auth/session/s1/cancel?accountId=acct-1',
    '/api/redapp/auth/logout?accountId=acct-1'
  ]);
});

test('pollSession fetches the session under the given accountId', async () => {
  const calls = [];
  const api = async path => {
    calls.push(path);
    return fakeResponse({ sessionId: 's1', status: 'done' });
  };
  const client = createRedappAuthClient({ api });
  const result = await client.pollSession('s1', { accountId: 'acct-9', timeoutMs: 5000 });
  assert.equal(result.status, 'done');
  assert.deepEqual(calls, ['/api/redapp/auth/session/s1?accountId=acct-9']);
});
