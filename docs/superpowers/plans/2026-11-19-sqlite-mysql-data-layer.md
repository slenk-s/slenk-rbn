# SQLite/MySQL 双后端与文件媒体 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把数据层收敛为 SQLite（默认）与 MySQL 两个后端，媒体字节统一存文件，删除本地 JSON 后端。

**Architecture:** 保留 `store.mysql.js` 并改造媒体读写；新增 `store.sqlite.js`（Node 内置 `node:sqlite`）实现同一份函数契约；媒体文件读写抽到 `lib/mediaFiles.js` 供两者共用；`store.js` 按 `SLENK_DATA_BACKEND` 分派，非法值启动即抛错。

**Tech Stack:** Node 24 `node:sqlite`、Express、mysql2、node:test、React 19。

**Spec:** `docs/superpowers/specs/2026-11-19-sqlite-mysql-data-layer-design.md`

## Global Constraints

- `SLENK_DATA_BACKEND` 只接受 `sqlite` / `mysql`，未设置时按 `sqlite`；其它值启动即抛错。
- SQLite 文件默认 `<dataDir>/slenk.sqlite`（`SQLITE_PATH` 可覆盖），媒体默认 `<dataDir>/media`（`MEDIA_DIR` 可覆盖）。
- 媒体路径固定为 `<mediaDir>/<id>`，数据库只存元数据，不存路径。
- 时间戳统一 `YYYY-MM-DDTHH:MM:SS.mmmZ`（UTC ISO-8601，`Date#toISOString()` 格式）。
- 不新增原生依赖；SQLite 只用 `node:sqlite`。
- 只迁移本地 JSON 的 `users` / `providers` / `user_settings`；任务、笔记、XHS 账号、媒体都不迁移。
- 测试默认 `SLENK_DATA_BACKEND=sqlite` + 临时库；MySQL 测试仅在 `TEST_DATA_BACKEND=mysql` 时运行。
- 所有服务器测试从仓库根目录执行：`node --test server/test/<file>.test.mjs`。
- 实现从设计分支拉出：`git checkout -b feat/sqlite-data-layer docs/sqlite-mysql-data-layer-design`。

## File Structure

| 文件 | 责任 |
| --- | --- |
| `server/src/lib/mediaFiles.js` | 媒体文件的写入、读取、删除；唯一接触媒体目录的模块 |
| `server/src/lib/sqlite.js` | SQLite 连接、PRAGMA、事务、busy 重试、JSON 辅助 |
| `server/src/store.sqlite.js` | SQLite 适配器，实现完整 store 契约 |
| `server/src/store.mysql.js` | MySQL 适配器；媒体改文件、新增契约函数 |
| `server/src/store.js` | 后端分派与统一导出 |
| `server/src/syncTiDB.js` | 纯数据推送/拉取，不再读写本地 JSON |
| `server/scripts/schema.sqlite.sql` | SQLite 建表脚本 |
| `server/scripts/migrate-media-files.mjs` | MySQL 媒体列迁移（一次性） |
| `server/scripts/media-janitor.mjs` | 媒体文件巡检（默认只读） |
| `server/test/env.mjs` | 测试环境（临时库/媒体目录） |
| `server/test/helpers.mjs` | 测试用户创建/删除（走 store） |

---

### Task 1: 测试环境与媒体文件层

**Files:**
- Create: `server/test/env.mjs`
- Create: `server/src/lib/mediaFiles.js`
- Test: `server/test/mediaFiles.test.mjs`

**Interfaces:**
- Produces: `mediaRoot(): string`, `mediaPath(id): string`, `writeMediaFile(id, data): number`, `readMediaFile(id): Buffer | null`, `removeMediaFile(id): void`, `removeMediaFiles(ids): void`, `testDir: string` from `test/env.mjs`.

- [ ] **Step 1: 写测试环境模块**

Create `server/test/env.mjs`:

```js
// 每个测试文件的第一条 import：创建独立临时目录并设置后端环境变量。
// ESM 按 import 顺序求值，因此本文件必须先于 store/paths 被 import。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const backend = process.env.TEST_DATA_BACKEND || 'sqlite';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slenk-test-'));

process.env.SLENK_DATA_BACKEND = backend;
process.env.TEST_DATA_BACKEND = backend;
process.env.STORAGE_PATH = dir;
process.env.SQLITE_PATH = path.join(dir, 'test.sqlite');
process.env.MEDIA_DIR = path.join(dir, 'media');

export const testDir = dir;

process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
```

- [ ] **Step 2: 写失败的测试**

Create `server/test/mediaFiles.test.mjs`:

```js
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mediaRoot, mediaPath, writeMediaFile, readMediaFile, removeMediaFile, removeMediaFiles } from '../src/lib/mediaFiles.js';

test('writeMediaFile 落盘后 readMediaFile 读回相同字节，且不留临时文件', () => {
  const id = 'm_' + Math.random().toString(36).slice(2);
  const data = Buffer.from('hello-media');
  assert.equal(writeMediaFile(id, data), data.length);
  assert.deepEqual(readMediaFile(id), data);
  assert.ok(fs.existsSync(mediaPath(id)));
  assert.equal(fs.readdirSync(mediaRoot()).filter(n => n.endsWith('.tmp')).length, 0);
  removeMediaFile(id);
});

test('readMediaFile 对不存在的 id 返回 null', () => {
  assert.equal(readMediaFile('missing_zz'), null);
});

test('removeMediaFile 对不存在的 id 幂等', () => {
  assert.doesNotThrow(() => removeMediaFile('missing_zz'));
});

test('removeMediaFiles 删除多个文件并忽略缺失项', () => {
  const ids = ['a_' + Math.random().toString(36).slice(2), 'b_' + Math.random().toString(36).slice(2)];
  for (const id of ids) writeMediaFile(id, Buffer.from(id));
  removeMediaFiles([...ids, 'missing_zz']);
  for (const id of ids) assert.equal(fs.existsSync(mediaPath(id)), false);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test server/test/mediaFiles.test.mjs`
Expected: FAIL，报错形如 `Cannot find module .../src/lib/mediaFiles.js`。

- [ ] **Step 4: 实现媒体文件层**

Create `server/src/lib/mediaFiles.js`:

```js
// 媒体字节的唯一落盘入口。数据库只保存元数据，文件路径由 id 推导。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { paths } from '../paths.js';

export function mediaRoot() {
  return process.env.MEDIA_DIR || paths.mediaDir;
}

export function mediaPath(id) {
  return path.join(mediaRoot(), id);
}

// 先写临时文件再 rename，避免并发读取看到半截文件。
export function writeMediaFile(id, data) {
  fs.mkdirSync(mediaRoot(), { recursive: true });
  const target = mediaPath(id);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    return data.length;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function readMediaFile(id) {
  try {
    return fs.readFileSync(mediaPath(id));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export function removeMediaFile(id) {
  try {
    fs.unlinkSync(mediaPath(id));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export function removeMediaFiles(ids = []) {
  for (const id of ids) {
    try { removeMediaFile(id); }
    catch (err) { console.warn(`[media] 删除文件失败 ${id}:`, err.message); }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test server/test/mediaFiles.test.mjs`
Expected: PASS（4 个测试）。

- [ ] **Step 6: 提交**

```bash
git add server/test/env.mjs server/test/mediaFiles.test.mjs server/src/lib/mediaFiles.js
git commit -m "feat: 抽出媒体文件层并建立 SQLite 测试环境"
```

---

### Task 2: SQLite 连接、schema 与用户/设置

**Files:**
- Modify: `server/src/paths.js`
- Create: `server/scripts/schema.sqlite.sql`
- Create: `server/src/lib/sqlite.js`
- Create: `server/src/store.sqlite.js`
- Test: `server/test/storeSqliteUsers.test.mjs`

**Interfaces:**
- Produces: `paths.sqlitePath`, `paths.mediaDir`; `openDb()`, `closeDb()`, `withRetry(fn)`, `transaction(fn)`, `parseJson(value, fallback)`, `toJson(value)`; `store.sqlite.js` exports `initStore`, `closeStore`, `ensureAdmin`, `findUserByUsername`, `findUserById`, `createUser`, `listUsers`, `updateUser`, `deleteUser`, `getActiveProviderIds`, `setActiveProvider`.

- [ ] **Step 1: 扩展 paths**

Modify `server/src/paths.js`，在 `export const paths = { ... }` 中加入两项：

```js
  sqlitePath: resolveDir(process.env.SQLITE_PATH, path.join(dataDir, 'slenk.sqlite')),
  mediaDir: resolveDir(process.env.MEDIA_DIR, path.join(dataDir, 'media'))
```

- [ ] **Step 2: 写 SQLite schema**

Create `server/scripts/schema.sqlite.sql`:

```sql
-- Slenk Notes — SQLite 建表脚本（默认后端）。
-- 与 schema.mysql.sql 保持同一套表名/列名；时间统一 UTC ISO-8601 文本。

create table if not exists slenk_notes_users (
  id text not null primary key,
  username text not null unique,
  password_hash text not null,
  is_admin integer not null default 0 check (is_admin in (0, 1)),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists slenk_notes_user_settings (
  user_id text not null primary key references slenk_notes_users(id) on delete cascade,
  active_provider_id text null,
  active_text_provider_id text null,
  active_image_provider_id text null
);

create table if not exists slenk_notes_providers (
  id text not null primary key,
  name text not null default 'Custom Provider',
  provider_type text not null default 'openai-compatible',
  app_type text not null default 'openai',
  base_url text not null default '',
  api_key text not null default '',
  mode text not null default 'image',
  text_model text not null default '',
  image_model text not null default '',
  image_api text not null default 'json',
  notes text not null default '',
  is_active integer not null default 0 check (is_active in (0, 1)),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists slenk_notes_tasks (
  id text not null primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  type text not null,
  label text null,
  status text not null default 'queued',
  payload text null,
  provider_id text null,
  tab text null,
  result text null,
  error text null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists slenk_notes_tasks_user_created_idx
  on slenk_notes_tasks (user_id, created_at desc);

create table if not exists slenk_notes_notes (
  id text not null primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  title text not null default '',
  content text not null default '',
  tags text not null default '[]',
  images text not null default '[]',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists slenk_notes_notes_user_created_idx
  on slenk_notes_notes (user_id, created_at desc);

create table if not exists slenk_notes_xhs_accounts (
  id text not null primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  credential_dir text not null unique,
  open_id text null,
  nickname text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (user_id, open_id)
);

create index if not exists slenk_notes_xhs_accounts_user_idx
  on slenk_notes_xhs_accounts (user_id, created_at desc);

create table if not exists slenk_notes_media (
  id text not null primary key,
  task_id text null references slenk_notes_tasks(id) on delete set null,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  size_bytes integer not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists slenk_notes_media_task_idx on slenk_notes_media (task_id);
create index if not exists slenk_notes_media_user_created_idx
  on slenk_notes_media (user_id, created_at desc);

create table if not exists slenk_notes_meta (
  key text not null primary key,
  value text not null
);
```

- [ ] **Step 3: 写 SQLite 辅助模块**

Create `server/src/lib/sqlite.js`:

```js
// SQLite 连接与事务辅助。node:sqlite 是同步 API，store.sqlite.js 用 async 外壳包住，
// 保持与 MySQL 适配器一致的异步契约。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../paths.js';

let connection = null;

export function resolveSqlitePath() {
  return process.env.SQLITE_PATH || paths.sqlitePath;
}

export function openDb() {
  if (connection) return connection;
  const file = resolveSqlitePath();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  connection = db;
  return db;
}

export function closeDb() {
  if (!connection) return;
  try { connection.close(); } finally { connection = null; }
}

const BUSY_RE = /SQLITE_BUSY|database is locked/i;
const busyText = err => `${err?.code || ''} ${err?.message || ''}`;

// 严重争用时重试一次（250ms 退避）；仍忙则转成 STORAGE_BUSY，由 HTTP 层映射 503。
export function withRetry(fn) {
  try {
    return fn();
  } catch (err) {
    if (!BUSY_RE.test(busyText(err))) throw err;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    try {
      return fn();
    } catch (again) {
      if (!BUSY_RE.test(busyText(again))) throw again;
      const busy = new Error('storage busy');
      busy.code = 'STORAGE_BUSY';
      throw busy;
    }
  }
}

export function transaction(fn) {
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function toJson(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
```

- [ ] **Step 4: 写失败的 store 测试**

Create `server/test/storeSqliteUsers.test.mjs`:

```js
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
```

- [ ] **Step 5: 运行测试确认失败**

Run: `node --test server/test/storeSqliteUsers.test.mjs`
Expected: FAIL，`Cannot find module .../src/store.sqlite.js`。

- [ ] **Step 6: 实现 store.sqlite.js 的连接、init 与用户/设置部分**

Create `server/src/store.sqlite.js`:

