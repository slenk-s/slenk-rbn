import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { ensureAdmin, findUserByUsername, findUserById, createUser, getActiveProviderIds, setActiveProvider } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('ensureAdmin creates the admin account once', async () => {
  await ensureAdmin();
  await ensureAdmin();
  const admin = await findUserByUsername('admin');
  assert.ok(admin);
  assert.equal(admin.isAdmin, true);
  const { rows } = await query("select count(*)::int as n from slenk_notes_users where username = 'admin'");
  assert.equal(rows[0].n, 1);
});

test('findUserById returns null for an unknown id', async () => {
  assert.equal(await findUserById('nope_does_not_exist'), null);
});

test('createUser inserts a lookup-able user', async (t) => {
  const username = 'tu_user_' + Math.random().toString(36).slice(2, 8);
  const created = await createUser({ username, passwordHash: 'h', isAdmin: false });
  t.after(() => dropTestUser(created.id));
  const found = await findUserByUsername(username);
  assert.equal(found.id, created.id);
  assert.equal(found.isAdmin, false);
});

test('active provider ids default to null and persist per user', async (t) => {
  const id = await createTestUser();
  t.after(() => dropTestUser(id));
  const before = await getActiveProviderIds(id);
  assert.deepEqual(before, { activeProviderId: null, activeTextProviderId: null, activeImageProviderId: null });
  await setActiveProvider('prov_x', 'text', id);
  const afterIds = await getActiveProviderIds(id);
  assert.equal(afterIds.activeTextProviderId, 'prov_x');
  assert.equal(afterIds.activeImageProviderId, null);
});
