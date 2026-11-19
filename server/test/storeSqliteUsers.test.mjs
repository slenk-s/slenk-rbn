import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initStore, closeStore, ensureAdmin, findUserByUsername, findUserById,
  createUser, listUsers, updateUser, deleteUser, getActiveProviderIds, setActiveProvider
} from '../src/store.sqlite.js';

after(() => closeStore());

test('initStore 建表后可创建并读取用户', async () => {
  await initStore();
  const created = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h', isAdmin: false });
  const found = await findUserById(created.id);
  assert.equal(found.username, created.username);
  assert.equal(found.isAdmin, false);
  assert.match(found.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  await deleteUser(created.id);
});

test('ensureAdmin 只创建一次 admin', async () => {
  await ensureAdmin();
  await ensureAdmin();
  const users = await listUsers();
  assert.equal(users.filter(u => u.username === 'admin').length, 1);
  const admin = await findUserByUsername('admin');
  assert.equal(admin.isAdmin, true);
});

test('updateUser 修改密码与管理员标记', async () => {
  const created = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'old', isAdmin: false });
  const updated = await updateUser(created.id, { passwordHash: 'new', isAdmin: true });
  assert.equal(updated.passwordHash, 'new');
  assert.equal(updated.isAdmin, true);
  await deleteUser(created.id);
});

test('active provider ids 默认为 null 且按用户持久化', async () => {
  const created = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  assert.deepEqual(await getActiveProviderIds(created.id), {
    activeProviderId: null, activeTextProviderId: null, activeImageProviderId: null
  });
  await setActiveProvider('prov_x', 'text', created.id);
  const ids = await getActiveProviderIds(created.id);
  assert.equal(ids.activeTextProviderId, 'prov_x');
  assert.equal(ids.activeImageProviderId, null);
  await deleteUser(created.id);
});

test('deleteUser 返回是否删到行', async () => {
  const created = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  assert.equal(await deleteUser(created.id), true);
  assert.equal(await deleteUser('nope_zz'), false);
  assert.equal(await findUserById(created.id), null);
});