```js
// store.sqlite.js — SQLite 后端（默认）。实现与 store.mysql.js 相同的函数契约。
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, withRetry, transaction, parseJson, toJson } from './lib/sqlite.js';
import { removeMediaFiles } from './lib/mediaFiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(__dirname, '../scripts/schema.sqlite.sql');

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function all(sql, ...params) { return withRetry(() => openDb().prepare(sql).all(...params)); }
function get(sql, ...params) { return withRetry(() => openDb().prepare(sql).get(...params)); }
function run(sql, ...params) { return withRetry(() => openDb().prepare(sql).run(...params)); }

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at
  };
}

let initialized = false;

export async function initStore() {
  if (initialized) return;
  openDb().exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  await ensureAdmin();
  initialized = true;
}

export async function closeStore() {
  closeDb();
}

let adminEnsured = false;
export async function ensureAdmin() {
  if (adminEnsured) return;
  const existing = get('select id from slenk_notes_users where username = ?', 'admin');
  if (!existing) {
    run(
      `insert into slenk_notes_users (id, username, password_hash, is_admin)
       values (?, ?, ?, 1) on conflict (username) do nothing`,
      'admin', 'admin', bcrypt.hashSync('123456', 10)
    );
  }
  const row = get('select id from slenk_notes_users where username = ?', 'admin');
  run('insert into slenk_notes_user_settings (user_id) values (?) on conflict (user_id) do nothing', row.id);
  adminEnsured = true;
}

export async function findUserByUsername(username) {
  const row = get('select * from slenk_notes_users where username = ?', username);
  return row ? mapUser(row) : null;
}

export async function findUserById(id) {
  const row = get('select * from slenk_notes_users where id = ?', id);
  return row ? mapUser(row) : null;
}

export async function createUser({ username, passwordHash, isAdmin = false }) {
  const id = uid('user');
  transaction(db => {
    db.prepare('insert into slenk_notes_users (id, username, password_hash, is_admin) values (?, ?, ?, ?)')
      .run(id, String(username).trim(), String(passwordHash), isAdmin ? 1 : 0);
    db.prepare('insert into slenk_notes_user_settings (user_id) values (?) on conflict (user_id) do nothing').run(id);
  });
  return findUserById(id);
}

export async function listUsers() {
  return all(
    `select u.id, u.username, u.is_admin, u.created_at,
       (select count(*) from slenk_notes_notes n where n.user_id = u.id) as note_count,
       (select count(*) from slenk_notes_tasks t where t.user_id = u.id) as task_count
     from slenk_notes_users u order by u.created_at`
  ).map(r => ({
    id: r.id,
    username: r.username,
    isAdmin: Boolean(r.is_admin),
    createdAt: r.created_at,
    noteCount: Number(r.note_count),
    taskCount: Number(r.task_count)
  }));
}

export async function updateUser(id, patch = {}) {
  const fields = [];
  const values = [];
  if ('passwordHash' in patch) { fields.push('password_hash = ?'); values.push(patch.passwordHash); }
  if ('isAdmin' in patch) { fields.push('is_admin = ?'); values.push(patch.isAdmin ? 1 : 0); }
  if (fields.length) run(`update slenk_notes_users set ${fields.join(', ')} where id = ?`, ...values, id);
  return findUserById(id);
}

export async function deleteUser(id) {
  const mediaIds = all('select id from slenk_notes_media where user_id = ?', id).map(r => r.id);
  const info = run('delete from slenk_notes_users where id = ?', id);
  removeMediaFiles(mediaIds);
  return info.changes > 0;
}

export async function getActiveProviderIds(userId) {
  const row = get(
    `select active_provider_id, active_text_provider_id, active_image_provider_id
     from slenk_notes_user_settings where user_id = ?`,
    userId
  ) || {};
  return {
    activeProviderId: row.active_provider_id ?? null,
    activeTextProviderId: row.active_text_provider_id ?? null,
    activeImageProviderId: row.active_image_provider_id ?? null
  };
}

export async function setActiveProvider(providerId, mode, userId) {
  const column = mode === 'text' ? 'active_text_provider_id'
    : mode === 'image' ? 'active_image_provider_id'
    : 'active_provider_id';
  run(
    `insert into slenk_notes_user_settings (user_id, ${column}) values (?, ?)
     on conflict (user_id) do update set ${column} = excluded.${column}`,
    userId, providerId
  );
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --test server/test/storeSqliteUsers.test.mjs`
Expected: PASS（5 个测试）。

- [ ] **Step 8: 提交**

```bash
git add server/src/paths.js server/scripts/schema.sqlite.sql server/src/lib/sqlite.js server/src/store.sqlite.js server/test/storeSqliteUsers.test.mjs
git commit -m "feat: 增加 SQLite schema、连接层与用户存储"
```

---

### Task 3: SQLite 供应商

**Files:**
- Modify: `server/src/store.sqlite.js`
- Test: `server/test/storeSqliteProviders.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `all/get/run`、`openDb`、`transaction`、`initStore`。
- Produces: `listProviders`, `getProviderById`, `getProviderUnmaskedById`, `addProvider`, `updateProvider`, `deleteProvider`, `getActiveProvider`（均与 `store.mysql.js` 同名同返回形状）。

- [ ] **Step 1: 写失败的测试**

Create `server/test/storeSqliteProviders.test.mjs`:

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/test/storeSqliteProviders.test.mjs`
Expected: FAIL，`listProviders is not a function`（或 import 报错）。

- [ ] **Step 3: 实现供应商函数**

Append to `server/src/store.sqlite.js`（放在 `setActiveProvider` 之后）：

```js
const PROVIDER_COLUMNS = `id, name, provider_type, app_type, base_url, api_key, mode,
  text_model, image_model, image_api, notes, is_active, created_at, updated_at`;

function mapProvider(row) {
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    appType: row.app_type,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    mode: row.mode,
    textModel: row.text_model,
    imageModel: row.image_model,
    imageApi: row.image_api,
    notes: row.notes,
    active: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function maskApiKey(apiKey) {
  if (!apiKey) return '';
  const s = String(apiKey);
  if (s.length <= 8) return '*'.repeat(Math.max(4, s.length));
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

function withMaskedKey(provider) {
  return provider ? { ...provider, apiKey: maskApiKey(provider.apiKey) } : null;
}

function providerValues(input = {}, id) {
  return {
    id: id || uid('prov'),
    name: String(input.name || 'Custom Provider').trim() || 'Custom Provider',
    providerType: String(input.providerType || 'openai-compatible').trim() || 'openai-compatible',
    appType: String(input.appType || 'openai').trim() || 'openai',
    baseUrl: String(input.baseUrl || '').trim().replace(/\/$/, ''),
    apiKey: String(input.apiKey || '').trim(),
    mode: String(input.mode || 'image').trim() || 'image',
    textModel: String(input.textModel || '').trim(),
    imageModel: String(input.imageModel || '').trim(),
    imageApi: input.imageApi === 'form' ? 'form' : 'json',
    notes: String(input.notes || ''),
    active: Boolean(input.active)
  };
}

export async function listProviders() {
  return all(`select ${PROVIDER_COLUMNS} from slenk_notes_providers order by created_at, id`)
    .map(r => withMaskedKey(mapProvider(r)));
}

export async function getProviderById(id) {
  const row = get(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = ?`, id);
  return row ? withMaskedKey(mapProvider(row)) : null;
}

export async function getProviderUnmaskedById(id) {
  const row = get(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = ?`, id);
  return row ? mapProvider(row) : null;
}

export async function addProvider(input) {
  const p = providerValues(input);
  run(
    `insert into slenk_notes_providers
       (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, image_api, notes, is_active)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode,
    p.textModel, p.imageModel, p.imageApi, p.notes, p.active ? 1 : 0
  );
  return getProviderById(p.id);
}

export async function updateProvider(id, input) {
  const existing = await getProviderUnmaskedById(id);
  if (!existing) return null;
  const p = providerValues({ ...existing, ...input, id }, id);
  if (!p.apiKey || p.apiKey === maskApiKey(existing.apiKey)) p.apiKey = existing.apiKey;
  run(
    `update slenk_notes_providers set name = ?, provider_type = ?, app_type = ?, base_url = ?,
       api_key = ?, mode = ?, text_model = ?, image_model = ?, image_api = ?, notes = ?,
       is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where id = ?`,
    p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode,
    p.textModel, p.imageModel, p.imageApi, p.notes, p.active ? 1 : 0, id
  );
  return getProviderById(id);
}

export async function deleteProvider(id) {
  return transaction(db => {
    const info = db.prepare('delete from slenk_notes_providers where id = ?').run(id);
    if (info.changes) {
      db.prepare(
        `update slenk_notes_user_settings set
           active_provider_id = case when active_provider_id = ? then null else active_provider_id end,
           active_text_provider_id = case when active_text_provider_id = ? then null else active_text_provider_id end,
           active_image_provider_id = case when active_image_provider_id = ? then null else active_image_provider_id end`
      ).run(id, id, id);
    }
    return info.changes > 0;
  });
}

export async function getActiveProvider(mode, userId) {
  const settings = await getActiveProviderIds(userId);
  const preferredId = mode === 'text' ? settings.activeTextProviderId
    : mode === 'image' ? settings.activeImageProviderId
    : settings.activeProviderId;
  const row = get(
    `select ${PROVIDER_COLUMNS} from slenk_notes_providers
     order by (id = ?) desc, (mode = ?) desc, created_at, id limit 1`,
    preferredId || '', mode
  );
  return row ? mapProvider(row) : null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/test/storeSqliteProviders.test.mjs`
Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
git add server/src/store.sqlite.js server/test/storeSqliteProviders.test.mjs
git commit -m "feat: SQLite 供应商存储"
```

---

### Task 4: SQLite 任务

**Files:**
- Modify: `server/src/store.sqlite.js`
- Test: `server/test/storeSqliteTasks.test.mjs`

**Interfaces:**
- Produces: `addTask`, `listTasks`, `getTask`, `getTaskById`, `countTasksByType`, `listAllTasks`, `updateTask`, `deleteTask`, `deleteTaskById`, `deleteTasksByIds`。

- [ ] **Step 1: 写失败的测试**

Create `server/test/storeSqliteTasks.test.mjs`:

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initStore, closeStore, createUser, deleteUser,
  addTask, listTasks, getTask, getTaskById, countTasksByType,
  listAllTasks, updateTask, deleteTask, deleteTaskById, deleteTasksByIds
} from '../src/store.sqlite.js';

after(async () => { await closeStore(); });

test('addTask/listTasks 保留 payload/result 的 JSON 结构', async () => {
  await initStore();
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'task_' + Math.random().toString(36).slice(2);
  await addTask({ id, userId: user.id, type: 'image', label: 'AI生图1', status: 'queued', payload: { prompt: 'x', noteId: 'n1' } });
  const list = await listTasks(user.id);
  assert.equal(list[0].id, id);
  assert.deepEqual(list[0].payload, { prompt: 'x', noteId: 'n1' });
  await updateTask(user.id, id, { status: 'done', result: { images: ['/api/media/a'] } });
  const detail = await getTask(user.id, id);
  assert.equal(detail.status, 'done');
  assert.deepEqual(detail.result, { images: ['/api/media/a'] });
  await deleteTask(user.id, id);
  await deleteUser(user.id);
});

test('countTasksByType 对 image 类型按 tab 区分', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  await addTask({ id: 't1_' + user.id, userId: user.id, type: 'image', tab: 'replace' });
  await addTask({ id: 't2_' + user.id, userId: user.id, type: 'image', tab: 'generate' });
  await addTask({ id: 't3_' + user.id, userId: user.id, type: 'video' });
  assert.equal(await countTasksByType(user.id, 'image', 'replace'), 1);
  assert.equal(await countTasksByType(user.id, 'image', 'generate'), 1);
  assert.equal(await countTasksByType(user.id, 'video', null), 1);
  await deleteUser(user.id);
});

test('listAllTasks 全站共享并带用户名与 note 字段', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  await addTask({ id: 't_' + user.id, userId: user.id, type: 'rewrite', label: 'Text1', payload: { noteId: 'n9', noteTitle: '标题', purpose: 'title' } });
  const all = await listAllTasks(50);
  const row = all.find(t => t.id === 't_' + user.id);
  assert.equal(row.username, user.username);
  assert.equal(row.noteId, 'n9');
  assert.equal(row.noteTitle, '标题');
  assert.equal(row.label, '标题生成1');
  await deleteUser(user.id);
});

test('updateTask 在行不存在且给了 insertMeta 时补插', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'late_' + user.id;
  const saved = await updateTask(user.id, id, { status: 'done' }, {
    type: 'video', label: '实况视频1', payload: { images: [] }, providerId: 'prov_x', tab: 'video'
  });
  assert.equal(saved.id, id);
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.payload, { images: [] });
  assert.equal((await getTaskById(id)).status, 'done');
  await deleteUser(user.id);
});

