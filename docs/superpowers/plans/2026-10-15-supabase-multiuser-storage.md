# Supabase 多用户存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Slenk Notes 的数据层从单文件 `storage/app.json` 迁到 Supabase Postgres，并让笔记与任务按用户隔离，同时保持自签 JWT 登录和现有 AI 任务流程不变。

**Architecture:** 后端通过 `pg` 连接池直连 Supavisor（新加坡，session 模式），是数据库的唯一访问者；五张 `slenk_notes_` 前缀表全部启用 RLS 且不建 policy，`anon` / `authenticated` 经 Data API 无任何可达路径。`server/src/store.js` 由 fs 全量读写改为参数化查询并全部异步化，6 个调用文件补 `await`。AI 供应商为全局共享配置，仅管理员可写。

**Tech Stack:** Node.js 24（内置 `node --test`）、Express、`pg`、BullMQ + Redis、Supabase Postgres 15（Supavisor pooler）

**Spec:** `docs/superpowers/specs/2026-10-15-supabase-multiuser-storage-design.md`

## Global Constraints

- 表名一律 `slenk_notes_` 前缀，全小写加下划线，任何位置都不加引号
- 五张表全部 `enable row level security`，**不创建任何 policy**，也不向 `anon` / `authenticated` 授予任何权限
- 不使用 `SECURITY DEFINER` 函数
- SQL 一律参数化（`$1`, `$2`），不拼接字符串
- 认证继续用自签 JWT（`server/src/auth.js` 不改签名逻辑）
- `providers` 全局共享，写操作仅管理员（`is_admin = true`）可执行
- 连接串只存在于 `.env` 的 `DATABASE_URL`，不写入任何提交到版本库的文件
- 每张表的 `id` 为 text 主键；时间列用 `timestamptz`
- 测试用 `node --test`，测试文件位于 `server/test/`，命名 `*.test.mjs`

## 与 spec 的一处偏差（实现时以本节为准）

spec 写了"`getNote` 增加 `userId` 约束"，这与现有功能冲突：`GET /api/notes/:id` **没有鉴权**，是 `/p/<id>` 分享页的数据源（`web/src/App.jsx:582`、`server/src/routes/notes.js:24`）。加约束会让分享链接失效。

因此实现为：`saveNote(userId, note)` 写入归属，`getNote(id)` 保持公开读取。笔记 id 是 nanoid 随机串、不可枚举，与现状安全等级一致。若将来要收紧，应做成"分享开关"这类独立改动。

---

### Task 1: 数据库 Schema

**Files:**
- Create: `server/scripts/schema.sql`
- Create: `server/scripts/apply-schema.mjs`

**Interfaces:**
- Consumes: `DATABASE_URL`（来自 `.env`）
- Produces: 五张表 `slenk_notes_users`、`slenk_notes_user_settings`、`slenk_notes_providers`、`slenk_notes_tasks`、`slenk_notes_notes`，均启用 RLS

- [ ] **Step 1: 写 schema.sql**

```sql
-- Slenk Notes schema. The slenk_notes_ prefix keeps these tables namespaced.
create table if not exists slenk_notes_users (
  id text primary key,
  username text not null unique,
  password_hash text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists slenk_notes_user_settings (
  user_id text primary key references slenk_notes_users(id) on delete cascade,
  active_provider_id text,
  active_text_provider_id text,
  active_image_provider_id text
);

create table if not exists slenk_notes_providers (
  id text primary key,
  name text not null default 'Custom Provider',
  provider_type text not null default 'openai-compatible',
  app_type text not null default 'openai',
  base_url text not null default '',
  api_key text not null default '',
  mode text not null default 'image',
  text_model text not null default '',
  image_model text not null default '',
  notes text not null default '',
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists slenk_notes_tasks (
  id text primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  type text not null,
  label text,
  status text not null default 'queued',
  payload jsonb,
  provider_id text,
  tab text,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists slenk_notes_tasks_user_created_idx
  on slenk_notes_tasks (user_id, created_at desc);

create table if not exists slenk_notes_notes (
  id text primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  title text not null default '',
  content text not null default '',
  tags text[] not null default '{}',
  images jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists slenk_notes_notes_user_created_idx
  on slenk_notes_notes (user_id, created_at desc);

-- Access model: the backend connects as the table owner and is the only client.
-- RLS with no policies means anon/authenticated reach nothing through the Data API.
alter table slenk_notes_users enable row level security;
alter table slenk_notes_user_settings enable row level security;
alter table slenk_notes_providers enable row level security;
alter table slenk_notes_tasks enable row level security;
alter table slenk_notes_notes enable row level security;
```

- [ ] **Step 2: 写 apply-schema.mjs（执行并自检）**

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing in .env');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

await client.connect();
await client.query(sql);

const { rows } = await client.query(`
  select c.relname as table_name, c.relrowsecurity as rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like 'slenk_notes_%' and c.relkind = 'r'
  order by c.relname
`);
await client.end();

