import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { createXhsAccountPending, bindXhsAccountOpenId } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('connects to the configured database', async () => {
  const { rows } = await query('select current_database() as db, current_user as usr');
  const expectedDb = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
    .pathname.replace(/^\//, '');
  assert.equal(rows[0].db, expectedDb);
  assert.match(rows[0].usr, /^postgres/);
});

test('test helper creates and removes a user', async (t) => {
  const id = await createTestUser();
  t.after(() => dropTestUser(id));
  const { rows } = await query('select username from slenk_notes_users where id = $1', [id]);
  assert.equal(rows.length, 1);
  await dropTestUser(id);
  const after = await query('select 1 from slenk_notes_users where id = $1', [id]);
  assert.equal(after.rows.length, 0);
});

// 真实库验证 unique(user_id, open_id) 冲突被映射为 XHS_ACCOUNT_DUPLICATE（23505）。
// 不同用户绑定同一 openId 允许，同用户重复绑定被拒绝。
test('bindXhsAccountOpenId maps duplicate open_id per user to XHS_ACCOUNT_DUPLICATE', async (t) => {
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