test('删除接口按用户隔离，管理员批量删除可跨用户', async () => {
  const a = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const b = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  await addTask({ id: 'a1_' + a.id, userId: a.id, type: 'image' });
  await addTask({ id: 'b1_' + b.id, userId: b.id, type: 'image' });
  assert.equal(await deleteTask(b.id, 'a1_' + a.id), false);
  assert.equal(await deleteTaskById('a1_' + a.id), true);
  assert.equal(await deleteTasksByIds(['b1_' + b.id], b.id, false), 1);
  await deleteUser(a.id);
  await deleteUser(b.id);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/test/storeSqliteTasks.test.mjs`
Expected: FAIL，`addTask is not a function`。

- [ ] **Step 3: 实现任务函数**

Append to `server/src/store.sqlite.js`（放在供应商函数之后）：

```js
function typeLabel(type) {
  if (type === 'image') return 'AI生图';
  if (type === 'video') return '实况视频';
  if (type === 'rewrite') return '文案改写';
  if (type === 'publish') return '小红书发布';
  return String(type || '任务');
}

function taskName(type, payload) {
  const purpose = payload && payload.purpose;
  if (purpose === 'title') return '标题生成';
  if (purpose === 'content') return '正文生成';
  if (purpose === 'tags') return '话题标签生成';
  if (purpose === 'noteImage') return '配图生成';
  return typeLabel(type);
}

function displayTaskLabel(row) {
  const label = row.label || '';
  if (!/^(Text|Image|Video|Task)\d+$/i.test(label)) return label;
  const suffix = String(label).replace(/^[^\d]+/i, '');
  return `${taskName(row.type, row.payload)}${suffix || ''}`;
}

function mapTask(row) {
  const payload = parseJson(row.payload, null);
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username || null,
    type: row.type,
    label: displayTaskLabel({ ...row, payload }),
    status: row.status,
    payload,
    providerId: row.provider_id,
    tab: row.tab,
    result: parseJson(row.result, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTaskListRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username || null,
    type: row.type,
    label: displayTaskLabel({ ...row, payload: { purpose: row.purpose } }),
    status: row.status,
    tab: row.tab,
    providerId: row.provider_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
    noteId: row.note_id || null,
    noteTitle: row.note_title || null
  };
}

export async function addTask(task) {
  run(
    `insert into slenk_notes_tasks (id, user_id, type, label, status, payload, provider_id, tab, result, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id, task.userId, task.type, task.label ?? null, task.status ?? 'queued',
    toJson(task.payload), task.providerId ?? null, task.tab ?? null,
    toJson(task.result), task.error ?? null
  );
  return getTaskById(task.id);
}

export async function listTasks(userId, limit = 100) {
  return all(
    'select * from slenk_notes_tasks where user_id = ? order by created_at desc limit ?',
    userId, limit
  ).map(mapTask);
}

export async function getTask(userId, id) {
  const row = get('select * from slenk_notes_tasks where user_id = ? and id = ?', userId, id);
  return row ? mapTask(row) : null;
}

export async function countTasksByType(userId, type, tab) {
  const row = get(
    `select count(*) as n from slenk_notes_tasks
     where user_id = ? and type = ?
       and (? <> 'image' or coalesce(tab, '') = coalesce(?, ''))`,
    userId, type, type, tab ?? null
  );
  return Number(row?.n ?? 0);
}

export async function listAllTasks(limit = 200) {
  return all(
    `select t.id, t.user_id, u.username, t.type, t.label, t.status, t.tab,
            t.provider_id, t.created_at, t.updated_at, t.error, t.payload
     from slenk_notes_tasks t
     left join slenk_notes_users u on u.id = t.user_id
     order by t.created_at desc limit ?`,
    limit
  ).map(row => {
    const payload = parseJson(row.payload, {}) || {};
    return mapTaskListRow({
      ...row,
      purpose: payload.purpose,
      note_id: payload.noteId ?? null,
      note_title: payload.noteTitle ?? null
    });
  });
}

export async function getTaskById(id) {
  const row = get(
    `select t.*, u.username from slenk_notes_tasks t
     left join slenk_notes_users u on u.id = t.user_id
     where t.id = ?`,
    id
  );
  return row ? mapTask(row) : null;
}

export async function deleteTask(userId, id) {
  return run('delete from slenk_notes_tasks where user_id = ? and id = ?', userId, id).changes > 0;
}

export async function deleteTaskById(id) {
  return run('delete from slenk_notes_tasks where id = ?', id).changes > 0;
}

export async function deleteTasksByIds(ids, userId, isAdmin) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  if (isAdmin) {
    return run(`delete from slenk_notes_tasks where id in (${placeholders})`, ...ids).changes;
  }
  return run(
    `delete from slenk_notes_tasks where id in (${placeholders}) and user_id = ?`,
    ...ids, userId
  ).changes;
}

export async function updateTask(userId, id, patch, insertMeta) {
  const fields = [];
  const values = [];
  if ('status' in patch) { fields.push('status = ?'); values.push(patch.status); }
  if ('result' in patch) { fields.push('result = ?'); values.push(toJson(patch.result)); }
  if ('error' in patch) { fields.push('error = ?'); values.push(patch.error); }
  if ('label' in patch) { fields.push('label = ?'); values.push(patch.label); }
  if (!fields.length) return getTask(userId, id);
  const changed = run(
    `update slenk_notes_tasks set ${fields.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where id = ? and user_id = ?`,
    ...values, id, userId
  ).changes;
  // 迁移前入队、但库里没有对应行的旧任务：UPDATE 命中 0 行，状态会被静默丢弃。
  // worker 处理这类任务时带上 insertMeta（type/payload/providerId/tab/label，取自 job），
  // 命中 0 行就补插一行，让任务结果在 UI 任务列表可见，而不是无声消失。
  if (changed === 0 && insertMeta) {
    const cols = ['id', 'user_id', 'type', 'status', 'label'];
    const vals = [id, userId, insertMeta.type ?? 'task', patch.status ?? 'queued', patch.label ?? insertMeta.label ?? null];
    if (insertMeta.payload !== undefined) { cols.push('payload'); vals.push(toJson(insertMeta.payload)); }
    if (insertMeta.providerId !== undefined) { cols.push('provider_id'); vals.push(insertMeta.providerId); }
    if (insertMeta.tab !== undefined) { cols.push('tab'); vals.push(insertMeta.tab); }
    if ('result' in patch) { cols.push('result'); vals.push(toJson(patch.result)); }
    if ('error' in patch) { cols.push('error'); vals.push(patch.error); }
    // 重复键分支同样应用 patch（行恰好存在但值未变的极端情况）。
    const dupeCols = cols.slice(4);
    run(
      `insert into slenk_notes_tasks (${cols.join(', ')})
       values (${cols.map(() => '?').join(', ')})
       on conflict (id) do update set ${dupeCols.map(c => `${c} = excluded.${c}`).join(', ')},
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ...vals
    );
  }
  return getTask(userId, id);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/test/storeSqliteTasks.test.mjs`
Expected: PASS（5 个测试）。

- [ ] **Step 5: 提交**

```bash
git add server/src/store.sqlite.js server/test/storeSqliteTasks.test.mjs
git commit -m "feat: SQLite 任务存储"
```

---

### Task 5: SQLite 笔记、XHS 账号、媒体与巡检

**Files:**
- Modify: `server/src/store.sqlite.js`
- Test: `server/test/storeSqliteMedia.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `all/get/run`、`openDb`；Task 1 的 `writeMediaFile`、`readMediaFile`、`removeMediaFiles`。
- Produces: `saveNote`, `getNote`, `listXhsAccounts`, `getXhsAccount`, `createXhsAccountPending`, `bindXhsAccountOpenId`, `findXhsAccountByOpenId`, `deleteXhsAccount`, `updateXhsAccountNickname`, `listAllXhsAccounts`, `insertMedia`, `getMedia`, `getAllNotesImagesForJanitor`, `getAllTasksPayloadForJanitor`, `listMediaIds`。

- [ ] **Step 1: 写失败的测试**

Create `server/test/storeSqliteMedia.test.mjs`:

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  initStore, closeStore, createUser, deleteUser, deleteProvider,
  saveNote, getNote, insertMedia, getMedia, listMediaIds,
  getAllNotesImagesForJanitor, getAllTasksPayloadForJanitor,
  createXhsAccountPending, bindXhsAccountOpenId, findXhsAccountByOpenId,
  updateXhsAccountNickname, listXhsAccounts, getXhsAccount, deleteXhsAccount
} from '../src/store.sqlite.js';
import { mediaPath } from '../src/lib/mediaFiles.js';

after(async () => { await closeStore(); });

test('saveNote/getNote 保留 tags/images 数组', async () => {
  await initStore();
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const note = await saveNote(user.id, { title: '标题', tags: ['旅行'], images: ['/api/media/a'] });
  const loaded = await getNote(note.id);
  assert.equal(loaded.title, '标题');
  assert.deepEqual(loaded.tags, ['旅行']);
  assert.deepEqual(loaded.images, ['/api/media/a']);
  await deleteUser(user.id);
});

test('insertMedia 写文件并读回字节，listMediaIds 返回全部', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'media_' + Math.random().toString(36).slice(2);
  const data = Buffer.from([1, 2, 3, 4, 5]);
  await insertMedia({ id, userId: user.id, filename: 'a.png', mimeType: 'image/png', data });
  assert.deepEqual((await getMedia(id)).data, data);
  assert.ok(fs.existsSync(mediaPath(id)));
  assert.ok((await listMediaIds()).includes(id));
  assert.equal((await getAllNotesImagesForJanitor()).length >= 0, true);
  assert.equal((await getAllTasksPayloadForJanitor()).length >= 0, true);
  await deleteUser(user.id);
});

test('XHS 账号完整生命周期与重复绑定错误', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'xhs_' + Math.random().toString(36).slice(2);
  const pending = await createXhsAccountPending(user.id, { id, credentialDir: 'cred_a' });
  assert.equal(pending.openId, null);
  await bindXhsAccountOpenId(user.id, id, { openId: 'o1', nickname: '阿明' });
  const byOpen = await findXhsAccountByOpenId(user.id, 'o1');
  assert.equal(byOpen.id, id);
  await updateXhsAccountNickname(user.id, id, '小明');
  assert.equal((await getXhsAccount(user.id, id)).nickname, '小明');
  assert.equal((await listXhsAccounts(user.id)).length, 1);
  // 第二个账号绑定同一 openId 触发 unique(user_id, open_id)。
  const second = 'xhs_' + Math.random().toString(36).slice(2);
  await createXhsAccountPending(user.id, { id: second, credentialDir: 'cred_b' });
  await assert.rejects(
    () => bindXhsAccountOpenId(user.id, second, { openId: 'o1' }),
    (e) => e.code === 'XHS_ACCOUNT_DUPLICATE'
  );
  await deleteXhsAccount(user.id, second);
  const removed = await deleteXhsAccount(user.id, id);
  assert.equal(removed.credentialDir, 'cred_a');
  assert.equal(await getXhsAccount(user.id, id), null);
  await deleteUser(user.id);
});

test('deleteUser 删除该用户全部媒体文件', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'media_' + Math.random().toString(36).slice(2);
  await insertMedia({ id, userId: user.id, filename: 'a.png', mimeType: 'image/png', data: Buffer.from('x') });
  assert.ok(fs.existsSync(mediaPath(id)));
  await deleteUser(user.id);
  assert.equal(fs.existsSync(mediaPath(id)), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/test/storeSqliteMedia.test.mjs`
Expected: FAIL，`saveNote is not a function`。

- [ ] **Step 3: 实现笔记、XHS、媒体与巡检函数**

替换 `server/src/store.sqlite.js` 顶部的媒体导入行：

```js
import { writeMediaFile, readMediaFile, removeMediaFile, removeMediaFiles } from './lib/mediaFiles.js';
```

在 `all/get/run` 辅助之后追加 `isDuplicateError`：

```js
function isDuplicateError(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message));
}
```

在 `setActiveProvider` 之后追加以下代码块：

```js
// ---- 笔记 ----

function mapNote(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    tags: parseJson(row.tags, []),
    images: parseJson(row.images, []),
    createdAt: row.created_at
  };
}

export async function saveNote(userId, note = {}) {
  const id = uid('note');
  run(
    'insert into slenk_notes_notes (id, user_id, title, content, tags, images) values (?, ?, ?, ?, ?, ?)',
    id, userId,
    String(note.title || ''), String(note.content || ''),
    toJson(Array.isArray(note.tags) ? note.tags : []),
    toJson(Array.isArray(note.images) ? note.images : [])
  );
  return getNote(id);
}

// 公开读取：/p/<id> 分享页依赖它，id 是随机串不可枚举。
export async function getNote(id) {
  const row = get('select * from slenk_notes_notes where id = ?', id);
  return row ? mapNote(row) : null;
}

// ---- XHS 账号（user_id 强制隔离） ----

