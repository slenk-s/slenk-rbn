import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closePool, parseDbConfigFromUrl, configsDiffer, getEffectiveDb, testConnection, invalidateDbConfigCache } from '../src/db.js';
import { validateBody } from '../src/routes/settings.js';
import { sign } from '../src/auth.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

// MySQL 连接依赖的用例：仅当 TEST_DATA_BACKEND=mysql 时运行，否则跳过（默认 CI 只跑 SQLite）。
const enabled = process.env.TEST_DATA_BACKEND === 'mysql';
const opts = { skip: !enabled };

test('parseDbConfigFromUrl handles a name host and default port', () => {
  const a = parseDbConfigFromUrl('mysql://slenk:pw@slenk:3306/slenk_notes');
  assert.deepEqual(a, { host: 'slenk', port: 3306, user: 'slenk', password: 'pw', database: 'slenk_notes' });
  const b = parseDbConfigFromUrl('mysql://root:pw@127.0.0.1/slenk_notes');
  assert.equal(b.port, 3306);
  assert.equal(b.host, '127.0.0.1');
});

test('configsDiffer detects host/password changes', () => {
  const base = { host: 'a', port: 3306, user: 'u', password: 'p', database: 'd' };
  assert.equal(configsDiffer(base, { ...base }), false);
  assert.equal(configsDiffer(base, { ...base, host: 'b' }), true);
  assert.equal(configsDiffer(base, { ...base, password: 'q' }), true);
  assert.equal(configsDiffer(base, null), true);
  assert.equal(configsDiffer(null, base), true);
});

test('validateBody requires host/user/database and a valid port', () => {
  assert.equal(validateBody({}).error, 'host_required');
  assert.equal(validateBody({ host: 'h' }).error, 'user_required');
  assert.equal(validateBody({ host: 'h', user: 'u' }).error, 'database_required');
  assert.equal(validateBody({ host: 'h', user: 'u', database: 'd', port: 0 }).error, 'invalid_port');
  assert.equal(validateBody({ host: 'h', user: 'u', database: 'd', port: 99999 }).error, 'invalid_port');
  const ok = validateBody({ host: 'h', user: 'u', database: 'd', port: '3306', password: 'pw' });
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.config, { host: 'h', port: 3306, user: 'u', password: 'pw', database: 'd' });
});

test('tests never read db.json: getEffectiveDb always resolves from env', () => {
  const tmp = path.join(os.tmpdir(), 'dbcfg-' + Math.random().toString(36).slice(2) + '.json');
  const prev = process.env.DB_CONFIG_PATH;
  fs.writeFileSync(tmp, JSON.stringify({ host: 'bogus-host', port: 3306, user: 'u', password: 'x', database: 'bogus_db' }));
  try {
    process.env.DB_CONFIG_PATH = tmp;
    invalidateDbConfigCache();
    const { config, source } = getEffectiveDb();
    assert.equal(source, 'env');
    assert.notEqual(config.host, 'bogus-host');
  } finally {
    delete process.env.DB_CONFIG_PATH;
    if (prev !== undefined) process.env.DB_CONFIG_PATH = prev;
    fs.rmSync(tmp, { force: true });
    invalidateDbConfigCache();
  }
});

test('testConnection succeeds against the test DB and fails fast against a closed port', opts, async () => {
  const { config } = getEffectiveDb();
  const ok = await testConnection(config);
  assert.equal(ok.ok, true);
  const bad = await testConnection({ host: '127.0.0.1', port: 1, user: 'x', password: 'y', database: 'z' }, { connectTimeout: 2000 });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);
});

test('GET /api/settings/db returns passwordSet but never the password', opts, async (t) => {
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
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/db`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'env');
    assert.ok('passwordSet' in body);
    assert.equal('password' in body, false, 'password must never be returned');
  } finally {
    server.close();
  }
});

test('GET /api/settings/db is admin-gated', opts, async (t) => {
  const user = await createTestUser(false);
  t.after(() => dropTestUser(user));
  const token = sign({ id: user, username: user });

  const express = (await import('express')).default;
  const { router: settingsRouter } = await import('../src/routes/settings.js');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/db`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'admin_required');
  } finally {
    server.close();
  }
});
