import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
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