console.table(rows);
const missing = rows.filter(r => !r.rls_enabled);
if (rows.length !== 5) {
  console.error(`expected 5 tables, found ${rows.length}`);
  process.exit(1);
}
if (missing.length) {
  console.error('RLS not enabled on:', missing.map(r => r.table_name).join(', '));
  process.exit(1);
}
console.log('schema applied, RLS enabled on all 5 tables');
```

- [ ] **Step 3: 写入 DATABASE_URL**

在 `.env` 追加（密码里的 `@` 写成 `%40`）：

```
DATABASE_URL=postgresql://postgres.vamojyhymwsqovbmpugj:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://vamojyhymwsqovbmpugj.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable key>
SUPABASE_SECRET_KEY=<secret key>
```

- [ ] **Step 4: 执行并确认输出**

Run: `node server/scripts/apply-schema.mjs`
Expected: 打印 5 行表格，`rls_enabled` 全为 `true`，末行 `schema applied, RLS enabled on all 5 tables`

- [ ] **Step 5: 用 publishable key 验证表未暴露**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  "$SUPABASE_URL/rest/v1/slenk_notes_notes?select=id&limit=1"
```
Expected: `401` 或 `404`（绝不为 `200`）

- [ ] **Step 6: Commit**

```bash
git add server/scripts/schema.sql server/scripts/apply-schema.mjs
git commit -m "Add Supabase schema with RLS enabled and no policies"
```

---

### Task 2: 连接层与路径模块

**Files:**
- Create: `server/src/db.js`
- Create: `server/src/paths.js`
- Create: `server/test/helpers.mjs`
- Create: `server/test/db.test.mjs`
- Modify: `server/package.json`（加 `"test": "node --test"`）

**Interfaces:**
- Consumes: `DATABASE_URL`
- Produces:
  - `query(text, params) => Promise<{ rows }>`
  - `withTransaction(fn) => Promise<T>`，`fn` 收到一个 client
  - `closePool() => Promise<void>`
  - `paths.dataDir` / `paths.uploadsDir` / `paths.videosDir`（绝对路径）
  - `test/helpers.mjs` 导出 `createTestUser(isAdmin?)` / `dropTestUser(id)`

- [ ] **Step 1: 写 db.js**

```js
import './loadEnv.js';
import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required (see .env)');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on('error', err => console.error('[db] idle client error', err.message));

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
```

- [ ] **Step 2: 写 paths.js（把路径解析从 store.js 剥离）**

```js
import './loadEnv.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const configuredStorage = process.env.STORAGE_PATH || path.resolve(root, 'storage');
const dataDir = path.isAbsolute(configuredStorage) ? configuredStorage : path.resolve(root, configuredStorage);

function resolveDir(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

export const paths = {
  root,
  dataDir,
  uploadsDir: resolveDir(process.env.UPLOADS_PATH, path.join(dataDir, 'uploads')),
  videosDir: resolveDir(process.env.VIDEO_OUT_PATH, path.join(dataDir, 'videos'))
};
```

- [ ] **Step 3: 写测试助手 `server/test/helpers.mjs`**

```js
import { randomUUID } from 'node:crypto';
import { query } from '../src/db.js';

export async function createTestUser(isAdmin = false) {
  const id = 'tu_' + randomUUID().slice(0, 8);
  await query(
    'insert into slenk_notes_users (id, username, password_hash, is_admin) values ($1, $2, $3, $4)',
    [id, id, 'test-hash', isAdmin]
  );
  return id;
}

export async function dropTestUser(id) {
  await query('delete from slenk_notes_users where id = $1', [id]);
}
```

- [ ] **Step 4: 写测试 `server/test/db.test.mjs`**

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('connects to the project database', async () => {
  const { rows } = await query('select current_database() as db, current_user as usr');
  assert.equal(rows[0].db, 'postgres');
  assert.match(rows[0].usr, /^postgres/);
});