function mapXhsAccount(row) {
  return {
    id: row.id,
    userId: row.user_id,
    credentialDir: row.credential_dir,
    openId: row.open_id,
    nickname: row.nickname,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listXhsAccounts(userId) {
  return all('select * from slenk_notes_xhs_accounts where user_id = ? order by created_at desc', userId)
    .map(mapXhsAccount);
}

export async function getXhsAccount(userId, id) {
  const row = get('select * from slenk_notes_xhs_accounts where user_id = ? and id = ?', userId, id);
  return row ? mapXhsAccount(row) : null;
}

export async function createXhsAccountPending(userId, { id, credentialDir }) {
  run('insert into slenk_notes_xhs_accounts (id, user_id, credential_dir) values (?, ?, ?)', id, userId, credentialDir);
  return getXhsAccount(userId, id);
}

// 扫码成功回填 open_id；unique(user_id, open_id) 冲突映射为 XHS_ACCOUNT_DUPLICATE。
export async function bindXhsAccountOpenId(userId, id, { openId, nickname } = {}) {
  try {
    run(
      `update slenk_notes_xhs_accounts set open_id = ?, nickname = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       where user_id = ? and id = ?`,
      openId ?? null, nickname ?? '', userId, id
    );
    return getXhsAccount(userId, id);
  } catch (error) {
    if (isDuplicateError(error)) {
      const mapped = new Error('XHS 账号已绑定');
      mapped.code = 'XHS_ACCOUNT_DUPLICATE';
      throw mapped;
    }
    throw error;
  }
}

export async function findXhsAccountByOpenId(userId, openId) {
  const row = get('select * from slenk_notes_xhs_accounts where user_id = ? and open_id = ?', userId, openId);
  return row ? mapXhsAccount(row) : null;
}

// 返回被删行（含 credential_dir）供上层清理磁盘凭证目录；不存在或跨用户返回 null。
export async function deleteXhsAccount(userId, id) {
  const row = get('select * from slenk_notes_xhs_accounts where user_id = ? and id = ?', userId, id);
  if (!row) return null;
  run('delete from slenk_notes_xhs_accounts where user_id = ? and id = ?', userId, id);
  return mapXhsAccount(row);
}

export async function updateXhsAccountNickname(userId, id, nickname) {
  run(
    `update slenk_notes_xhs_accounts set nickname = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where user_id = ? and id = ?`,
    nickname, userId, id
  );
  return getXhsAccount(userId, id);
}

// 管理员只读：按 user 分组返回 [{ userId, accounts }]。
export async function listAllXhsAccounts() {
  const rows = all('select * from slenk_notes_xhs_accounts order by user_id, created_at desc');
  const groups = [];
  const byUser = new Map();
  for (const row of rows) {
    const account = mapXhsAccount(row);
    if (!byUser.has(row.user_id)) {
      const group = { userId: row.user_id, accounts: [] };
      byUser.set(row.user_id, group);
      groups.push(group);
    }
    byUser.get(row.user_id).accounts.push(account);
  }
  return groups;
}

// ---- 媒体（数据库存元数据，字节在 <mediaDir>/<id>） ----

export async function insertMedia({ id, taskId, userId, filename, mimeType, data }) {
  writeMediaFile(id, data);
  try {
    run(
      'insert into slenk_notes_media (id, task_id, user_id, filename, mime_type, size_bytes) values (?, ?, ?, ?, ?, ?)',
      id, taskId ?? null, userId, filename, mimeType, data.length
    );
  } catch (err) {
    // 插行失败（FK / 唯一冲突）时删除已写的文件，不留孤儿。
    removeMediaFile(id);
    throw err;
  }
  return id;
}

export async function getMedia(id) {
  const row = get('select id, task_id, user_id, filename, mime_type, size_bytes from slenk_notes_media where id = ?', id);
  if (!row) return null;
  const data = readMediaFile(id);
  if (data == null) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    filename: row.filename,
    mimeType: row.mime_type,
    data,
    sizeBytes: Number(row.size_bytes)
  };
}

// cacheJanitor 用：全量笔记 images 与任务 payload（供孤儿缓存清理引用扫描）。
export async function getAllNotesImagesForJanitor() {
  return all('select images from slenk_notes_notes').map(r => parseJson(r.images, []));
}

export async function getAllTasksPayloadForJanitor() {
  return all('select payload from slenk_notes_tasks').map(r => parseJson(r.payload, null));
}

// 巡检脚本用：全量媒体 id，供与文件目录对比。
export async function listMediaIds() {
  return all('select id from slenk_notes_media').map(r => r.id);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/test/storeSqliteMedia.test.mjs`
Expected: PASS（4 个测试）。

- [ ] **Step 5: 提交**

```bash
git add server/src/store.sqlite.js server/test/storeSqliteMedia.test.mjs
git commit -m "feat: SQLite 笔记、XHS 账号与文件媒体存储"
```

---

### Task 6: 本地 JSON 一次性迁移与同步行导入导出

**Files:**
- Modify: `server/src/store.sqlite.js`
- Modify: `server/src/store.mysql.js`
- Test: `server/test/storeSqliteImport.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `openDb`、`transaction`、`run/get`；`paths.dataDir`。
- Produces: `importLocalOnce()`（initStore 内调用）、`exportSyncRows()`、`importSyncRows(rows)`。

**语义:** 只迁移 `users` / `providers` / `user_settings` 三个 JSON 表；以 meta 表 `local_import_v1` 为一次性标记；失败即回滚且不写标记（下次启动重试）。

- [ ] **Step 1: 写失败的测试**

Create `server/test/storeSqliteImport.test.mjs`:

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/test/storeSqliteImport.test.mjs`
Expected: FAIL，`exportSyncRows is not a function`。

- [ ] **Step 3: 实现导入与同步行函数**

在 `server/src/store.sqlite.js` 顶部 import 区追加：

```js
import { paths } from './paths.js';
```

在 `uid` 辅助后追加时间转换与读取辅助：

```js
// 旧 JSON 时间格式 YYYY-MM-DD HH:MM:SS.mmm → ISO-8601 UTC。
function isoFromLegacy(s) {
  if (!s) return null;
  if (typeof s !== 'string') return null;
  if (/Z$/.test(s) || s.includes('T')) return s;
  return s.replace(' ', 'T') + 'Z';
}
```

修改 `initStore`（Task 2 版本），在 `ensureAdmin()` 之前插入 `await importLocalOnce()`：

```js
export async function initStore() {
  if (initialized) return;
  openDb().exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  await importLocalOnce();
  await ensureAdmin();
  initialized = true;
}
```

在 `closeStore` 之后追加导入与同步行函数：

```js
// ---- 本地 JSON 一次性迁移 ----
// 仅迁移 users / providers / user_settings；media、notes、tasks、xhs_accounts 不迁移。
// 失败即 ROLLBACK 且不写 local_import_v1，下次启动重试。
export async function importLocalOnce() {
  const done = get('select value from slenk_notes_meta where key = ?', 'local_import_v1');
  if (done) return;
  const localDir = path.join(paths.dataDir, 'local');
  const readJson = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(localDir, name), 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  };
  const users = readJson('users.json');
  const providers = readJson('providers.json');
  const settings = readJson('user_settings.json');
  if (!users.length && !providers.length && !settings.length) {
    run('insert into slenk_notes_meta (key, value) values (?, ?) on conflict (key) do nothing', 'local_import_v1', 'done');
    return;
  }
  transaction(db => {
    for (const u of users) {
      db.prepare(
        `insert into slenk_notes_users (id, username, password_hash, is_admin, created_at)
         values (?, ?, ?, ?, ?) on conflict (id) do nothing`
      ).run(u.id, String(u.username || ''), String(u.password_hash || ''), u.is_admin ? 1 : 0, isoFromLegacy(u.created_at));
    }
    for (const p of providers) {
      db.prepare(
        `insert into slenk_notes_providers
           (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, image_api, notes, is_active, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do nothing`
      ).run(p.id, String(p.name || 'Custom Provider'), String(p.provider_type || 'openai-compatible'), String(p.app_type || 'openai'),
        String(p.base_url || '').replace(/\/$/, ''), String(p.api_key || ''), String(p.mode || 'image'),
        String(p.text_model || ''), String(p.image_model || ''), p.image_api === 'form' ? 'form' : 'json',
        String(p.notes || ''), p.is_active ? 1 : 0, isoFromLegacy(p.created_at), isoFromLegacy(p.updated_at));
    }
    for (const s of settings) {
      db.prepare(
        `insert into slenk_notes_user_settings (user_id, active_provider_id, active_text_provider_id, active_image_provider_id)
         values (?, ?, ?, ?) on conflict (user_id) do update set
           active_provider_id = coalesce(excluded.active_provider_id, slenk_notes_user_settings.active_provider_id),
           active_text_provider_id = coalesce(excluded.active_text_provider_id, slenk_notes_user_settings.active_text_provider_id),
           active_image_provider_id = coalesce(excluded.active_image_provider_id, slenk_notes_user_settings.active_image_provider_id)`
      ).run(s.user_id, s.active_provider_id ?? null, s.active_text_provider_id ?? null, s.active_image_provider_id ?? null);
    }
    db.prepare('insert into slenk_notes_meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value')
      .run('local_import_v1', 'done');
  });
}

// ---- TiDB 同步行 ----
// 返回 JSON 兼容行：snake_case + 布尔 is_admin/is_active + 原始时间文本。
// 与 importSyncRows 成对，用于跨后端备份/恢复与 TiDB Cloud 同步。

export async function exportSyncRows() {
  return {
    users: all('select * from slenk_notes_users').map(r => ({
      id: r.id, username: r.username, password_hash: r.password_hash,
      is_admin: Boolean(r.is_admin), created_at: r.created_at
    })),
    providers: all('select * from slenk_notes_providers').map(r => ({
      id: r.id, name: r.name, provider_type: r.provider_type, app_type: r.app_type,
      base_url: r.base_url, api_key: r.api_key, mode: r.mode,
      text_model: r.text_model, image_model: r.image_model, image_api: r.image_api,
      notes: r.notes, is_active: Boolean(r.is_active),
      created_at: r.created_at, updated_at: r.updated_at
    })),
    userSettings: all('select * from slenk_notes_user_settings').map(r => ({
      user_id: r.user_id, active_provider_id: r.active_provider_id,
      active_text_provider_id: r.active_text_provider_id,
      active_image_provider_id: r.active_image_provider_id
    }))
  };
}

// 幂等合并导入：用户/供应商按 id upsert，设置按 user_id upsert。
export async function importSyncRows(rows = {}) {
  transaction(db => {
    for (const u of rows.users || []) {
      db.prepare(
        `insert into slenk_notes_users (id, username, password_hash, is_admin, created_at)
         values (?, ?, ?, ?, ?) on conflict (id) do update set
           username = excluded.username, password_hash = excluded.password_hash,
           is_admin = excluded.is_admin`
      ).run(u.id, String(u.username || ''), String(u.password_hash || ''), u.is_admin ? 1 : 0, isoFromLegacy(u.created_at));
    }
    for (const p of rows.providers || []) {
      db.prepare(
        `insert into slenk_notes_providers
           (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, image_api, notes, is_active, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set name = excluded.name, provider_type = excluded.provider_type,
           app_type = excluded.app_type, base_url = excluded.base_url, api_key = excluded.api_key,
           mode = excluded.mode, text_model = excluded.text_model, image_model = excluded.image_model,
           image_api = excluded.image_api, notes = excluded.notes, is_active = excluded.is_active,
           updated_at = excluded.updated_at`
      ).run(p.id, String(p.name || 'Custom Provider'), String(p.provider_type || 'openai-compatible'), String(p.app_type || 'openai'),
        String(p.base_url || '').replace(/\/$/, ''), String(p.api_key || ''), String(p.mode || 'image'),
        String(p.text_model || ''), String(p.image_model || ''), p.image_api === 'form' ? 'form' : 'json',
        String(p.notes || ''), p.is_active ? 1 : 0, isoFromLegacy(p.created_at), isoFromLegacy(p.updated_at));
    }
    for (const s of rows.userSettings || []) {
      db.prepare(
        `insert into slenk_notes_user_settings (user_id, active_provider_id, active_text_provider_id, active_image_provider_id)
         values (?, ?, ?, ?) on conflict (user_id) do update set
           active_provider_id = excluded.active_provider_id,
           active_text_provider_id = excluded.active_text_provider_id,
           active_image_provider_id = excluded.active_image_provider_id`
      ).run(s.user_id, s.active_provider_id ?? null, s.active_text_provider_id ?? null, s.active_image_provider_id ?? null);
    }
  });
}
```

- [ ] **Step 4: 实现 MySQL 同步行函数**

把顶部 import 改为 `import { query, withTransaction } from './db.js';`（事务用 withTransaction），
并在 `server/src/store.mysql.js` 的 export 块之前追加（并把 `exportSyncRows`/`importSyncRows` 加进 export 块）：

```js
// ---- TiDB 同步行（与 SQLite 适配器形状一致） ----

async function exportSyncRows() {
  // db.js 的 query() 返回 { rows, rowCount, fields }（对象），不能用数组解构。
  const { rows: users } = await query('select * from slenk_notes_users');
  const { rows: providers } = await query('select * from slenk_notes_providers');
  const { rows: userSettings } = await query('select * from slenk_notes_user_settings');
  return {
    users: users.map(r => ({
      id: r.id, username: r.username, password_hash: r.password_hash,
      is_admin: Boolean(r.is_admin), created_at: r.created_at
    })),
    providers: providers.map(r => ({
      id: r.id, name: r.name, provider_type: r.provider_type, app_type: r.app_type,
      base_url: r.base_url, api_key: r.api_key, mode: r.mode,
      text_model: r.text_model, image_model: r.image_model, image_api: r.image_api,
      notes: r.notes, is_active: Boolean(r.is_active),
      created_at: r.created_at, updated_at: r.updated_at
    })),
    userSettings: userSettings.map(r => ({
      user_id: r.user_id, active_provider_id: r.active_provider_id,
      active_text_provider_id: r.active_text_provider_id,
      active_image_provider_id: r.active_image_provider_id
    }))
  };
}

async function importSyncRows(rows = {}) {
  // store.mysql.js 只有 query 导入；事务用 db.js 的 withTransaction（begin/commit/rollback/release）。
  return withTransaction(async (conn) => {
    for (const u of rows.users || []) {
      await conn.query(
        `insert into slenk_notes_users (id, username, password_hash, is_admin, created_at)
         values (?, ?, ?, ?, ?) on duplicate key update
           username = values(username), password_hash = values(password_hash), is_admin = values(is_admin)`,
        [u.id, String(u.username || ''), String(u.password_hash || ''), u.is_admin ? 1 : 0, u.created_at ?? null]
      );
    }
    for (const p of rows.providers || []) {
      await conn.query(
        `insert into slenk_notes_providers
           (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, image_api, notes, is_active, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on duplicate key update name = values(name), provider_type = values(provider_type),
           app_type = values(app_type), base_url = values(base_url), api_key = values(api_key),
           mode = values(mode), text_model = values(text_model), image_model = values(image_model),
           image_api = values(image_api), notes = values(notes), is_active = values(is_active),
           updated_at = values(updated_at)`,
        [p.id, String(p.name || 'Custom Provider'), String(p.provider_type || 'openai-compatible'), String(p.app_type || 'openai'),
          String(p.base_url || '').replace(/\/$/, ''), String(p.api_key || ''), String(p.mode || 'image'),
          String(p.text_model || ''), String(p.image_model || ''), p.image_api === 'form' ? 'form' : 'json',
          String(p.notes || ''), p.is_active ? 1 : 0, p.created_at ?? null, p.updated_at ?? null]
      );
    }
    for (const s of rows.userSettings || []) {
      await conn.query(
        `insert into slenk_notes_user_settings (user_id, active_provider_id, active_text_provider_id, active_image_provider_id)
         values (?, ?, ?, ?) on duplicate key update
           active_provider_id = values(active_provider_id),
           active_text_provider_id = values(active_text_provider_id),
           active_image_provider_id = values(active_image_provider_id)`,
        [s.user_id, s.active_provider_id ?? null, s.active_text_provider_id ?? null, s.active_image_provider_id ?? null]
      );
    }
  });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test server/test/storeSqliteImport.test.mjs`
Expected: PASS（3 个测试）。

- [ ] **Step 6: 提交**

```bash
git add server/src/store.sqlite.js server/src/store.mysql.js server/test/storeSqliteImport.test.mjs
git commit -m "feat: 本地 JSON 一次性迁移与同步行导入导出"
```

---

### Task 7: store 分派、MySQL 契约补齐与启动初始化

**Files:**
- Modify: `server/src/store.js`
- Modify: `server/src/store.mysql.js`
- Modify: `server/src/index.js`
- Modify: `server/src/worker.js`
- Test: `server/test/storeDispatch.test.mjs`

**Interfaces:**
- Produces: `store.js` 导出完整的 39+5 函数契约，`initStore` 对所有调用方可用。
- 新增行为：非法 `SLENK_DATA_BACKEND` 启动即抛错；`STORAGE_BUSY` 错误映射 HTTP 503。

- [ ] **Step 1: 写失败的测试**

Create `server/test/storeDispatch.test.mjs`:

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/test/storeDispatch.test.mjs`
Expected: FAIL，`initStore is not a function`（store.js 还没导出）。

- [ ] **Step 3: 重写 store.js 为分派器**

Create（覆盖）`server/src/store.js`：

```js
// store.js — 数据层入口：按 SLENK_DATA_BACKEND 选择后端，导出接口一致。
//
//   sqlite（默认，未设置时）→ store.sqlite.js：Node 内置 SQLite，默认 <dataDir>/slenk.sqlite
//   mysql                  → store.mysql.js：业务数据存 MySQL
//
// routes / worker / auth / lib 等一律 `import { ... } from './store.js'`，切换后端零改动。
// 非法后端值启动即抛错，避免静默落到错误数据源。
import './loadEnv.js';
import * as sqliteImpl from './store.sqlite.js';
import * as mysqlImpl from './store.mysql.js';

const backend = process.env.SLENK_DATA_BACKEND || 'sqlite';
let impl;
if (backend === 'sqlite') impl = sqliteImpl;
else if (backend === 'mysql') impl = mysqlImpl;
else throw new Error(`未知 SLENK_DATA_BACKEND: ${backend}（仅支持 sqlite / mysql）`);

export const initStore = impl.initStore;
export const closeStore = impl.closeStore;

export const ensureAdmin = impl.ensureAdmin;
export const findUserByUsername = impl.findUserByUsername;
export const findUserById = impl.findUserById;
export const createUser = impl.createUser;
export const listUsers = impl.listUsers;
export const updateUser = impl.updateUser;
export const deleteUser = impl.deleteUser;

export const addTask = impl.addTask;
export const listTasks = impl.listTasks;
export const countTasksByType = impl.countTasksByType;
export const listAllTasks = impl.listAllTasks;
export const getTask = impl.getTask;
export const getTaskById = impl.getTaskById;
export const updateTask = impl.updateTask;
export const deleteTask = impl.deleteTask;
export const deleteTaskById = impl.deleteTaskById;
export const deleteTasksByIds = impl.deleteTasksByIds;

export const listProviders = impl.listProviders;
export const getProviderById = impl.getProviderById;
export const getProviderUnmaskedById = impl.getProviderUnmaskedById;
export const getActiveProvider = impl.getActiveProvider;
export const addProvider = impl.addProvider;
export const updateProvider = impl.updateProvider;
export const deleteProvider = impl.deleteProvider;
export const setActiveProvider = impl.setActiveProvider;
export const getActiveProviderIds = impl.getActiveProviderIds;

export const saveNote = impl.saveNote;
export const getNote = impl.getNote;

export const insertMedia = impl.insertMedia;
export const getMedia = impl.getMedia;
export const listMediaIds = impl.listMediaIds;

export const listXhsAccounts = impl.listXhsAccounts;
export const getXhsAccount = impl.getXhsAccount;
export const createXhsAccountPending = impl.createXhsAccountPending;
export const bindXhsAccountOpenId = impl.bindXhsAccountOpenId;
export const findXhsAccountByOpenId = impl.findXhsAccountByOpenId;
export const deleteXhsAccount = impl.deleteXhsAccount;
export const updateXhsAccountNickname = impl.updateXhsAccountNickname;
export const listAllXhsAccounts = impl.listAllXhsAccounts;

export const getAllNotesImagesForJanitor = impl.getAllNotesImagesForJanitor;
export const getAllTasksPayloadForJanitor = impl.getAllTasksPayloadForJanitor;

export const exportSyncRows = impl.exportSyncRows;
export const importSyncRows = impl.importSyncRows;
```

- [ ] **Step 4: 补齐 MySQL 契约函数**

修改 `server/src/store.mysql.js`：

1) 顶部 import 改为：

```js
import { query, closePool } from './db.js';
```

2) 在 export 块之前追加：

