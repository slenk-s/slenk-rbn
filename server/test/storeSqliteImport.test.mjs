import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/lib/sqlite.js';
import { initStore, closeStore, createUser, deleteUser, addProvider, deleteProvider, exportSyncRows, importSyncRows, findUserByUsername, listProviders } from '../src/store.sqlite.js';

after(async () => { await closeStore(); });

test('importLocalOnce 只迁移 users/providers/user_settings 且只执行一次', async () => {
  const localDir = path.join(process.env.STORAGE_PATH, 'local');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'users.json'), JSON.stringify([
    { id: 'imp_u1', username: 'imp_admin', password_hash: 'h1', is_admin: true, created_at: '2026-11-18 01:29:02.508' }
  ]));
  fs.writeFileSync(path.join(localDir, 'providers.json'), JSON.stringify([
    { id: 'imp_p1', name: 'Imp Prov', mode: 'image', api_key: 'sk-imp', base_url: 'https://x/v1', app_type: 'openai', provider_type: 'openai-compatible', image_api: 'json', notes: '', is_active: false, text_model: '', image_model: '', created_at: '2026-10-14 19:25:22.612', updated_at: '2026-10-15 14:43:54.490' }
  ]));
  fs.writeFileSync(path.join(localDir, 'user_settings.json'), JSON.stringify([
    { user_id: 'imp_u1', active_provider_id: 'imp_p1', active_text_provider_id: null, active_image_provider_id: null }
  ]));

  await initStore();
  const admin = await findUserByUsername('imp_admin');
  assert.equal(admin?.isAdmin, true);
  assert.match(admin.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const prov = (await listProviders()).find(p => p.id === 'imp_p1');
  assert.equal(prov?.baseUrl, 'https://x/v1');

  // 二次 init 不应重复插入（标记存在）
  await closeStore();
  await initStore();
  assert.equal((await findUserByUsername('imp_admin')).id, 'imp_u1');
});

test('exportSyncRows 返回 JSON 兼容行并可经 importSyncRows 幂等合并', async () => {
  const u = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const p = await addProvider({ name: 'Sync Prov', mode: 'text', apiKey: 'sk-sync' });
  const rows = await exportSyncRows();
  assert.ok(Array.isArray(rows.users));
  assert.ok(rows.users.some(r => r.id === u.id));
  // 每账号笔记/任务计数随 user 行镜像到云端（无笔记/任务的新用户应为 0）。
  const uRow = rows.users.find(r => r.id === u.id);
  assert.equal(uRow.note_count, 0);
  assert.equal(uRow.task_count, 0);
  assert.ok(rows.providers.some(r => r.id === p.id));
  assert.ok(Array.isArray(rows.userSettings));

  // 重新导入不应改变既有行
  await importSyncRows(rows);
  const again = await exportSyncRows();
  assert.equal(again.users.filter(r => r.id === u.id).length, 1);
  await deleteProvider(p.id);
  await deleteUser(u.id);
});

test('meta 表记录 local_import_v1 标记', async () => {
  const db = openDb();
  const row = db.prepare('select value from slenk_notes_meta where key = ?').get('local_import_v1');
  assert.equal(row?.value, 'done');
});
