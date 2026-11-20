import './env.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../src/auth.js';
import { createTestUser, dropTestUser } from './helpers.mjs';
import { initStore, closeStore } from '../src/store.js';
import { paths } from '../src/paths.js';

before(() => initStore());
after(() => closeStore());

test('SQLite 后端 GET /api/settings/db 返回存储信息，写接口报 sqlite_storage', async (t) => {
  const admin = await createTestUser(true);
  t.after(() => dropTestUser(admin));
  const token = sign({ id: admin, username: admin });
  const express = (await import('express')).default;
  const { router: settingsRouter } = await import('../src/routes/settings.js');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const get = await fetch(`http://127.0.0.1:${port}/api/settings/db`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.storage, 'sqlite');
    assert.equal(body.path, paths.sqlitePath);
    assert.equal(body.mediaDir, paths.mediaDir);
    const post = await fetch(`http://127.0.0.1:${port}/api/settings/db`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'h', user: 'u', database: 'd' })
    });
    assert.equal(post.status, 400);
    assert.equal((await post.json()).error, 'sqlite_storage');
  } finally {
    server.close();
  }
});
