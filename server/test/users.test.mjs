import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { ensureAdmin, findUserByUsername, findUserById, createUser, updateUser, deleteUser, listUsers, getActiveProviderIds, setActiveProvider, saveNote, addTask } from '../src/store.js';
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

test('updateUser sets a new password hash and the admin flag', async (t) => {
  const created = await createUser({ username: 'tu_upd_' + Math.random().toString(36).slice(2, 8), passwordHash: 'old', isAdmin: false });
  t.after(() => dropTestUser(created.id));
  await updateUser(created.id, { passwordHash: 'new-hash' });
  let found = await findUserById(created.id);
  assert.equal(found.passwordHash, 'new-hash');
  assert.equal(found.isAdmin, false);
  await updateUser(created.id, { isAdmin: true });
  found = await findUserById(created.id);
  assert.equal(found.isAdmin, true);
  assert.equal(found.passwordHash, 'new-hash');
});

test('updateUser with an empty patch returns the user unchanged', async (t) => {
  const created = await createUser({ username: 'tu_noop_' + Math.random().toString(36).slice(2, 8), passwordHash: 'keep', isAdmin: false });
  t.after(() => dropTestUser(created.id));
  const same = await updateUser(created.id, {});
  assert.equal(same.id, created.id);
  assert.equal(same.passwordHash, 'keep');
});

test('updateUser returns null for an unknown id', async () => {
  assert.equal(await updateUser('nope_missing_user', { isAdmin: true }), null);
});

test('listUsers reports per-user note and task counts', async (t) => {
  const id = await createTestUser();
  t.after(() => dropTestUser(id));
  await saveNote(id, { title: 'counted note' });
  await addTask({ id: 'task_count_' + Math.random().toString(36).slice(2, 8), userId: id, type: 'image', payload: {}, tab: 'ai-image' });
  const rows = await listUsers();
  const mine = rows.find(r => r.id === id);
  assert.ok(mine, 'created user should appear in listUsers');
  assert.equal(mine.noteCount, 1);
  assert.equal(mine.taskCount, 1);
  assert.equal('passwordHash' in mine, false, 'listUsers must not leak the password hash');
});

test('deleteUser removes the user and cascades their content', async (t) => {
  const id = await createTestUser();
  const note = await saveNote(id, { title: 'goes away with the owner' });
  await deleteUser(id);
  t.after(() => dropTestUser(id));
  assert.equal(await findUserById(id), null);
  const { rows } = await query('select 1 from slenk_notes_notes where id = $1', [note.id]);
  assert.equal(rows.length, 0, 'the note should be gone with its owner');
});

test('deleteUser returns false for an unknown id', async () => {
  assert.equal(await deleteUser('nope_missing_user'), false);
});