test('test helper creates and removes a user', async () => {
  const id = await createTestUser();
  const { rows } = await query('select username from slenk_notes_users where id = $1', [id]);
  assert.equal(rows.length, 1);
  await dropTestUser(id);
  const after = await query('select 1 from slenk_notes_users where id = $1', [id]);
  assert.equal(after.rows.length, 0);
});
```

- [ ] **Step 5: 加 test script 并跑测试**

在 `server/package.json` 的 `scripts` 加 `"test": "node --test"`，然后：

Run: `npm --prefix server test`
Expected: 2 个测试通过

- [ ] **Step 6: Commit**

```bash
git add server/src/db.js server/src/paths.js server/test/helpers.mjs server/test/db.test.mjs server/package.json
git commit -m "Add pg connection layer, path module and test harness"
```

---

### Task 3: 存储层 —— 用户与偏好

**Files:**
- Modify: `server/src/store.js`（本任务开始把它从 fs 实现重写为数据库实现）
- Create: `server/test/users.test.mjs`

**Interfaces:**
- Consumes: `query`（Task 2）
- Produces:
  - `ensureAdmin() => Promise<void>`
  - `findUserByUsername(username) => Promise<user|null>`，user 形如 `{ id, username, passwordHash, isAdmin, createdAt }`
  - `findUserById(id) => Promise<user|null>`
  - `createUser({ username, passwordHash, isAdmin }) => Promise<user>`
  - `listUsers() => Promise<user[]>`（脱敏，不含 passwordHash）
  - `getActiveProviderIds(userId) => Promise<{ activeProviderId, activeTextProviderId, activeImageProviderId }>`
  - `setActiveProvider(providerId, mode, userId) => Promise<void>`

- [ ] **Step 1: 写失败测试 `server/test/users.test.mjs`**

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { ensureAdmin, findUserByUsername, findUserById, createUser, getActiveProviderIds, setActiveProvider } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('ensureAdmin creates the admin account once', async () => {
  await ensureAdmin();
  await ensureAdmin();
  const admin = await findUserByUsername('admin');
  assert.ok(admin);
  assert.equal(admin.isAdmin, true);
  const { rows } = await query("select count(*)::int as n from slenk_notes_users where username = 'admin'");
  assert.equal(rows[0].n, 1);
});

test('findUserById returns null for an unknown id', async () => {
  assert.equal(await findUserById('nope_does_not_exist'), null);
});

test('createUser inserts a lookup-able user', async () => {
  const username = 'tu_user_' + Math.random().toString(36).slice(2, 8);
  const created = await createUser({ username, passwordHash: 'h', isAdmin: false });
  t.after(() => dropTestUser(created.id));
  const found = await findUserByUsername(username);
  assert.equal(found.id, created.id);
  assert.equal(found.isAdmin, false);
});

test('active provider ids default to null and persist per user', async () => {
  const id = await createTestUser();
  t.after(() => dropTestUser(id));
  const before = await getActiveProviderIds(id);
  assert.deepEqual(before, { activeProviderId: null, activeTextProviderId: null, activeImageProviderId: null });
  await setActiveProvider('prov_x', 'text', id);
  const after = await getActiveProviderIds(id);
  assert.equal(after.activeTextProviderId, 'prov_x');
  assert.equal(after.activeImageProviderId, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- test/users.test.mjs`
Expected: FAIL（`ensureAdmin` 仍是同步 fs 实现，返回 undefined；`createUser` 不存在）

- [ ] **Step 3: 重写 store.js 顶部并实现用户与偏好**

把 `server/src/store.js` 顶部的 fs / dotenv / app.json 读写整段删除，换成：

```js
import './loadEnv.js';
import bcrypt from 'bcryptjs';
import { query } from './db.js';

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin,
    createdAt: row.created_at
  };
}

export async function ensureAdmin() {
  const existing = await query('select id from slenk_notes_users where username = $1', ['admin']);
  if (existing.rows.length) return;
  await query(
    `insert into slenk_notes_users (id, username, password_hash, is_admin)
     values ($1, $2, $3, true) on conflict (username) do nothing`,
    ['admin', 'admin', bcrypt.hashSync('123456', 10)]
  );
  await query('insert into slenk_notes_user_settings (user_id) values ($1) on conflict do nothing', ['admin']);
}

export async function findUserByUsername(username) {
  const { rows } = await query('select * from slenk_notes_users where username = $1', [username]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserById(id) {
  const { rows } = await query('select * from slenk_notes_users where id = $1', [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function createUser({ username, passwordHash, isAdmin = false }) {
  const id = uid('user');
  const { rows } = await query(
    `insert into slenk_notes_users (id, username, password_hash, is_admin)
     values ($1, $2, $3, $4) returning *`,
    [id, String(username).trim(), String(passwordHash), Boolean(isAdmin)]
  );
  await query('insert into slenk_notes_user_settings (user_id) values ($1) on conflict do nothing', [id]);
  return mapUser(rows[0]);
}

export async function listUsers() {
  const { rows } = await query('select id, username, is_admin, created_at from slenk_notes_users order by created_at');
  return rows.map(r => ({ id: r.id, username: r.username, isAdmin: r.is_admin, createdAt: r.created_at }));
}

export async function getActiveProviderIds(userId) {
  const { rows } = await query(
    `select active_provider_id, active_text_provider_id, active_image_provider_id
     from slenk_notes_user_settings where user_id = $1`,
    [userId]
  );
  const row = rows[0] || {};
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
  await query(
    `insert into slenk_notes_user_settings (user_id, ${column}) values ($1, $2)
     on conflict (user_id) do update set ${column} = excluded.${column}`,
    [userId, providerId]
  );
}
```

