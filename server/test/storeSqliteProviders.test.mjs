import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initStore, closeStore, createUser, deleteUser,
  listProviders, addProvider, updateProvider, deleteProvider,
  getProviderUnmaskedById, getActiveProvider, setActiveProvider
} from '../src/store.sqlite.js';

after(async () => { await closeStore(); });

test('addProvider 落库并在列表里脱敏 api key', async () => {
  await initStore();
  const created = await addProvider({
    name: 'Test Prov', baseUrl: 'https://example.com/v1/',
    apiKey: 'sk-1234567890abcdef', mode: 'image', imageModel: 'm1'
  });
  const listed = (await listProviders()).find(p => p.id === created.id);
  assert.equal(listed.baseUrl, 'https://example.com/v1');
  assert.notEqual(listed.apiKey, 'sk-1234567890abcdef');
  assert.match(listed.apiKey, /\*/);
  const raw = await getProviderUnmaskedById(created.id);
  assert.equal(raw.apiKey, 'sk-1234567890abcdef');
  await deleteProvider(created.id);
});

test('updateProvider 在 apiKey 留空或回传掩码时保留原值', async () => {
  const created = await addProvider({ name: 'Keep', apiKey: 'sk-keepme', mode: 'text' });
  await updateProvider(created.id, { name: 'Renamed', apiKey: '' });
  assert.equal((await getProviderUnmaskedById(created.id)).apiKey, 'sk-keepme');
  const masked = (await listProviders()).find(p => p.id === created.id).apiKey;
  await updateProvider(created.id, { name: 'Renamed 2', apiKey: masked });
  const raw = await getProviderUnmaskedById(created.id);
  assert.equal(raw.name, 'Renamed 2');
  assert.equal(raw.apiKey, 'sk-keepme');
  await deleteProvider(created.id);
});

test('getActiveProvider 优先用户设置，其次按模式回退', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const imageProvider = await addProvider({ name: 'ImgProv', mode: 'image', apiKey: 'sk-img' });
  const textProvider = await addProvider({ name: 'TxtProv', mode: 'text', apiKey: 'sk-txt' });
  const byMode = await getActiveProvider('text', user.id);
  assert.ok(byMode);
  assert.equal(byMode.mode, 'text');
  await setActiveProvider(imageProvider.id, 'image', user.id);
  assert.equal((await getActiveProvider('image', user.id)).id, imageProvider.id);
  await deleteProvider(imageProvider.id);
  await deleteProvider(textProvider.id);
  await deleteUser(user.id);
});

test('deleteProvider 清空引用它的用户设置', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const provider = await addProvider({ name: 'Gone', mode: 'image', apiKey: 'sk-gone' });
  await setActiveProvider(provider.id, 'image', user.id);
  await deleteProvider(provider.id);
  assert.equal((await getActiveProvider('image', user.id))?.id === provider.id, false);
  await deleteUser(user.id);
});
