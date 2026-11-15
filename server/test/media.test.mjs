import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closePool } from '../src/db.js';
import { insertMedia, getMedia } from '../src/store.js';
import { uploadResultAsset } from '../src/cloudStorage.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('media round-trips a buffer through slenk_notes_media', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const id = 'media_' + Math.random().toString(36).slice(2, 10);
  const data = Buffer.from('fake-image-bytes-1234567890');
  await insertMedia({ id, taskId: null, userId, filename: 'out.png', mimeType: 'image/png', data });
  const row = await getMedia(id);
  assert.ok(row, 'media should be found');
  assert.equal(row.filename, 'out.png');
  assert.equal(row.mimeType, 'image/png');
  assert.equal(row.sizeBytes, data.length);
  assert.deepEqual(Buffer.from(row.data), data);
});

test('getMedia returns null for an unknown id', async () => {
  assert.equal(await getMedia('media_nonexistent_zz'), null);
});

test('uploadResultAsset stores a local file and returns an /api/media/ url', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const file = path.join(os.tmpdir(), 'upload-asset-' + Math.random().toString(36).slice(2) + '.png');
  fs.writeFileSync(file, Buffer.from('png-bytes-for-upload-test'));
  const url = await uploadResultAsset(file, 'result.png', 'image/png', { taskId: null, userId });
  assert.match(url, /^\/api\/media\/[0-9a-f-]+$/, 'should return a local /api/media/<uuid> url');
  const row = await getMedia(url.replace('/api/media/', ''));
  assert.equal(row.filename, 'result.png');
  assert.equal(row.mimeType, 'image/png');
  fs.rmSync(file, { force: true });
});

test('GET /api/media/:id serves the stored bytes and 404s unknown ids', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const id = 'media_route_' + Math.random().toString(36).slice(2, 10);
  const data = Buffer.from('route-test-bytes');
  await insertMedia({ id, taskId: null, userId, filename: 'x.png', mimeType: 'image/png', data });

  const express = (await import('express')).default;
  const { router: mediaRouter } = await import('../src/routes/media.js');
  const app = express();
  app.use('/api/media', mediaRouter);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/media/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), data);
    const missing = await fetch(`http://127.0.0.1:${port}/api/media/nope`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