`column` 由受控常量三选一、不接受外部字符串，因此模板拼接安全；其余值全部参数化。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- test/users.test.mjs`
Expected: PASS（4 个测试）

- [ ] **Step 5: Commit**

```bash
git add server/src/store.js server/test/users.test.mjs
git commit -m "Move users and per-user settings onto Postgres"
```

---

### Task 4: 存储层 —— 任务

**Files:**
- Modify: `server/src/store.js`
- Create: `server/test/tasks.test.mjs`

**Interfaces:**
- Consumes: `query`、`uid`
- Produces:
  - `addTask(task) => Promise<task>`
  - `listTasks(userId, limit = 100) => Promise<task[]>`
  - `getTask(userId, id) => Promise<task|null>`
  - `getTaskById(id) => Promise<task|null>`（worker 只持有 id）
  - `updateTask(id, patch) => Promise<task|null>`
  - `deleteTask(userId, id) => Promise<boolean>`
  - task 形如 `{ id, userId, type, label, status, payload, providerId, tab, result, error, createdAt, updatedAt }`，`payload` / `result` 是**对象**而非 JSON 字符串

- [ ] **Step 1: 写失败测试 `server/test/tasks.test.mjs`**

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.js';
import { addTask, listTasks, getTask, updateTask, deleteTask } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

function seed(userId, id) {
  return addTask({
    id, userId, type: 'image', label: 'Image1', status: 'queued',
    payload: { prompt: 'hello' }, providerId: 'prov_x', tab: 'ai-image'
  });
}

test('addTask stores payload as a jsonb object', async () => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const task = await seed(userId, 'task_a');
  assert.deepEqual(task.payload, { prompt: 'hello' });
  const loaded = await getTask(userId, 'task_a');
  assert.deepEqual(loaded.payload, { prompt: 'hello' });
});

test('tasks are isolated per user', async () => {
  const a = await createTestUser();
  const b = await createTestUser();
  t.after(async () => { await dropTestUser(a); await dropTestUser(b); });
  await seed(a, 'task_a');
  assert.equal((await listTasks(a)).length, 1);
  assert.equal((await listTasks(b)).length, 0);
  assert.equal(await getTask(b, 'task_a'), null);
  assert.equal(await deleteTask(b, 'task_a'), false);
  assert.equal(await deleteTask(a, 'task_a'), true);
});

test('updateTask writes result and bumps updatedAt', async () => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  await seed(userId, 'task_a');
  const updated = await updateTask('task_a', { status: 'done', result: { images: ['/videos/x.png'] } });
  assert.equal(updated.status, 'done');
  assert.deepEqual(updated.result, { images: ['/videos/x.png'] });
  assert.ok(new Date(updated.updatedAt) >= new Date(updated.createdAt));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- test/tasks.test.mjs`
Expected: FAIL（`addTask` 仍是 fs 同步实现，`payload` 返回的是字符串）

- [ ] **Step 3: 实现任务函数（替换原 fs 版本）**

```js
function mapTask(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    label: row.label || '',
    status: row.status,
    payload: row.payload,
    providerId: row.provider_id,
    tab: row.tab,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function addTask(task) {
  const { rows } = await query(
    `insert into slenk_notes_tasks (id, user_id, type, label, status, payload, provider_id, tab, result, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [
      task.id, task.userId, task.type, task.label ?? null, task.status ?? 'queued',
      task.payload ?? null, task.providerId ?? null, task.tab ?? null,
      task.result ?? null, task.error ?? null
    ]
  );
  return mapTask(rows[0]);
}

export async function listTasks(userId, limit = 100) {
  const { rows } = await query(
    'select * from slenk_notes_tasks where user_id = $1 order by created_at desc limit $2',
    [userId, limit]
  );
  return rows.map(mapTask);
}