```js
async function initStore() {
  await ensureAdmin();
}

async function closeStore() {
  await closePool();
}

async function listMediaIds() {
  const { rows } = await query('select id from slenk_notes_media');
  return rows.map(r => r.id);
}
```

3) 在 export 块内加入 `initStore, closeStore, exportSyncRows, importSyncRows, listMediaIds`（放在 `ensureAdmin,` 之前）。

- [ ] **Step 5: 接入启动初始化与 busy 映射**

修改 `server/src/index.js`：

1) 第 8 行：

```js
import { initStore } from './store.js';
```

2) 第 25 行：

```js
await initStore();
```

3) 错误中间件改为：

```js
app.use((err, req, res, next) => {
  console.error(err);
  if (err?.code === 'STORAGE_BUSY') return res.status(503).json({ error: 'storage_busy' });
  res.status(500).json({ error: err.message || 'server_error' });
});
```

修改 `server/src/worker.js`：

1) 第 11 行 import 追加 `initStore`：

```js
import { initStore, updateTask, getProviderUnmaskedById, getActiveProvider, getMedia } from './store.js';
```

2) 在第一个 `new Worker('ai-tasks', ...)` 之前加一行：

```js
await initStore();
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test server/test/storeDispatch.test.mjs`
Expected: PASS（2 个测试）。

- [ ] **Step 7: 提交**

```bash
git add server/src/store.js server/src/store.mysql.js server/src/index.js server/src/worker.js server/test/storeDispatch.test.mjs
git commit -m "feat: store 分派器与启动初始化（sqlite 默认，非法后端抛错）"
```

---

### Task 8: 测试环境迁移到 store 契约

**Files:**
- Modify: `server/test/helpers.mjs`
- Modify: `server/test/cacheJanitor.test.mjs`
- Modify: `server/test/media.test.mjs`
- Modify: `server/test/notes.test.mjs`
- Modify: `server/test/providers.test.mjs`
- Modify: `server/test/tasks.test.mjs`
- Modify: `server/test/users.test.mjs`
- Modify: `server/test/db.test.mjs`
- Modify: `server/test/db-config.test.mjs`
- Modify: `server/package.json`
- Create: `server/scripts/test-mysql.mjs`

**Interfaces:**
- Consumes: Task 7 的 `closeStore`、`store.createUser/deleteUser`；Task 1 的 `env.mjs`。
- Produces: 默认 `npm test` 全绿（无 MySQL）；`TEST_DATA_BACKEND=mysql` 时同一组测试跑 MySQL 适配器。

- [ ] **Step 1: 重写 helpers.mjs 走 store**

Create（覆盖）`server/test/helpers.mjs`：

```js
import { createUser, deleteUser } from '../src/store.js';

export async function createTestUser(isAdmin = false) {
  const id = 'tu_' + Math.random().toString(36).slice(2, 10);
  const user = await createUser({ username: id, passwordHash: 'test-hash', isAdmin });
  return user.id;
}

export async function dropTestUser(id) {
  if (!id) return;
  await deleteUser(id);
}
```

- [ ] **Step 2: 迁移 6 个 store 测试的头部**

每个文件：第 1 行插入 `import './env.mjs';`，删除 `import { closePool } from '../src/db.js';`（或含 `query` 的那行），`after(...closePool...)` 改为 `closeStore`。

`server/test/cacheJanitor.test.mjs` 头部改为：

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveNote, addTask, closeStore } from '../src/store.js';
import { cleanOrphanedNotesImages } from '../src/cacheJanitor.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closeStore());
```

`server/test/media.test.mjs` 头部改为：

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insertMedia, getMedia, closeStore } from '../src/store.js';
import { uploadResultAsset } from '../src/cloudStorage.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closeStore());
```

`server/test/notes.test.mjs` 头部改为：

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveNote, getNote, closeStore } from '../src/store.js';
import { cacheRemoteImage, cacheImageUrls } from '../src/routes/notes.js';
import { closeQueue } from '../src/routes/tasks.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => Promise.allSettled([closeStore(), closeQueue()]));
```

`server/test/providers.test.mjs` 头部改为：

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { listProviders, addProvider, updateProvider, deleteProvider, getActiveProvider, getProviderUnmaskedById, setActiveProvider, closeStore } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closeStore());
```

并把第 56 行的直插 settings 语句替换为：

```js
  await setActiveProvider(imageProvider.id, 'image', userId);
```

`server/test/tasks.test.mjs` 头部改为：

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { addTask, listTasks, getTask, updateTask, deleteTask, closeStore } from '../src/store.js';
import { enqueueTask, queue, closeQueue } from '../src/routes/tasks.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => Promise.allSettled([closeStore(), closeQueue()]));
```

`server/test/users.test.mjs` 头部改为：

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureAdmin, findUserByUsername, findUserById, createUser, updateUser, deleteUser, listUsers, getActiveProviderIds, setActiveProvider, saveNote, addTask, getNote, closeStore } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closeStore());
```

并把两处 `query` 用法替换：

```js
  const adminRows = (await listUsers()).filter(u => u.username === 'admin');
  assert.equal(adminRows.length, 1);
```

```js
  assert.equal(await getNote(note.id), null, 'the note should be gone with its owner');
```

- [ ] **Step 3: 门控 db.test.mjs 到 MySQL**

Create（覆盖）`server/test/db.test.mjs`：

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { createXhsAccountPending, bindXhsAccountOpenId } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

// 真实 MySQL 连接测试：仅当 TEST_DATA_BACKEND=mysql 时运行，否则整体跳过（默认 CI 只跑 SQLite）。
const enabled = process.env.TEST_DATA_BACKEND === 'mysql';
const opts = { skip: !enabled };

after(() => closePool());

