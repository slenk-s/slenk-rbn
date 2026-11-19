import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { createXhsAccountPending, bindXhsAccountOpenId } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

// 真实 MySQL 连接测试：仅当 TEST_DATA_BACKEND=mysql 时运行，否则整体跳过（默认 CI 只跑 SQLite）。
const enabled = process.env.TEST_DATA_BACKEND === 'mysql';
const opts = { skip: !enabled };

after(() => closePool());

test('connects to the configured database', opts, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
  const expectedDb = url.pathname.replace(/^\//, '');
  const { rows } = await query('select database() as db, current_user() as usr');
  assert.equal(rows[0].db, expectedDb);
  assert.match(rows[0].usr, new RegExp('^' + url.username));
});

test('test helper creates and removes a user', opts, async (t) => {
  const id = await createTestUser();
  t.after(() => dropTestUser(id));
  const { rows } = await query('select username from slenk_notes_users where id = ?', [id]);
  assert.equal(rows[0].username, id);
});

// 真实库验证 unique(user_id, open_id) 冲突被映射为 XHS_ACCOUNT_DUPLICATE（23505）。
// 不同用户绑定同一 openId 允许，同用户重复绑定被拒绝。
test('bindXhsAccountOpenId maps duplicate open_id per user to XHS_ACCOUNT_DUPLICATE', opts, async (t) => {
  const userA = await createTestUser();
  const userB = await createTestUser();
  t.after(async () => { await dropTestUser(userA); await dropTestUser(userB); });

  await createXhsAccountPending(userA, { id: 'acct-a1', credentialDir: '/auth/a/acct-a1' });
  await createXhsAccountPending(userA, { id: 'acct-a2', credentialDir: '/auth/a/acct-a2' });
  await createXhsAccountPending(userB, { id: 'acct-b1', credentialDir: '/auth/b/acct-b1' });

  await bindXhsAccountOpenId(userA, 'acct-a1', { openId: 'ob-test-1' });
  await assert.rejects(
    bindXhsAccountOpenId(userA, 'acct-a2', { openId: 'ob-test-1' }),
    error => error?.code === 'XHS_ACCOUNT_DUPLICATE'
  );
  // 不同用户绑定同一 openId 不冲突。
  const bound = await bindXhsAccountOpenId(userB, 'acct-b1', { openId: 'ob-test-1' });
  assert.equal(bound.openId, 'ob-test-1');
});