export async function getTask(userId, id) {
  const { rows } = await query('select * from slenk_notes_tasks where user_id = $1 and id = $2', [userId, id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function getTaskById(id) {
  const { rows } = await query('select * from slenk_notes_tasks where id = $1', [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function updateTask(id, patch) {
  const fields = [];
  const values = [];
  const push = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
  if ('status' in patch) push('status', patch.status);
  if ('result' in patch) push('result', patch.result);
  if ('error' in patch) push('error', patch.error);
  if ('label' in patch) push('label', patch.label);
  if (!fields.length) return getTaskById(id);
  values.push(id);
  const { rows } = await query(
    `update slenk_notes_tasks set ${fields.join(', ')}, updated_at = now()
     where id = $${values.length} returning *`,
    values
  );
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function deleteTask(userId, id) {
  const { rowCount } = await query('delete from slenk_notes_tasks where user_id = $1 and id = $2', [userId, id]);
  return rowCount > 0;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- test/tasks.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: Commit**

```bash
git add server/src/store.js server/test/tasks.test.mjs
git commit -m "Move tasks onto Postgres with per-user isolation"
```

---

### Task 5: 存储层 —— 笔记

**Files:**
- Modify: `server/src/store.js`
- Create: `server/test/notes.test.mjs`

**Interfaces:**
- Consumes: `query`、`uid`
- Produces:
  - `saveNote(userId, note) => Promise<note>`，note 形如 `{ id, userId, title, content, tags, images, createdAt }`
  - `getNote(id) => Promise<note|null>`（**公开读取**，见文首偏差说明）

- [ ] **Step 1: 写失败测试 `server/test/notes.test.mjs`**

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.js';
import { saveNote, getNote } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('saveNote records the owner and round-trips tags and images', async () => {
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

test('getNote stays public so share links keep working', async () => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const saved = await saveNote(userId, { title: 'share me' });
  const loaded = await getNote(saved.id);
  assert.equal(loaded.title, 'share me');
});

test('deleting the owner removes their notes', async () => {
  const userId = await createTestUser();
  const saved = await saveNote(userId, { title: 'cascade' });
  await dropTestUser(userId);
  assert.equal(await getNote(saved.id), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- test/notes.test.mjs`
Expected: FAIL（`saveNote` 仍只接受一个参数）

- [ ] **Step 3: 实现笔记函数（替换原 fs 版本）**

```js
function mapNote(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    tags: row.tags || [],
    images: row.images || [],
    createdAt: row.created_at
  };
}

export async function saveNote(userId, note = {}) {
  const { rows } = await query(
    `insert into slenk_notes_notes (id, user_id, title, content, tags, images)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [
      uid('note'), userId,
      String(note.title || ''), String(note.content || ''),
      Array.isArray(note.tags) ? note.tags : [],
      Array.isArray(note.images) ? note.images : []
    ]
  );
  return mapNote(rows[0]);
}

// 公开读取：/p/<id> 分享页依赖它，id 是随机串不可枚举。
export async function getNote(id) {
  const { rows } = await query('select * from slenk_notes_notes where id = $1', [id]);
  return rows[0] ? mapNote(rows[0]) : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- test/notes.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: Commit**

```bash
git add server/src/store.js server/test/notes.test.mjs
git commit -m "Move notes onto Postgres with an owner column"
```

---

### Task 6: 存储层 —— 供应商（全局）

**Files:**
- Modify: `server/src/store.js`
- Create: `server/test/providers.test.mjs`

**Interfaces:**
- Consumes: `query`、`uid`、`getActiveProviderIds`
- Produces:
  - `listProviders() => Promise<provider[]>`（`apiKey` 已脱敏）
  - `getProviderById(id) => Promise<provider|null>`（脱敏）
  - `getProviderUnmaskedById(id) => Promise<provider|null>`（原值，worker 用这个）
  - `getActiveProvider(mode, userId) => Promise<provider|null>`（返回**未脱敏**）
  - `addProvider(input)`、`updateProvider(id, input)`、`deleteProvider(id)`
  - provider 形如 `{ id, name, providerType, appType, baseUrl, apiKey, mode, textModel, imageModel, notes, active, createdAt, updatedAt }`

- [ ] **Step 1: 写失败测试 `server/test/providers.test.mjs`**

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db.js';
import { listProviders, addProvider, updateProvider, deleteProvider, getActiveProvider, getProviderUnmaskedById } from '../src/store.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => closePool());

test('providers round-trip and mask api keys in list output', async () => {
  const created = await addProvider({
    name: 'Test Prov', baseUrl: 'https://example.com/v1',
    apiKey: 'sk-1234567890abcdef', mode: 'image', imageModel: 'm1'
  });
  t.after(() => deleteProvider(created.id));
  const listed = (await listProviders()).find(p => p.id === created.id);
  assert.notEqual(listed.apiKey, 'sk-1234567890abcdef');
  assert.match(listed.apiKey, /^sk-1/);
  const raw = await getProviderUnmaskedById(created.id);
  assert.equal(raw.apiKey, 'sk-1234567890abcdef');
});

test('updateProvider keeps the existing api key when the input omits it', async () => {
  const created = await addProvider({ name: 'Keep Key', apiKey: 'sk-keepme', mode: 'text' });
  t.after(() => deleteProvider(created.id));
  await updateProvider(created.id, { name: 'Renamed', apiKey: '' });
  const raw = await getProviderUnmaskedById(created.id);
  assert.equal(raw.name, 'Renamed');
  assert.equal(raw.apiKey, 'sk-keepme');
});

test('getActiveProvider prefers the user setting then falls back by mode', async () => {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- test/providers.test.mjs`
Expected: FAIL（`addProvider` 仍是 fs 同步实现）

- [ ] **Step 3: 实现供应商函数（替换原 fs 版本）**

```js
const PROVIDER_COLUMNS = `id, name, provider_type, app_type, base_url, api_key, mode,
  text_model, image_model, notes, is_active, created_at, updated_at`;

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
    notes: row.notes,
    active: row.is_active,
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
    notes: String(input.notes || ''),
    active: Boolean(input.active)
  };
}

export async function listProviders() {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers order by created_at`);
  return rows.map(r => withMaskedKey(mapProvider(r)));
}

export async function getProviderById(id) {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = $1`, [id]);
  return rows[0] ? withMaskedKey(mapProvider(rows[0])) : null;
}

export async function getProviderUnmaskedById(id) {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = $1`, [id]);
  return rows[0] ? mapProvider(rows[0]) : null;
}

export async function addProvider(input) {
  const p = providerValues(input);
  const { rows } = await query(
    `insert into slenk_notes_providers
       (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, notes, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${PROVIDER_COLUMNS}`,
    [p.id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode, p.textModel, p.imageModel, p.notes, p.active]
  );
  return withMaskedKey(mapProvider(rows[0]));
}

export async function updateProvider(id, input) {
  const existing = await getProviderUnmaskedById(id);
  if (!existing) return null;
  const p = providerValues({ ...existing, ...input, id }, id);
  if (!p.apiKey && existing.apiKey) p.apiKey = existing.apiKey;
  const { rows } = await query(
    `update slenk_notes_providers set name=$2, provider_type=$3, app_type=$4, base_url=$5, api_key=$6,
       mode=$7, text_model=$8, image_model=$9, notes=$10, is_active=$11, updated_at = now()
     where id = $1 returning ${PROVIDER_COLUMNS}`,
    [id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode, p.textModel, p.imageModel, p.notes, p.active]
  );
  return withMaskedKey(mapProvider(rows[0]));
}

export async function deleteProvider(id) {
  const { rowCount } = await query('delete from slenk_notes_providers where id = $1', [id]);
  if (rowCount) {
    await query(
      `update slenk_notes_user_settings set
         active_provider_id = case when active_provider_id = $1 then null else active_provider_id end,
         active_text_provider_id = case when active_text_provider_id = $1 then null else active_text_provider_id end,
         active_image_provider_id = case when active_image_provider_id = $1 then null else active_image_provider_id end`,
      [id]
    );
  }
  return rowCount > 0;
}

export async function getActiveProvider(mode, userId) {
  const settings = await getActiveProviderIds(userId);
  const preferredId = mode === 'text' ? settings.activeTextProviderId
    : mode === 'image' ? settings.activeImageProviderId
    : settings.activeProviderId;
  if (preferredId) {
    const preferred = await getProviderUnmaskedById(preferredId);
    if (preferred) return preferred;
  }
  const byMode = await query(
    `select ${PROVIDER_COLUMNS} from slenk_notes_providers where mode = $1 order by created_at limit 1`,
    [mode]
  );
  if (byMode.rows[0]) return mapProvider(byMode.rows[0]);
  const fallback = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers order by created_at limit 1`);
  return fallback.rows[0] ? mapProvider(fallback.rows[0]) : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test -- test/providers.test.mjs`
Expected: PASS（3 个测试）

- [ ] **Step 5: Commit**

```bash
git add server/src/store.js server/test/providers.test.mjs
git commit -m "Move providers onto Postgres as a global table"
```

---

### Task 7: 路由与 worker 接线

**Files:**
- Modify: `server/src/index.js`
- Modify: `server/src/routes/auth.js`
- Modify: `server/src/routes/tasks.js`
- Modify: `server/src/routes/notes.js`
- Modify: `server/src/routes/providers.js`
- Modify: `server/src/routes/upload.js`
- Modify: `server/src/worker.js`

**Interfaces:**
- Consumes: 前四个任务导出的全部存储函数、`paths`（Task 2）
- Produces: 所有 HTTP 路由与队列 worker 正常工作；供应商写操作仅管理员可执行

- [ ] **Step 1: index.js —— await ensureAdmin，路径改从 paths 导入**

```js
import { ensureAdmin } from './store.js';
import { paths } from './paths.js';
// ...
await ensureAdmin();
const uploadsDir = paths.uploadsDir;
const videosDir = paths.videosDir;
```

项目是 ESM，顶层 `await` 可直接使用；`path` / `fs` 的其余用法保留。

- [ ] **Step 2: auth.js —— login 异步化，清掉无用 import**

```js
import { ensureAdmin, findUserByUsername } from '../store.js';

router.post('/login', async (req, res, next) => {
  try {
    await ensureAdmin();
    const { username, password } = req.body;
    const user = await findUserByUsername(username);
    const ok = user && (user.passwordHash ? bcrypt.compareSync(password, user.passwordHash) : password === '123456');
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    res.json({ token: sign(user), user: { username: user.username, id: user.id } });
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: tasks.js —— 全部 await，供应商与任务都带 userId**

```js
const active = await getActiveProvider(mode, userId);
const sameTypeCount = (await listTasks(userId)).filter(t => t.type === type).length + 1;
await addTask({ ... });            // payload 直接传对象，不要 JSON.stringify

router.get('/', async (req, res, next) => {
  try { res.json({ tasks: await listTasks(req.user.userId) }); } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const item = await getTask(req.user.userId, req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json({ task: item });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const removed = await deleteTask(req.user.userId, req.params.id);
    if (!removed) return res.status(404).json({ error: 'task_not_found' });
    res.json({ ok: true, tasks: await listTasks(req.user.userId) });
  } catch (err) { next(err); }
});
```

下载路由里的 `download` handler 同样加 `await getTask(...)`；`dataDir` 相关路径改从 `paths` 取。队列失败分支保持 `error: JSON.stringify({...})`（error 列是 text）。

- [ ] **Step 4: notes.js —— POST 带 userId，公开 GET 不动**

```js
import { saveNote, getNote } from '../store.js';

router.post('/', verify, async (req, res, next) => {
  try {
    const note = await saveNote(req.user.userId, req.body || {});
    res.status(201).json({ id: note.id, url: lanOrigin(req) + '/p/' + note.id });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const note = await getNote(req.params.id);
    if (!note) return res.status(404).json({ error: 'note_not_found' });
    res.json({ note });
  } catch (err) { next(err); }
});
```

- [ ] **Step 5: providers.js —— 加管理员校验并 await**

```js
import { findUserById } from '../store.js';

async function requireAdmin(req, res, next) {
  try {
    const user = await findUserById(req.user.userId);
    if (!user?.isAdmin) return res.status(403).json({ error: 'admin_required' });
    next();
  } catch (err) { next(err); }
}

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const created = await addProvider(req.body);
    res.status(201).json({ provider: created, providers: await listProviders(), ...await getActiveProviderIds(req.user.userId) });
  } catch (err) { next(err); }
});
```

`PUT /:id`、`DELETE /:id` 同样挂 `requireAdmin` 并全部 `await`。`GET /` 不需要管理员，但 `getActiveProviderIds` 改为传 `req.user.userId`。`POST /_models` 里的 `getProviderById` / `getProviderUnmaskedById` 也要 `await`（取 key 时用未脱敏版本）。

- [ ] **Step 6: worker.js —— await，并从 job 取 userId**

```js
import { updateTask, getProviderUnmaskedById, getActiveProvider } from './store.js';

new Worker('ai-tasks', async job => {
  const { id, payload, userId } = job.data;
  const mode = job.name === 'rewrite' ? 'text' : 'image';
  const provider = payload.providerId
    ? (await getProviderUnmaskedById(payload.providerId)) || (await getActiveProvider(mode, userId))
    : await getActiveProvider(mode, userId);
  // ...
  await updateTask(id, { status: 'done', result: { ...result, providerId: provider.id, providerName: provider.name } });
}, { connection, concurrency });
```

四处 `updateTask` 全部加 `await`，`result` 直接传对象。注意必须用 `getProviderUnmaskedById`，`getProviderById` 返回的 key 是脱敏的，会导致调用 AI 接口 401。

- [ ] **Step 7: upload.js —— 路径改从 paths 导入**

```js
import { paths } from '../paths.js';
const uploadDir = paths.uploadsDir;
```

- [ ] **Step 8: 全量测试 + 冒烟**

Run: `npm --prefix server test`
Expected: 全部通过

Run（服务启动后）:
```bash
curl -s -X POST localhost:3001/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"123456"}' | head -c 80
```
Expected: `{"token":"...`

- [ ] **Step 9: Commit**

```bash
git add server/src
git commit -m "Wire routes and worker to the Postgres store"
```

---

### Task 8: 数据迁移

**Files:**
- Create: `server/scripts/migrate-app-json.mjs`

**Interfaces:**
- Consumes: `storage/app.json`、`withTransaction`、`query`（Task 2）、`paths`（Task 2）
- Produces: 现有用户 / 供应商 / 笔记 / 任务写入新表；脚本可重复执行（按主键 upsert）

- [ ] **Step 1: 写迁移脚本 `server/scripts/migrate-app-json.mjs`**

```js
import { withTransaction, closePool, query } from '../src/db.js';
import { paths } from '../src/paths.js';
import fs from 'node:fs';
import path from 'node:path';

function safeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  try { return JSON.stringify(JSON.parse(value)); } catch { return null; }
}

const appJson = path.resolve(paths.dataDir, 'app.json');
if (!fs.existsSync(appJson)) {
  console.error('app.json not found at', appJson);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(appJson, 'utf8'));
const stats = { users: 0, providers: 0, notes: 0, tasks: 0 };

await withTransaction(async client => {
  for (const u of data.users || []) {
    await client.query(
      `insert into slenk_notes_users (id, username, password_hash, is_admin, created_at)
       values ($1,$2,$3,$4,$5)
       on conflict (id) do update set username = excluded.username, password_hash = excluded.password_hash`,
      [u.id, u.username, u.passwordHash || '', u.username === 'admin', u.createdAt || new Date().toISOString()]
    );
    await client.query('insert into slenk_notes_user_settings (user_id) values ($1) on conflict do nothing', [u.id]);
    stats.users += 1;
  }

  for (const p of data.providers || []) {
    await client.query(
      `insert into slenk_notes_providers
         (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, notes, is_active, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (id) do update set name = excluded.name, base_url = excluded.base_url,
         api_key = excluded.api_key, mode = excluded.mode, text_model = excluded.text_model,
         image_model = excluded.image_model, is_active = excluded.is_active, updated_at = now()`,
      [p.id, p.name || 'Custom Provider', p.providerType || 'openai-compatible', p.appType || 'openai',
       p.baseUrl || '', p.apiKey || '', p.mode || 'image', p.textModel || '', p.imageModel || '',
       p.notes || '', Boolean(p.active),
       p.createdAt || new Date().toISOString(), p.updatedAt || new Date().toISOString()]
    );
    stats.providers += 1;
  }

  const adminId = (data.users || []).find(u => u.username === 'admin')?.id;
  const hasSettings = data.activeProviderId || data.activeTextProviderId || data.activeImageProviderId;
  if (adminId && hasSettings) {
    await client.query(
      `update slenk_notes_user_settings
       set active_provider_id = $2, active_text_provider_id = $3, active_image_provider_id = $4
       where user_id = $1`,
      [adminId, data.activeProviderId || null, data.activeTextProviderId || null, data.activeImageProviderId || null]
    );
  }

  for (const n of data.notes || []) {
    if (!adminId) break;
    await client.query(
      `insert into slenk_notes_notes (id, user_id, title, content, tags, images, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set title = excluded.title, content = excluded.content`,
      [n.id, adminId, n.title || '', n.content || '', n.tags || [],
       JSON.stringify(n.images || []), n.createdAt || new Date().toISOString()]
    );
    stats.notes += 1;
  }

  for (const t of data.tasks || []) {
    if (!t.userId) continue;
    await client.query(
      `insert into slenk_notes_tasks
         (id, user_id, type, label, status, payload, provider_id, tab, result, error, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [t.id, t.userId, t.type, t.label || null, t.status || 'queued',
       safeJson(t.payload), t.providerId || null, t.tab || null,
       safeJson(t.result), t.error || null,
       t.createdAt || new Date().toISOString(), t.updatedAt || new Date().toISOString()]
    );
    stats.tasks += 1;
  }
});

const counts = await query(`
  select
    (select count(*)::int from slenk_notes_users) as users,
    (select count(*)::int from slenk_notes_providers) as providers,
    (select count(*)::int from slenk_notes_notes) as notes,
    (select count(*)::int from slenk_notes_tasks) as tasks
`);
console.log('migrated', stats);
console.log('table counts', counts.rows[0]);
await closePool();
```

- [ ] **Step 2: 备份并执行迁移**

Run:
```bash
cp storage/app.json storage/app.json.bak
node server/scripts/migrate-app-json.mjs
```
Expected: 打印 `migrated { users: 1, providers: 2, notes: 13, tasks: 0 }`（数字以实际为准），表计数与之一致

- [ ] **Step 3: 重复执行确认幂等**

Run: `node server/scripts/migrate-app-json.mjs`
Expected: 表计数不变，不产生重复行

- [ ] **Step 4: 对照 API 结果**

Run:
```bash
TOKEN=$(curl -s -X POST localhost:3001/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"123456"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s localhost:3001/api/providers -H "Authorization: Bearer $TOKEN" | head -c 200
```
Expected: 返回与迁移前相同的 2 个 provider

- [ ] **Step 5: Commit**

```bash
git add server/scripts/migrate-app-json.mjs
git commit -m "Add idempotent app.json migration script"
```

---

### Task 9: 端到端验证与文档

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可复现的部署说明与一次完整的端到端验证记录

- [ ] **Step 1: 更新 `.env.example`**

追加：

```
# Supabase: pg direct connection through the Supavisor pooler. URL-encode the password.
DATABASE_URL=postgresql://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
```

- [ ] **Step 2: README 增加数据层一节**

内容包含：数据存 Supabase Postgres；首次部署依次运行 `node server/scripts/apply-schema.mjs` 与 `node server/scripts/migrate-app-json.mjs`；五张表启用 RLS 且无 policy，仅后端可达；`storage/app.json` 与 `storage/app.json.bak` 保留作回滚；启动前需在 `.env` 配好 `DATABASE_URL`。

- [ ] **Step 3: 端到端验证并记录输出**

1. `npm --prefix server test` 全绿
2. `curl -s -X POST localhost:3001/api/auth/login ...` 返回 token
3. `curl -s -X POST https://236963.xyz/api/auth/login ...` 返回 token（公网路径）
4. 浏览器打开 `https://236963.xyz` 登录，侧边栏任务列表与仪表盘总列表都正常
5. `curl -s -o /dev/null -w "%{http_code}" -H "apikey: $SUPABASE_PUBLISHABLE_KEY" "$SUPABASE_URL/rest/v1/slenk_notes_users?select=id&limit=1"` 结果不是 200

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "Document the Supabase data layer and setup steps"
```

---

## 回滚方案

若迁移后出现阻断性问题：`git revert` 到本计划之前的提交，并把 `storage/app.json.bak` 还原为 `storage/app.json`（回滚后的代码只读该文件）。数据库中的表可以留在原地，不影响回滚后的运行。

## Self-Review 记录

**Spec 覆盖：** 表结构与 RLS（Task 1，并在 Step 5 用 publishable key 验证不可达）、存储层异步化与 userId 约束（Task 3-6）、路由与 worker 接线含管理员校验（Task 7）、数据迁移（Task 8）、端到端验证与文档（Task 9）。spec 记录的两项已知限制（`/uploads` 无鉴权、`api_key` 明文）本次不实现，仅保留在文档中。

**与 spec 的偏差：** `getNote` 不加 userId，理由见文首，并由 Task 5 的 `getNote stays public` 测试固化。

**类型一致性：** `payload` / `result` 全程为对象（Task 4 定义，Task 7 使用）；`getProviderById` 返回脱敏、`getProviderUnmaskedById` 返回原值，worker 必须用后者（Task 7 Step 6 已点明，误用会导致 AI 接口 401）；`listTasks(userId, limit)` 与 `getTask(userId, id)` 的参数顺序在所有任务中一致；`setActiveProvider(providerId, mode, userId)` 与路由层的调用顺序一致。