test('connects to the configured database', opts, async () => {
  const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
  const expectedDb = url.pathname.replace(/^\//, '');
  const { rows } = await query('select database() as db, current_user() as usr');
  assert.equal(rows[0].db, expectedDb);
  assert.match(rows[0].usr, new RegExp('^' + url.username));
});

test('test helper creates and removes a user', opts, async (t) => {
  const id = await createTestUser();
  t.after(() => dropTestUser(id));
  const { rows } = await query('select username from slenk_notes_users where id = ?', [id]);
  assert.equal(rows[0].username, id);
});
```

- [ ] **Step 4: 门控 db-config.test.mjs 的 MySQL 用例**

修改 `server/test/db-config.test.mjs`：第 1 行插入 `import './env.mjs';`，并在 import 区之后加：

```js
const enabled = process.env.TEST_DATA_BACKEND === 'mysql';
const opts = { skip: !enabled };
```

把三个 MySQL 依赖的 `test(...)` 改为带 `opts`：

```js
test('testConnection succeeds against the test DB and fails fast against a closed port', opts, async () => {
```

```js
test('GET /api/settings/db returns passwordSet but never the password', opts, async (t) => {
```

```js
test('GET /api/settings/db is admin-gated', opts, async (t) => {
```

其余纯函数测试（`parseDbConfigFromUrl` / `configsDiffer` / `validateBody` / `getEffectiveDb` 不读 db.json）保持不变。

- [ ] **Step 5: 增加 test:mysql 脚本**

Create `server/scripts/test-mysql.mjs`：

```js
// 跨平台运行 MySQL 契约测试：TEST_DATA_BACKEND=mysql 时跑同一组 store 测试。
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test'], {
  stdio: 'inherit',
  env: { ...process.env, TEST_DATA_BACKEND: 'mysql', SLENK_DATA_BACKEND: 'mysql' }
});
child.on('exit', code => process.exit(code ?? 1));
```

`server/package.json` scripts 增加：

```json
    "test:mysql": "node scripts/test-mysql.mjs",
```

（放在 `"test": "node --test"` 之后，注意上一行末尾加逗号。）

- [ ] **Step 6: 运行默认测试套件确认全绿**

Run: `node --test server/test/mediaFiles.test.mjs server/test/storeSqliteUsers.test.mjs server/test/storeSqliteProviders.test.mjs server/test/storeSqliteTasks.test.mjs server/test/storeSqliteMedia.test.mjs server/test/storeSqliteImport.test.mjs server/test/storeDispatch.test.mjs server/test/helpers.mjs`
Expected: PASS（全部新增测试；helpers 无测试只验证可加载）。

Run: `node --test server/test/users.test.mjs server/test/providers.test.mjs server/test/media.test.mjs server/test/notes.test.mjs server/test/tasks.test.mjs server/test/cacheJanitor.test.mjs server/test/db-config.test.mjs`
Expected: PASS（6 个 store 测试 + db-config 纯函数/门控通过；db 相关用例跳过）。

- [ ] **Step 7: 提交**

```bash
git add server/test/helpers.mjs server/test/cacheJanitor.test.mjs server/test/media.test.mjs server/test/notes.test.mjs server/test/providers.test.mjs server/test/tasks.test.mjs server/test/users.test.mjs server/test/db.test.mjs server/test/db-config.test.mjs server/package.json server/scripts/test-mysql.mjs
git commit -m "test: 测试环境迁移到 store 契约并增加 test:mysql"
```

---

### Task 9: MySQL 媒体改文件与迁移、巡检脚本

**Files:**
- Modify: `server/src/store.mysql.js`
- Modify: `server/scripts/schema.mysql.sql`
- Create: `server/scripts/migrate-media-files.mjs`
- Create: `server/scripts/media-janitor.mjs`
- Test: `server/test/mediaJanitor.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `writeMediaFile/readMediaFile/removeMediaFiles`；Task 7 的 `listMediaIds`。
- Produces: MySQL 适配器媒体读写走文件；`runJanitor` 可注入 `list`/`root` 以便测试。

**注意（既有 MySQL 库）：** 本任务改 `store.mysql.js` 后不再写 `data` 列。既有库需先跑一次 `node server/scripts/migrate-media-files.mjs --drop-column`，否则 `not null` 约束会让 `insertMedia` 失败。全新库用 `apply-schema` 建表（schema 已无 `data` 列）不受影响。

- [ ] **Step 1: 写失败的巡检测试**

Create `server/test/mediaJanitor.test.mjs`:

```js
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJanitor } from '../scripts/media-janitor.mjs';

test('runJanitor 报告孤儿文件与缺失文件，--apply 删除孤儿', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep'), 'x');
    fs.writeFileSync(path.join(dir, 'orphan'), 'x');
    fs.writeFileSync(path.join(dir, 'in-progress.tmp'), 'x');
    const dbIds = ['keep'];
    const dry = await runJanitor({ list: async () => dbIds, root: () => dir, apply: false });
    assert.deepEqual(dry.orphanFiles, ['orphan']);
    assert.deepEqual(dry.missingFiles, []);
    assert.equal(dry.removed, 0);
    const wet = await runJanitor({ list: async () => dbIds, root: () => dir, apply: true });
    assert.equal(wet.removed, 1);
    assert.equal(fs.existsSync(path.join(dir, 'orphan')), false);
    assert.equal(fs.existsSync(path.join(dir, 'keep')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runJanitor 报告数据库有而文件缺失的 id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janitor-'));
  try {
    fs.writeFileSync(path.join(dir, 'keep'), 'x');
    const result = await runJanitor({ list: async () => ['keep', 'gone'], root: () => dir, apply: false });
    assert.deepEqual(result.missingFiles, ['gone']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/test/mediaJanitor.test.mjs`
Expected: FAIL，`Cannot find module .../scripts/media-janitor.mjs`。

- [ ] **Step 3: 修改 store.mysql.js 媒体读写走文件**

1) 顶部 import 追加：

```js
import { writeMediaFile, readMediaFile, removeMediaFile, removeMediaFiles } from './lib/mediaFiles.js';
```

2) `deleteUser`（约 89-92 行）替换为：

```js
async function deleteUser(id) {
  const { rows: media } = await query('select id from slenk_notes_media where user_id = ?', [id]);
  const { rowCount } = await query('delete from slenk_notes_users where id = ?', [id]);
  removeMediaFiles(media.map(r => r.id));
  return rowCount > 0;
}
```

3) `insertMedia`（约 570-576 行）替换为：

```js
async function insertMedia({ id, taskId, userId, filename, mimeType, data }) {
  writeMediaFile(id, data);
  try {
    await query(
      'insert into slenk_notes_media (id, task_id, user_id, filename, mime_type, size_bytes) values (?, ?, ?, ?, ?, ?)',
      [id, taskId ?? null, userId, filename, mimeType, data.length]
    );
  } catch (e) {
    removeMediaFile(id);
    throw e;
  }
  return id;
}
```

4) `getMedia`（约 578-594 行）替换为：

```js
async function getMedia(id) {
  const { rows } = await query(
    'select id, task_id, user_id, filename, mime_type, size_bytes from slenk_notes_media where id = ?',
    [id]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const data = readMediaFile(id);
  if (data == null) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    filename: row.filename,
    mimeType: row.mime_type,
    data,
    sizeBytes: Number(row.size_bytes)
  };
}
```

- [ ] **Step 4: 更新 MySQL schema 删除 data 列**

修改 `server/scripts/schema.mysql.sql` 的 `slenk_notes_media` 建表块：删除第 134 行 `data longblob not null,`，并把上方注释（约 124-127 行）改为：

```sql
-- 媒体字节存 <mediaDir>/<id> 文件，本表只存元数据。
-- 升级路径：先跑 node scripts/migrate-media-files.mjs --drop-column。
```

- [ ] **Step 5: 创建媒体迁移脚本**

Create `server/scripts/migrate-media-files.mjs`：

```js
// 一次性迁移：slenk_notes_media.data (LONGBLOB) → <mediaDir>/<id> 文件。
// 用法：node scripts/migrate-media-files.mjs [--drop-column]
//   --drop-column：迁移成功后再删除 data 列。既有库切换 store.mysql 前必跑。
import { query, closePool } from '../src/db.js';
import { writeMediaFile } from '../src/lib/mediaFiles.js';

const dropColumn = process.argv.includes('--drop-column');

try {
  const { rows: cols } = await query(
    `select column_name from information_schema.columns
     where table_schema = database() and table_name = 'slenk_notes_media' and column_name = 'data'`
  );
  if (!cols.length) {
    console.log('media.data 列不存在，视为已迁移。');
    process.exit(0);
  }
  const { rows } = await query('select id, data from slenk_notes_media');
  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    try {
      writeMediaFile(row.id, Buffer.from(row.data));
      ok++;
    } catch (e) {
      fail++;
      console.error(`写入失败 ${row.id}:`, e.message);
    }
  }
  console.log(`迁移完成：${ok} 成功，${fail} 失败。`);
  if (dropColumn) {
    await query('alter table slenk_notes_media drop column data');
    console.log('已删除 data 列。');
  } else {
    console.log('未删除 data 列；确认无误后加 --drop-column 删除。');
  }
  process.exitCode = fail ? 1 : 0;
} finally {
  await closePool();
}
```

- [ ] **Step 6: 创建媒体巡检脚本**

Create `server/scripts/media-janitor.mjs`：

```js
// 媒体文件巡检：对比数据库中的媒体 id 与 <mediaDir> 下的文件。
// 默认只读；--apply 时删除「数据库不存在但文件存在」的孤儿文件。忽略 *.tmp。
// 用法：node scripts/media-janitor.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMediaIds } from '../src/store.js';
import { mediaRoot } from '../src/lib/mediaFiles.js';

export async function runJanitor({ list = listMediaIds, root = mediaRoot, apply = false, log = console } = {}) {
  const dbIds = new Set(await list());
  const dir = root();
  const orphanFiles = [];
  const missingFiles = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.tmp')) continue;
      if (!dbIds.has(f)) orphanFiles.push(f);
    }
  }
  for (const id of dbIds) {
    if (!fs.existsSync(path.join(dir, id))) missingFiles.push(id);
  }
  let removed = 0;
  if (apply) {
    for (const f of orphanFiles) {
      try { fs.unlinkSync(path.join(dir, f)); removed++; }
      catch (e) { log.warn(`[media-janitor] 删除失败 ${f}:`, e.message); }
    }
  }
  return { orphanFiles, missingFiles, removed, dbCount: dbIds.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  const result = await runJanitor({ apply });
  console.log(`媒体巡检：数据库 ${result.dbCount} 条；`);
  console.log(`  孤儿文件 ${result.orphanFiles.length} 个${apply ? `（已删除 ${result.removed}）` : '（--apply 删除）'}`);
  console.log(`  数据库有但文件缺失 ${result.missingFiles.length} 个`);
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `node --test server/test/mediaJanitor.test.mjs`
Expected: PASS（2 个测试）。

Run: `node --test server/test/media.test.mjs`
Expected: PASS（SQLite 默认下走文件媒体）。

- [ ] **Step 8: 验证 MySQL 契约（可选，需本机 MySQL）**

先迁移既有库（如无 `data` 列会提示已迁移）：

```bash
node server/scripts/migrate-media-files.mjs --drop-column
```

再跑 MySQL 契约套件：

```bash
npm --prefix server run test:mysql
```

Expected: PASS（6 个 store 测试 + db 相关用例在 MySQL 上执行）。

- [ ] **Step 9: 提交**

```bash
git add server/src/store.mysql.js server/scripts/schema.mysql.sql server/scripts/migrate-media-files.mjs server/scripts/media-janitor.mjs server/test/mediaJanitor.test.mjs
git commit -m "feat: MySQL 媒体改文件存储，新增迁移与巡检脚本"
```

---

### Task 10: TiDB 同步改为纯数据函数并挂到 SQLite

**Files:**
- Modify: `server/src/syncTiDB.js`
- Modify: `server/src/store.sqlite.js`
- Modify: `server/src/index.js`
- Modify: `server/test/env.mjs`
- Test: `server/test/syncTiDB.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `exportSyncRows` / `importSyncRows`；`lib/cloudSyncMerge.js` 的 `mergeProviders` / `mergeUsers`。
- Produces: `pushProvidersUsers(providers, users)`、`scheduleSyncProvidersUsers(delay, loadRows)`、`fetchCloudProvidersUsers()`；store.sqlite 变更后自动调度推送。

**注意（控制器决议）：** 本任务 Step 4 让 `store.sqlite.js` 静态 import `syncTiDB.js`，而所有 store 测试文件都经 `store.js → store.sqlite.js` 传递 import 到它。`syncTiDB.js` 在模块加载时捕获 `TIDB_PG_URL`（其 `loadEnv` 会从 `.env` 载入真实值，本机 `.env:37` 已配置）。若不在测试环境强制关掉云端同步，store 测试的 `createUser/deleteUser` 等会经 `queueSync` 在 1500ms 后真的连接并推送数据到生产 TiDB。**决议：在 `server/test/env.mjs` 增加一行 `process.env.TIDB_PG_URL = '';`**（dotenv 不覆盖已设变量，故 `syncTiDB.js` 捕获 `''`，全测试环境对云端同步为 no-op）。同时这使本任务 Step 1 的 skip 测试真正测到「未配置」路径（原测试的 `delete process.env.TIDB_PG_URL` 在静态 import 之后执行，对模块已捕获的值无效，且仅靠它不足以防 store 测试泄漏）。

- [ ] **Step 1: 写失败的测试**

Create `server/test/syncTiDB.test.mjs`:

```js
import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleSyncProvidersUsers, fetchCloudProvidersUsers, pushProvidersUsers } from '../src/syncTiDB.js';

test('未配置 TIDB_PG_URL 时同步静默跳过', async () => {
  delete process.env.TIDB_PG_URL;
  const push = await pushProvidersUsers([], []);
  assert.equal(push.skipped, true);
  assert.equal(push.reason, 'TIDB_PG_URL not set');
  const fetch = await fetchCloudProvidersUsers();
  assert.equal(fetch.skipped, true);
  assert.doesNotThrow(() => scheduleSyncProvidersUsers(10, async () => ({ providers: [], users: [] })));
});

test('loadRows 为 null 时调度为 no-op', () => {
  delete process.env.TIDB_PG_URL;
  assert.doesNotThrow(() => scheduleSyncProvidersUsers(10, null));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/test/syncTiDB.test.mjs`
Expected: FAIL，`pushProvidersUsers is not a function`。

- [ ] **Step 3: 重写 syncTiDB.js 为纯数据函数**

Create（覆盖）`server/src/syncTiDB.js`：

```js
// syncTiDB.js — 供应商/用户数据与 TiDB Cloud（PostgreSQL 兼容集群）的双向同步数据函数。
//
// 仅 SQLite 后端使用。store.sqlite.js 在供应商/用户变更后调用 scheduleSyncProvidersUsers；
// index.js 在启动时用 fetchCloudProvidersUsers + merge + importSyncRows 拉取收敛。
// TIDB_PG_URL 未配置时静默跳过（离线无云）。幂等 upsert (kind,id) 主键。
// 说明：TiDB Cloud 管理 API（TIDB_API_* 密钥）只能管理集群、不能执行 SQL，
// 写数据必须用集群的 PG 连接串（TIDB_PG_URL）直连——见 README「TiDB 云端同步」一节。
import './loadEnv.js';
import pg from 'pg';

const TIDB_PG_URL = process.env.TIDB_PG_URL;
const TABLE = 'slenk_cloud_sync';

async function ensureTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       kind VARCHAR(16) NOT NULL,
       id VARCHAR(64) NOT NULL,
       data JSONB NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (kind, id)
     )`
  );
}

