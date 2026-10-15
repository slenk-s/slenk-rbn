import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.js';
import { saveNote, getNote } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('saveNote records the owner and round-trips tags and images', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const saved = await saveNote(userId, {
    title: '标题', content: '正文', tags: ['a', 'b'],
    images: [{ id: 'i1', url: '/uploads/x.png', name: 'x' }]
  });
  assert.equal(saved.userId, userId);
  const loaded = await getNote(saved.id);
  assert.equal(loaded.title, '标题');
  assert.deepEqual(loaded.tags, ['a', 'b']);
  assert.equal(loaded.images[0].url, '/uploads/x.png');
});

test('getNote stays public so share links keep working', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const saved = await saveNote(userId, { title: 'share me' });
  const loaded = await getNote(saved.id);
  assert.equal(loaded.title, 'share me');
});

test('deleting the owner removes their notes', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const saved = await saveNote(userId, { title: 'cascade' });
  await dropTestUser(userId);
  assert.equal(await getNote(saved.id), null);
});
