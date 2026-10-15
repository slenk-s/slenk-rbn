import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { listProviders, addProvider, updateProvider, deleteProvider, getActiveProvider, getProviderUnmaskedById } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('providers round-trip and mask api keys in list output', async (t) => {
  const created = await addProvider({
    name: 'Test Prov', baseUrl: 'https://example.com/v1',
    apiKey: 'sk-1234567890abcdef', mode: 'image', imageModel: 'm1'
  });
  t.after(() => deleteProvider(created.id));
  const listed = (await listProviders()).find(p => p.id === created.id);
  assert.notEqual(listed.apiKey, 'sk-1234567890abcdef');
  assert.match(listed.apiKey, /^sk-1\*{11}cdef$/);
  const raw = await getProviderUnmaskedById(created.id);
  assert.equal(raw.apiKey, 'sk-1234567890abcdef');
});

test('updateProvider keeps the existing api key when the input omits it', async (t) => {
  const created = await addProvider({ name: 'Keep Key', apiKey: 'sk-keepme', mode: 'text' });
  t.after(() => deleteProvider(created.id));
  await updateProvider(created.id, { name: 'Renamed', apiKey: '' });
  const raw = await getProviderUnmaskedById(created.id);
  assert.equal(raw.name, 'Renamed');
  assert.equal(raw.apiKey, 'sk-keepme');
});

test('updateProvider treats a masked api key echoed back as unchanged', async (t) => {
  const created = await addProvider({ name: 'Echo Key', apiKey: 'sk-echokey-123456', mode: 'text' });
  t.after(() => deleteProvider(created.id));
  const masked = (await listProviders()).find(p => p.id === created.id).apiKey;
  assert.notEqual(masked, 'sk-echokey-123456');
  await updateProvider(created.id, { name: 'Echo Renamed', apiKey: masked });
  const raw = await getProviderUnmaskedById(created.id);
  assert.equal(raw.name, 'Echo Renamed');
  assert.equal(raw.apiKey, 'sk-echokey-123456');
});

test('getActiveProvider prefers the user setting then falls back by mode', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const imageProvider = await addProvider({ name: 'ImgProv', mode: 'image', apiKey: 'sk-img' });
  const textProvider = await addProvider({ name: 'TxtProv', mode: 'text', apiKey: 'sk-txt' });
  t.after(async () => { await deleteProvider(imageProvider.id); await deleteProvider(textProvider.id); });

  const byMode = await getActiveProvider('text', userId);
  assert.equal(byMode.id, textProvider.id);

  await query(
    `insert into slenk_notes_user_settings (user_id, active_image_provider_id) values ($1, $2)
     on conflict (user_id) do update set active_image_provider_id = excluded.active_image_provider_id`,
    [userId, imageProvider.id]
  );
  const bySetting = await getActiveProvider('image', userId);
  assert.equal(bySetting.id, imageProvider.id);
});