async function mirrorKind(client, kind, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO ${TABLE} (kind, id, data, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [kind, row.id, JSON.stringify(row)]
    );
  }
  if (rows.length) {
    await client.query(
      `DELETE FROM ${TABLE} WHERE kind = $1 AND NOT (id = ANY($2))`,
      [kind, rows.map(r => r.id)]
    );
  } else {
    await client.query(`DELETE FROM ${TABLE} WHERE kind = $1`, [kind]);
  }
}

let syncing = false;
let queued = false;
let queuedRows = null;

// 全量镜像同步：providers + users → TiDB。返回统计或 { ok:false }。
export async function pushProvidersUsers(providers, users) {
  if (!TIDB_PG_URL) return { ok: false, skipped: true, reason: 'TIDB_PG_URL not set' };
  if (syncing) { queued = true; queuedRows = { providers, users }; return { ok: false, queued: true }; }
  syncing = true;
  try {
    const client = new pg.Client({ connectionString: TIDB_PG_URL, connectionTimeoutMillis: 15000 });
    await client.connect();
    await ensureTable(client);
    await mirrorKind(client, 'provider', providers);
    await mirrorKind(client, 'user', users);
    await client.end();
    console.log(`[tidb-sync] 同步完成：provider ${providers.length} 条，user ${users.length} 条`);
    return { ok: true, providers: providers.length, users: users.length };
  } catch (e) {
    console.error('[tidb-sync] failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    syncing = false;
    if (queued) {
      queued = false;
      const q = queuedRows; queuedRows = null;
      setTimeout(() => void pushProvidersUsers(q.providers, q.users), 1000);
    }
  }
}

// 变更后调度（防抖）：loadRows() 取当前行，连续多次变更合并为一次同步。
let timer = null;
export function scheduleSyncProvidersUsers(delay = 1500, loadRows) {
  if (!TIDB_PG_URL || typeof loadRows !== 'function') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      const { providers, users } = await loadRows();
      await pushProvidersUsers(providers, users);
    } catch (e) {
      console.error('[tidb-sync] 调度同步失败：', e.message);
    }
  }, delay);
}

// 从 TiDB 读取云端 providers/users 行（不做任何本地读写）。
export async function fetchCloudProvidersUsers() {
  if (!TIDB_PG_URL) return { ok: false, skipped: true, reason: 'TIDB_PG_URL not set' };
  const client = new pg.Client({ connectionString: TIDB_PG_URL, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    await ensureTable(client);
    const { rows } = await client.query(`SELECT kind, data FROM ${TABLE} WHERE kind IN ('provider', 'user')`);
    return {
      ok: true,
      providers: rows.filter(r => r.kind === 'provider').map(r => r.data),
      users: rows.filter(r => r.kind === 'user').map(r => r.data)
    };
  } catch (e) {
    console.error('[tidb-sync] fetch failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    await client.end().catch(() => {});
  }
}
```

- [ ] **Step 4: store.sqlite 变更后调度推送**

修改 `server/src/store.sqlite.js`：

1) 顶部 import 追加：

```js
import { scheduleSyncProvidersUsers } from './syncTiDB.js';
```

2) 在 `closeStore` 之后追加：

```js
// 供应商/用户变更后防抖推送 TiDB（未配置 TIDB_PG_URL 时为空操作）。
function queueSync() {
  scheduleSyncProvidersUsers(1500, async () => {
    const rows = await exportSyncRows();
    return { providers: rows.providers, users: rows.users };
  });
}
```

3) 在 `createUser`、`updateUser`、`deleteUser`、`addProvider`、`updateProvider`、`deleteProvider` 的函数体末尾各加一行：

```js
  queueSync();
```

（`createUser` 在 `return findUserById(id)` 之前、`updateUser` 在 `return findUserById(id)` 之前、`deleteUser` 在 `return info.changes > 0` 之前、`addProvider` 在 `return getProviderById(p.id)` 之前、`updateProvider` 在 `return getProviderById(id)` 之前、`deleteProvider` 在 `return info.changes > 0;` 之前。）

- [ ] **Step 5: index.js 启动拉取改为 sqlite 编排**

修改 `server/src/index.js` 第 106-112 行替换为：

```js
// SQLite 后端：启动后从 TiDB 拉取共享的供应商/用户数据并与本地合并（异步、失败不影响启动）。
// 这样换机/清空本地后仪表盘不再空白；变更仍走 store 的推送镜像，双向在启动时收敛。
if (process.env.SLENK_DATA_BACKEND !== 'mysql') {
  import('./syncTiDB.js')
    .then(async (m) => {
      const cloud = await m.fetchCloudProvidersUsers();
      if (!cloud.ok) return;
      const [{ exportSyncRows, importSyncRows }, { mergeProviders, mergeUsers }] = await Promise.all([
        import('./store.js'),
        import('./lib/cloudSyncMerge.js')
      ]);
      const local = await exportSyncRows();
      const mergedProviders = mergeProviders(local.providers, cloud.providers);
      const mergedUsers = mergeUsers(local.users, cloud.users);
      const sig = rows => JSON.stringify([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))));
      const changed = sig(mergedProviders) !== sig(local.providers) || sig(mergedUsers) !== sig(local.users);
      if (changed) {
        await importSyncRows({ providers: mergedProviders, users: mergedUsers });
        await m.pushProvidersUsers(mergedProviders, mergedUsers);
      }
      console.log(`[tidb-sync] 启动拉取完成：provider 本地 ${local.providers.length} → 合并 ${mergedProviders.length}，user 本地 ${local.users.length} → 合并 ${mergedUsers.length}${changed ? '（已写回）' : '（无变化）'}`);
    })
    .catch(err => console.error('[tidb-sync] 启动拉取失败：', err.message));
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test server/test/syncTiDB.test.mjs`
Expected: PASS（2 个测试）。

Run: `node --test server/test/storeSqliteUsers.test.mjs server/test/storeSqliteProviders.test.mjs server/test/storeSqliteTasks.test.mjs server/test/storeSqliteMedia.test.mjs server/test/storeSqliteImport.test.mjs`
Expected: PASS（queueSync 为 no-op，不影响既有用例）。

- [ ] **Step 7: 提交**

```bash
git add server/src/syncTiDB.js server/src/store.sqlite.js server/src/index.js server/test/syncTiDB.test.mjs
git commit -m "feat: TiDB 同步改为纯数据函数并挂到 SQLite 后端"
```

---

### Task 11: 设置路由 SQLite 分支与前端展示

**Files:**
- Modify: `server/src/routes/settings.js`
- Modify: `web/src/App.jsx`
- Test: `server/test/settingsSqlite.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `paths.sqlitePath` / `paths.mediaDir`。
- Produces: `GET /api/settings/db` 在 SQLite 下返回 `{ storage:'sqlite', path, mediaDir }`；写接口返回 `400 { error:'sqlite_storage' }`。

- [ ] **Step 1: 写失败的测试**

Create `server/test/settingsSqlite.test.mjs`:

```js
import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../src/auth.js';
import { createTestUser, dropTestUser } from './helpers.mjs';
import { closeStore } from '../src/store.js';
import { paths } from '../src/paths.js';

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test server/test/settingsSqlite.test.mjs`
Expected: FAIL，`body.storage === 'sqlite'` 不成立（当前返回 `local`）。

- [ ] **Step 3: 修改设置路由**

Create（覆盖）`server/src/routes/settings.js`：

```js
import { Router } from 'express';
import fs from 'node:fs';
import { verify, requireAdmin } from '../auth.js';
import { getEffectiveDb, getDbConfigPath, testConnection, getPool, invalidateDbConfigCache } from '../db.js';
import { paths } from '../paths.js';

// SQLite 后端（默认；SLENK_DATA_BACKEND 未设置或 =sqlite）：无 MySQL 连接，连接管理接口不适用。
const isSqliteBackend = (process.env.SLENK_DATA_BACKEND || 'sqlite') === 'sqlite';

export const router = Router();
router.use(verify);
router.use(requireAdmin);

export function validateBody(body) {
  const host = String(body?.host || '').trim();
  const user = String(body?.user || '').trim();
  const database = String(body?.database || '').trim();
  const port = Number(body?.port ?? 3306);
  if (!host) return { error: 'host_required' };
  if (!user) return { error: 'user_required' };
  if (!database) return { error: 'database_required' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'invalid_port' };
  return { config: { host, port, user, password: String(body?.password ?? ''), database } };
}

// GET 当前有效连接（绝不返回密码）。SQLite 模式返回路径与媒体目录，前端据此隐藏 MySQL 表单。
router.get('/db', (req, res, next) => {
  try {
    if (isSqliteBackend) return res.json({ storage: 'sqlite', path: paths.sqlitePath, mediaDir: paths.mediaDir });
    const { config, source } = getEffectiveDb();
    res.json({
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      passwordSet: Boolean(config.password),
      source
    });
  } catch (err) { next(err); }
});

// POST 测试连接：校验后建一次性池 SELECT 1，不落盘；密码留空=用当前。
router.post('/db/test', async (req, res, next) => {
  try {
    if (isSqliteBackend) return res.status(400).json({ error: 'sqlite_storage' });
    const v = validateBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const current = getEffectiveDb().config;
    const password = v.config.password || current.password;
    const result = await testConnection({ ...v.config, password });
    if (!result.ok) return res.status(400).json({ error: 'connection_failed', detail: result.error });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST 保存：先校验连通性，通过才写 db.json；写后失效缓存并触发一次预重连。
// 已运行中的 server/worker 各自在下次 DB 访问时自动换池（无重启）。
router.post('/db', async (req, res, next) => {
  try {
    if (isSqliteBackend) return res.status(400).json({ error: 'sqlite_storage' });
    const v = validateBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const current = getEffectiveDb().config;
    const candidate = { ...v.config, password: v.config.password || current.password };
    const result = await testConnection(candidate);
    if (!result.ok) return res.status(400).json({ error: 'connection_failed', detail: result.error });
    fs.writeFileSync(getDbConfigPath(), JSON.stringify(candidate, null, 2) + '\n', 'utf8');
    invalidateDbConfigCache();
    void getPool().catch(err => console.error('[db] reconnect after save failed:', err.message));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE 重置：删 db.json，回退 .env。
router.delete('/db', (req, res, next) => {
  try {
    if (isSqliteBackend) return res.status(400).json({ error: 'sqlite_storage' });
    const file = getDbConfigPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    invalidateDbConfigCache();
    void getPool().catch(err => console.error('[db] reconnect after reset failed:', err.message));
    res.json({ ok: true });
  } catch (err) { next(err); }
});
```

- [ ] **Step 4: 更新前端设置卡片**

修改 `web/src/App.jsx` 的 `DatabaseSettingsCard`：

1) 在 `const [passwordSet, setPasswordSet] = useState(false);` 后加：

