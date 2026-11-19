import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initStore, closeStore, listMediaIds } from '../src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

test('store.js 默认分派到 sqlite 并提供新增契约函数', async () => {
  await initStore();
  assert.ok(Array.isArray(await listMediaIds()));
  await closeStore();
});

test('未知后端启动即抛错', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "process.env.SLENK_DATA_BACKEND='bogus'; await import('./server/src/store.js');"
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SLENK_DATA_BACKEND/);
});