```jsx
  const [storagePath, setStoragePath] = useState('');
  const [storageMediaDir, setStorageMediaDir] = useState('');
```

2) `load()` 内 `setStorage(data.storage || 'mysql');` 后加：

```jsx
      setStoragePath(data.path || '');
      setStorageMediaDir(data.mediaDir || '');
```

3) `if (storage === 'local') {` 改为 `if (storage === 'sqlite') {`，并把该分支返回内容改为：

```jsx
  if (storage === 'sqlite') {
    return (
      <section className="card provider-manager db-manager">
        <div className="section-head"><div><h3>数据库连接</h3><p>当前为 SQLite 存储（默认，SLENK_DATA_BACKEND=sqlite），不使用 MySQL。</p></div><span className="pill">SQLite</span></div>
        <div className="db-local-info">
          <p><b>数据库文件</b>：<code>{storagePath}</code></p>
          <p><b>媒体目录</b>：<code>{storageMediaDir}</code></p>
          <p><b>云端同步</b>：供应商与用户数据镜像到 TiDB Cloud（<code>slenk_cloud_sync</code>），通过 <code>TIDB_PG_URL</code> 连接。</p>
          <p className="db-status ok">切换 MySQL 需修改 <code>SLENK_DATA_BACKEND</code> 并重启。</p>
        </div>
      </section>
    );
  }
```

- [ ] **Step 5: 更新仪表盘徽标与上传文案**

`web/src/App.jsx` 第 690 行仪表盘徽标：

```jsx
<div><b>SQLite</b><span>存储</span></div>
```

第 1798 行上传成功文案：

```jsx
      setStatus((data.files?.length || 0) + ' 个素材已保存到素材目录。');
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test server/test/settingsSqlite.test.mjs`
Expected: PASS（1 个测试）。

Run: `node --test server/test/db-config.test.mjs`
Expected: PASS（纯函数用例运行，MySQL 用例跳过）。

Run: `npm --prefix web test`
Expected: PASS（web 测试不变）。

- [ ] **Step 7: 提交**

```bash
git add server/src/routes/settings.js web/src/App.jsx server/test/settingsSqlite.test.mjs
git commit -m "feat: 设置路由 SQLite 分支与前端展示"
```

---

### Task 12: 删除本地 JSON 后端并更新文档

**Files:**
- Delete: `server/src/store.local.js`
- Delete: `server/scripts/migrate-providers-to-local.mjs`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: 前面所有任务（`store.local` 已无引用）。
- Produces: 仓库不再引用 `store.local`；文档默认 SQLite。

- [ ] **Step 1: 删除已无引用的本地后端与迁移脚本**

```bash
git rm server/src/store.local.js server/scripts/migrate-providers-to-local.mjs
```

- [ ] **Step 2: 更新 .env.example**

在 `VIDEO_OUT_PATH=./storage/videos` 之后加：

```dotenv
# Data layer: sqlite (default) or mysql. Unset = sqlite.
SLENK_DATA_BACKEND=sqlite
# SQLite file and media bytes directory (defaults under STORAGE_PATH).
# SQLITE_PATH=./storage/slenk.sqlite
# MEDIA_DIR=./storage/media
```

- [ ] **Step 3: 更新 README.md**

用以下精确替换（每处 old → new）：

第 7 行：
- old: `- 账号：本地 JSON 或 MySQL 中的用户账号（默认本地模式；首次初始化会创建 \`admin / 123456\`，登录后建议修改）`
- new: `- 账号：SQLite 或 MySQL 中的用户账号（默认 SQLite；首次初始化会创建 \`admin / 123456\`，登录后建议修改）`

第 10 行：
- old: `- 文件存储：上传/视频/笔记图缓存存本地 \`STORAGE_PATH\`；生成媒体在 MySQL 模式入 \`slenk_notes_media\` BLOB（\`/api/media/:id\` 读回），本地模式存 \`storage/local/media/\` 文件`
- new: `- 文件存储：上传/视频/笔记图缓存存本地 \`STORAGE_PATH\`；生成媒体字节统一存 \`<MEDIA_DIR>/<id>\` 文件，\`/api/media/:id\` 读回`

第 12 行：
- old: `- 数据层：默认本地 JSON（\`storage/local/\`，不用 MySQL）；设 \`SLENK_DATA_BACKEND=mysql\` 切回 MySQL。见下文「数据层」两节；本地模式下供应商/用户数据镜像到 TiDB Cloud`
- new: `- 数据层：默认 SQLite（\`storage/slenk.sqlite\`，Node 内置 \`node:sqlite\`，不用 MySQL）；设 \`SLENK_DATA_BACKEND=mysql\` 切 MySQL。见下文「数据层」两节；SQLite 模式下供应商/用户数据镜像到 TiDB Cloud`

「数据层（本机 MySQL）」节：
- old: `本机 MySQL 8（服务 \`MySQL95\`，\`127.0.0.1:3306\`）是**可选的**数据后端：设 \`SLENK_DATA_BACKEND=mysql\`（默认未设置时为本地 JSON，见下一节）后启用。业务数据（用户、用户设置、AI 供应商、任务、笔记）全部存放在 MySQL，生成媒体（图/视频）存 \`slenk_notes_media\` 表（LONGBLOB）。`
- new: `本机 MySQL 8（服务 \`MySQL95\`，\`127.0.0.1:3306\`）是**可选的**数据后端：设 \`SLENK_DATA_BACKEND=mysql\`（默认未设置时为 SQLite，见下一节）后启用。业务数据（用户、用户设置、AI 供应商、任务、笔记）全部存放在 MySQL；生成媒体字节存 \`<MEDIA_DIR>/<id>\` 文件，\`slenk_notes_media\` 只存元数据。`

- old: `- **旧数据迁移**：\`mysqldump\`（含媒体 BLOB，用 \`--single-transaction --quick\`）→ 新机 \`mysql\` 导入。`
- new: `- **旧数据迁移**：\`mysqldump\`（用 \`--single-transaction --quick\`）→ 新机 \`mysql\` 导入。既有库升级到文件媒体必跑 \`node server/scripts/migrate-media-files.mjs --drop-column\`（把 \`slenk_notes_media.data\` 落盘后删列）。`

「数据层（本地 JSON，默认模式）」整节替换为：

```markdown
## 数据层（SQLite，默认模式）

业务数据默认完全不依赖 MySQL，存 SQLite 单文件。`server/src/store.js` 按 `SLENK_DATA_BACKEND` 选择后端：未设置或 `=sqlite` → `store.sqlite.js`（Node 内置 `node:sqlite`）；`=mysql` → `store.mysql.js`（两者导出接口一致，路由/worker/认证零改动）。SQLite 模式无需 MySQL、无需建库建表。

- **数据位置**：`SQLITE_PATH`（默认 `<dataDir>/slenk.sqlite`，WAL + busy_timeout 5000 + 外键）；媒体字节统一存 `<MEDIA_DIR>/<id>`（默认 `<dataDir>/media`），`slenk_notes_media` 只存元数据。
- **一致性**：WAL 允许 server 与 worker 跨进程并发读；写冲突靠 `busy_timeout` + 一次重试，仍忙返回 `503 storage_busy`。
- **时间戳**：`YYYY-MM-DDTHH:MM:SS.mmmZ`（UTC ISO-8601，与 MySQL 后端输出对齐）。
- **旧数据**：首次启动只从 `storage/local/` 一次性导入 `users` / `providers` / `user_settings`（以 `slenk_notes_meta.local_import_v1` 为标记），其余旧任务/笔记/媒体不迁移；`storage/local/` 保留作备份。
- **接口降级**：`GET /api/settings/db` 在 SQLite 模式返回 `{storage:'sqlite', path, mediaDir}`，仪表盘「数据库连接」卡显示路径说明；`POST /db`、`POST /db/test`、`DELETE /db` 返回 `400 sqlite_storage`（MySQL 连接管理不适用）。
- **默认账号**：首次启动自动创建 `admin / 123456`（与 MySQL 模式一致，登录后建议修改）。
```

「TiDB 云端同步（本地模式）」节三处替换：
- old: `## TiDB 云端同步（本地模式）` → new: `## TiDB 云端同步（SQLite 模式）`
- old: `本地模式下，**供应商与用户数据**会镜像到 TiDB Cloud` → new: `SQLite 模式下，**供应商与用户数据**会镜像到 TiDB Cloud`
- old: `**机制**：\`server/src/syncTiDB.js\` —— 供应商/用户每次增删改后防抖 1.5s 触发一次全量镜像（幂等 upsert + 删除本地已删的行，保持镜像一致）；\`TIDB_PG_URL\` 未配置则静默跳过（离线无云）。`
- new: `**机制**：\`server/src/syncTiDB.js\` —— 供应商/用户每次增删改后防抖 1.5s 触发一次全量镜像（幂等 upsert + 删除本地已删的行，保持镜像一致）；启动时拉取云端并与本地合并收敛；\`TIDB_PG_URL\` 未配置则静默跳过（离线无云）。`

第 130 行：
- old: `- \`C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/local\`（\`SLENK_DATA_BACKEND=local\` 时的 JSON 表文件与媒体文件）`
- new: `- \`C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/local\`（旧数据备份；SQLite 首启一次性导入 users/providers/user_settings）`

- [ ] **Step 4: 更新 SETUP.md**

- old: `| **MySQL 8** | 可选数据库（\`SLENK_DATA_BACKEND=mysql\`） | 默认**不用** MySQL（本地 JSON，见下文）；要用 MySQL 时，生产库在本机 MySQL（服务 \`MySQL95\`，\`127.0.0.1:3306\`），新机器必须装并迁移数据 |`
- new: `| **MySQL 8** | 可选数据库（\`SLENK_DATA_BACKEND=mysql\`） | 默认**不用** MySQL（SQLite，见下文）；要用 MySQL 时，生产库在本机 MySQL（服务 \`MySQL95\`，\`127.0.0.1:3306\`），新机器必须装并迁移数据 |`

- old: `**默认用本地 JSON**（\`.env\` 已设 \`SLENK_DATA_BACKEND=local\`）：业务数据（用户/供应商/任务/笔记/媒体）直接存 \`storage/local/\` JSON 文件，无需装 MySQL、无需建库建表；供应商与用户数据会镜像到 TiDB Cloud（需 \`.env\` 配 \`TIDB_PG_URL\`，见 README「数据层（本地 JSON）」与「TiDB 云端同步」）。此模式跳过上面所有数据库步骤；要切回 MySQL 才把 \`SLENK_DATA_BACKEND\` 改为 \`mysql\`。`
- new: `**默认用 SQLite**（\`.env\` 可设 \`SLENK_DATA_BACKEND=sqlite\`）：业务数据存 \`<SQLITE_PATH>\`（默认 \`storage/slenk.sqlite\`），媒体字节存 \`<MEDIA_DIR>\`（默认 \`storage/media\`），无需装 MySQL、无需建库建表；供应商与用户数据会镜像到 TiDB Cloud（需 \`.env\` 配 \`TIDB_PG_URL\`，见 README「数据层（SQLite）」与「TiDB 云端同步」）。此模式跳过上面所有数据库步骤；要切 MySQL 才把 \`SLENK_DATA_BACKEND\` 改为 \`mysql\`（既有库先跑 \`node server/scripts/migrate-media-files.mjs --drop-column\`）。`

- old: `启动（确保 Redis、MySQL 已运行；本地模式只需 Redis）：`
- new: `启动（确保 Redis 已运行；SQLite 模式无需 MySQL）：`

- [ ] **Step 5: 更新 AGENTS.md**

在 `## Multi-image tasks` 标题之前插入：

```markdown
## Data layer

- `SLENK_DATA_BACKEND` 为 `sqlite`（默认）或 `mysql`。SQLite 文件：`SQLITE_PATH`（默认 `storage/slenk.sqlite`）；媒体字节：`MEDIA_DIR`（默认 `storage/media`），元数据在 `slenk_notes_media`。
- SQLite 首启只从 `storage/local/` 一次性导入 `users` / `providers` / `user_settings`（`slenk_notes_meta.local_import_v1` 标记）；旧任务/笔记/媒体不迁移。
- MySQL 升级到文件媒体必跑 `node server/scripts/migrate-media-files.mjs --drop-column`。
```

- [ ] **Step 6: 全量验证**

确认无残留引用：

Run: `grep -rn "store\.local\|SLENK_DATA_BACKEND=local" server/src server/test web/src README.md SETUP.md .env.example AGENTS.md`
Expected: 无输出。

运行完整 server 测试套件（Redis 需已运行；默认 SQLite 无需 MySQL）：

Run: `npm --prefix server test`
Expected: PASS（新增 8 个测试文件 + 既有纯函数/单元测试全绿；`db.test.mjs`、`db-config` 的 MySQL 用例跳过）。

运行 web 测试：

Run: `npm --prefix web test`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "docs: 数据层默认 SQLite，删除本地 JSON 后端" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

（删除文件已用 `git rm` 暂存，`git add -A` 收尾其余文档改动。）
