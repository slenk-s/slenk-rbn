# Slenk Notes 多账号小红书授权与用户隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 2026-11-13 修订：五项开放问题已拍板，同步进本计划——openId 按用户各自绑定（不做全局唯一）；待绑定账号先入库（`open_id` 可空）；删除账号时用户选择是否清磁盘凭证（默认清）；管理员只读跨用户查看（仅 API）；前端只给脱敏路径 hint；扫码冲突时清理本次待绑定行与新凭证目录。

**Goal:** 将 Slenk Notes 的小红书授权从「本机单共享账号」升级为「每个 Slenk 用户可绑定多个独立小红书账号，用户之间完全隔离，扫码后自动匹配凭证，并按账号发布」。

**Architecture:** 服务端新增账号绑定表与注册表，CLI 封装支持按账号注入 `SKILLHUB_UPLOAD_HOME` 独立凭证目录，授权状态机由全局单例改为 per-user / per-account 隔离；前端授权卡片改为账号列表，发布弹框增加账号选择器；扫码完成后用登录返回的 `openId` 自动匹配并落库。

**Tech Stack:** Node.js ES modules、Express、React 19、Node `child_process`、`node:test`、现有 Bearer JWT、Supabase Postgres、redapp CLI 1.0.x。

**设计文档:** `docs/superpowers/specs/2026-11-12-xhs-multi-account-user-isolation-design.md`

## Global Constraints

- 凭证目录是唯一隔离单位：`credential_dir` 由服务端生成，每账号一个目录，绝不共享。
- 所有账号 CRUD / 状态查询 / 发布都必须以 `req.user.userId` 过滤，禁止跨用户访问（管理员只读接口除外，且只读）。
- openId 唯一性按用户：`unique(user_id, open_id)`；**不同用户绑定同一 openId 是允许的**。
- 待绑定账号先入库：`open_id` 可空，扫码成功回填。
- 永远不返回 access token、refresh token、完整 openId、credential_dir 绝对路径；前端只给目录尾段 hint。
- 每个 CLI 业务命令前先通过版本门禁；只有 `CLI_VERSION_JSON.status=current|installed|updated` 才继续。
- 同用户同一时刻最多一个登录会话；不同用户可并行。
- 扫码自动匹配：登录返回 `openId` 后，当前用户未绑定则回填落库，已绑定返回 conflict 并清理本次待绑定行与新凭证目录。
- 授权成功后自动重放原发布请求一次；失败不得循环重试。
- 自动测试不得退出或破坏任何真实 redapp 登录。
- `storage/` 已在 `.gitignore`，凭证目录不得放仓库其他位置。

---

## 文件结构

### 新建

- `server/src/lib/xhsAccountRegistry.js`：账号绑定注册表（list/get/createPending/bindOpenId/findByOpenId/delete/resolveDir）。
- `server/src/lib/xhsAccountMatcher.js`：扫码后 openId 自动匹配与冲突清理逻辑。
- `server/test/xhsAccountRegistry.test.mjs`：注册表、隔离、匹配、冲突、待绑定测试。
- `server/test/xhsAccountIsolation.test.mjs`：per-user / per-account 状态机隔离测试。
- `web/test/xhsAccountUi.test.mjs`：账号列表、账号选择器 UI 纯函数测试。

### 修改

- `server/scripts/schema.sql`：新增 `slenk_notes_xhs_accounts` 表 + 索引 + RLS revoke；`slenk_notes_users` 补 `role` 列（若无）。
- `server/src/store.js`：新增账号表读写函数（含 pending 插入与 openId 回填）。
- `server/src/lib/redappCli.js`：`createRedappNpmEnv` 支持 `credentialHome`；spawn/run/operations 透传。
- `server/src/lib/redappAuth.js`：状态机 per-user / per-account 化。
- `server/src/routes/redappAuth.js`：账号 CRUD + 按账号状态接口 + 管理员只读接口。
- `server/src/routes/publish.js`：发布带 `accountId`，按账号凭证目录执行。
- `server/src/index.js`：无新挂载（复用 `/api/redapp/auth`），仅确认。
- `web/src/redappAuthFlow.js`：请求体带 `accountId`；会话按账号轮询。
- `web/src/RedappAuth.jsx`：卡片改账号列表（含待绑定条目）+ 添加账号 + 每账号操作 + 删除确认勾选。
- `web/src/App.jsx`：发布弹框账号选择器（过滤待绑定）；提交带 `accountId`。
- `README.md` / `SETUP.md` / `AGENTS.md`：更新授权说明。

---

### Task 1: CLI 凭证目录注入

**Files:**
- Modify: `server/src/lib/redappCli.js`
- Test: `server/test/xhsAccountRegistry.test.mjs`

**Interfaces:**
- `createRedappNpmEnv(platform, { credentialHome })` 设置 `SKILLHUB_UPLOAD_HOME`。
- `spawnRedappLogin({ credentialHome })` 用该目录启动 login。
- `runRedappCommandAsync(args, { credentialHome, ... })` 透传。
- `uploadPackageAsync(zipPath, { credentialHome, ... })` / `createPreviewAsync({ credentialHome, ... })` 透传。

- [ ] **Step 1: 写失败测试：注入 credentialHome 后 env 含 SKILLHUB_UPLOAD_HOME**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedappNpmEnv, createAsyncProcessRunner } from '../src/lib/redappCli.js';

test('injects SKILLHUB_UPLOAD_HOME when credentialHome is set', () => {
  const env = createRedappNpmEnv('win32', { credentialHome: 'C:/auth/u1/acct1' });
  assert.equal(env.SKILLHUB_UPLOAD_HOME, 'C:/auth/u1/acct1');
});

test('omits SKILLHUB_UPLOAD_HOME when credentialHome is absent', () => {
  const env = createRedappNpmEnv('win32');
  assert.equal('SKILLHUB_UPLOAD_HOME' in env, false);
});
```

- [ ] **Step 2: 运行测试，确认因 env 未支持而失败**

Run:

```bash
cd server && node --test test/xhsAccountRegistry.test.mjs
```

Expected: FAIL，`createRedappNpmEnv` 签名不支持 `credentialHome`。

- [ ] **Step 3: 实现注入**

在 `redappCli.js`：

```js
export function createRedappNpmEnv(platform = process.platform, { credentialHome } = {}) {
  const env = {
    ...process.env,
    NPM_CONFIG_PREFIX: NPM_PREFIX,
    NPM_CONFIG_CACHE: NPM_CACHE,
    PATH: (platform === 'win32' ? NPM_PREFIX : path.join(NPM_PREFIX, 'bin')) + path.delimiter + process.env.PATH
  };
  if (credentialHome) env.SKILLHUB_UPLOAD_HOME = credentialHome;
  return env;
}
```

将 `npmEnv()` 改为接受 `{ credentialHome }` 并透传给 `spawnNode` / `spawnNodeAsync`。同步改 `spawnRedappLogin`、`runRedappCommandUngated`、`runRedappCommandUngatedAsync`、`createAsyncProcessRunner` 的 `spawnProcess` 调用，让 `credentialHome` 能传到每个 CLI 子进程的 env。

`createRedappOperationsAsync` 的 `uploadPackageAsync` / `createPreviewAsync` 增加 `credentialHome`，透传给 `dryRunThenConfirm` 的 `runCommand`。

- [ ] **Step 4: 运行测试并确认通过**

```bash
cd server && node --test test/xhsAccountRegistry.test.mjs test/redappAuth.test.mjs
```

Expected: 新增 2 个 PASS，现有 redappAuth 测试不回归。

- [ ] **Step 5: 提交**

```bash
git add server/src/lib/redappCli.js server/test/xhsAccountRegistry.test.mjs
git commit -m "feat: inject per-account credential home into redapp CLI"
```

---

### Task 2: 数据库账号绑定表与注册表

**Files:**
- Modify: `server/scripts/schema.sql`
- Modify: `server/src/store.js`
- Create: `server/src/lib/xhsAccountRegistry.js`
- Create: `server/test/xhsAccountRegistry.test.mjs`

**Interfaces:**
- SQL: `slenk_notes_xhs_accounts` 表（`open_id` 可空）+ `unique(user_id, open_id)` + `credential_dir` 全局唯一；`slenk_notes_users` 补 `role` 列。
- `createXhsAccountRegistry(deps)` 返回 `listForUser/getForUser/createPendingForUser/bindOpenIdForUser/findByOpenIdForUser/deleteForUser/resolveCredentialDir`。

- [ ] **Step 1: 写失败测试：隔离、待绑定与冲突**

```js
test('lists only own accounts and rejects cross-user access', async () => {
  // 注入 fake store：A 用户两个账号，B 用户一个账号。
  const registry = createXhsAccountRegistry({ listForUser: async uid => uid === 'a' ? [a1, a2] : [b1], ... });
  assert.deepEqual(await registry.listForUser('a'), [a1, a2]);
  assert.equal(await registry.getForUser('a', 'b-acct'), null);
});

test('creates pending account with null openId, then binds openId', async () => {
  const pending = await registry.createPendingForUser('a', { credentialDir: 'd1' });
  assert.equal(pending.openId, null);
  const bound = await registry.bindOpenIdForUser('a', pending.id, { openId: 'ob1' });
  assert.equal(bound.openId, 'ob1');
});

test('rejects duplicate openId for same user but allows it across users', async () => {
  await assert.rejects(
    () => registry.bindOpenIdForUser('a', 'acct-2', { openId: 'ob1' }),
    { code: 'XHS_ACCOUNT_DUPLICATE' }
  );
  // 用户 b 绑定同一 openId 不冲突
  const b = await registry.bindOpenIdForUser('b', 'b-acct', { openId: 'ob1' });
  assert.equal(b.openId, 'ob1');
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```bash
cd server && node --test test/xhsAccountRegistry.test.mjs
```

Expected: FAIL，`xhsAccountRegistry.js` 不存在。

- [ ] **Step 3: 实现 schema 与 store 函数**

`schema.sql` 追加：

```sql
create table if not exists slenk_notes_xhs_accounts (
  id text primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  credential_dir text not null unique,
  open_id text,                          -- 扫码回填；NULL 表示待绑定
  nickname text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, open_id)              -- NULL 互不冲突，允许同用户多个待绑定
);
create index if not exists slenk_notes_xhs_accounts_user_idx
  on slenk_notes_xhs_accounts (user_id, created_at desc);
alter table slenk_notes_xhs_accounts enable row level security;
revoke all on slenk_notes_xhs_accounts from anon, authenticated;
revoke all on slenk_notes_xhs_accounts from public;

-- 管理员只读接口的角色前提
alter table slenk_notes_users add column if not exists role text not null default 'user';
```

`store.js` 新增：

```js
export async function listXhsAccounts(userId) { ... }
export async function getXhsAccount(userId, id) { ... }
export async function createXhsAccountPending(userId, { id, credentialDir }) { ... }   // open_id 为 NULL
export async function bindXhsAccountOpenId(userId, id, { openId, nickname }) { ... }   // 回填；23505 → XHS_ACCOUNT_DUPLICATE
export async function findXhsAccountByOpenId(userId, openId) { ... }
export async function deleteXhsAccount(userId, id) { ... }                             // 返回被删行（含 credential_dir）供清理
export async function listAllXhsAccounts() { ... }                                     // 管理员只读，按 user 分组
```

全部用户接口带 `user_id` 条件；`bindXhsAccountOpenId` 捕获 `23505`（unique_violation）映射为 `XHS_ACCOUNT_DUPLICATE`。

`xhsAccountRegistry.js` 实现注册表；`resolveCredentialDir(userId, accountId)` 返回 `credentialDir` 或 `null`（待绑定账号同样可解析，用于发起登录）；`deleteForUser(userId, accountId, { deleteCredentials })` 在 `deleteCredentials` 为 true 时删除磁盘目录。

- [ ] **Step 4: 运行测试并确认通过**

```bash
cd server && node --test test/xhsAccountRegistry.test.mjs test/db.test.mjs
```

Expected: PASS；db 测试若依赖真实库则跳过（只跑纯逻辑部分）。

- [ ] **Step 5: 提交**

```bash
git add server/scripts/schema.sql server/src/store.js server/src/lib/xhsAccountRegistry.js server/test/xhsAccountRegistry.test.mjs
git commit -m "feat: add per-user xhs account binding registry"
```

---

### Task 3: 授权状态机 per-user / per-account 化

**Files:**
- Modify: `server/src/lib/redappAuth.js`
- Modify: `server/test/redappAuth.test.mjs`
- Create: `server/test/xhsAccountIsolation.test.mjs`

**Interfaces:**
- `createRedappAuthManager(deps)` 新增 `onLoginDone` 回调。
- 方法改为 `getStatus(userId, accountId)` / `startLogin(userId, accountId, credentialDir)` / `getSession(userId, accountId, sessionId)` / `cancelLogin(userId, accountId, sessionId)` / `logout(userId, accountId, credentialDir)`。

- [ ] **Step 1: 写失败测试：同用户单会话锁 + 跨用户并行**

```js
test('blocks concurrent login for same user but allows different users', async () => {
  // 用户 a 启动 account1，再次 startLogin('a','account2') 抛 XHS_LOGIN_BUSY；
  // 用户 b 启动 account1 成功，spawnCount 独立。
});
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd server && node --test test/xhsAccountIsolation.test.mjs
```

Expected: FAIL，方法签名不匹配。

- [ ] **Step 3: 重构状态机**

将 `let active` / `sessions` 改为：

```js
const users = new Map(); // userId -> { active: Session|null, sessions: Map<accountId, Session>, lock: boolean }
```

`startLogin(userId, accountId, credentialDir)`：

- 若该用户已有 `active` 且非当前账号 → 抛 `XHS_LOGIN_BUSY`。
- 若当前账号已有 active 会话 → 复用。
- 用 `credentialDir` 调 `spawnCli({ credentialHome: credentialDir })`。
- `handleLine` 的 `RESULT_JSON` 登录成功时，调 `deps.onLoginDone({ userId, accountId, credentialDir, openId: result.credentials.openId })` 后再 `finish('done')`。

`logout(userId, accountId, credentialDir)` 用该目录执行 `runCli(['logout'], { credentialHome: credentialDir })`。

- [ ] **Step 4: 运行全部授权测试并确认通过**

```bash
cd server && node --test test/redappAuth.test.mjs test/xhsAccountIsolation.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/lib/redappAuth.js server/test/redappAuth.test.mjs server/test/xhsAccountIsolation.test.mjs
git commit -m "feat: isolate redapp login sessions per user and account"
```

---

### Task 4: 扫码自动匹配与冲突清理

**Files:**
- Create: `server/src/lib/xhsAccountMatcher.js`
- Modify: `server/src/routes/redappAuth.js`
- Modify: `server/test/xhsAccountRegistry.test.mjs`

**Interfaces:**
- `matchLoginToAccount({ userId, accountId, credentialDir, openId, registry })` 返回 `{ matched, conflict?, existingId?, accountId }`。

- [ ] **Step 1: 写失败测试：未绑定回填 / 已绑定冲突并清理**

```js
test('binds openId on first scan and cleans up pending row on conflict', async () => {
  // 首次扫码：pending 行回填 openId → matched
  // 扫已绑定账号：返回 conflict + existingId，且本次 pending 行与新 credentialDir 被删除
});
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd server && node --test test/xhsAccountRegistry.test.mjs
```

Expected: FAIL，`xhsAccountMatcher.js` 不存在。

- [ ] **Step 3: 实现匹配器与路由接线**

`xhsAccountMatcher.js` 实现 `matchLoginToAccount`：

- `existing && existing.id !== accountId` → `registry.deleteForUser(userId, accountId, { deleteCredentials: true })`，返回 `{ matched: false, conflict: true, existingId }`。
- `existing && existing.id === accountId` → 已绑定账号重新扫码，返回 `{ matched: true, accountId }`，不改库。
- 无匹配 → `registry.bindOpenIdForUser(userId, accountId, { openId })` 回填；并发撞 unique 映射为 `XHS_ACCOUNT_DUPLICATE`。

匹配只在当前用户范围内进行；其他用户是否绑过同一 openId 不影响。

`routes/redappAuth.js` 在 manager 的 `onLoginDone` 回调里调用匹配器，把匹配结果写入会话 `auth.match`。

- [ ] **Step 4: 运行测试并确认通过**

```bash
cd server && node --test test/xhsAccountRegistry.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/lib/xhsAccountMatcher.js server/src/routes/redappAuth.js server/test/xhsAccountRegistry.test.mjs
git commit -m "feat: auto-match scanned xhs account to user binding"
```

---

### Task 5: 账号 CRUD API、管理员只读与发布按账号

**Files:**
- Modify: `server/src/routes/redappAuth.js`
- Modify: `server/src/routes/publish.js`
- Modify: `server/src/index.js`（仅确认无新挂载）
- Modify: `server/test/redappAuth.test.mjs`

**Interfaces:**
- `GET /api/redapp/accounts` / `POST /api/redapp/accounts`（插入 pending 行）/ `DELETE /api/redapp/accounts/:id?deleteCredentials=true`。
- `GET /api/redapp/admin/accounts`：管理员只读，按用户分组脱敏列表；非管理员 403 `XHS_ADMIN_REQUIRED`。
- 现有状态接口带 `accountId` query，校验归属。
- `POST /api/publish/minitool` 请求体带 `accountId`。

- [ ] **Step 1: 写失败测试**

```js
test('publish returns AUTH_REQUIRED with accountId before building', async () => { ... });
test('publish rejects accountId not owned by user', async () => {
  // 返回 404 XHS_ACCOUNT_NOT_FOUND
});
test('admin endpoint returns all users masked accounts, 403 for non-admin', async () => { ... });
test('delete with deleteCredentials=false keeps credential dir', async () => { ... });
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd server && node --test test/redappAuth.test.mjs
```

Expected: FAIL。

- [ ] **Step 3: 实现路由与发布校验**

`routes/redappAuth.js`：

- 增加三个账号路由；`POST /accounts` 调 `createPendingForUser` 并返回 `{ id, status: 'pending_bind', credentialDirHint }`。
- `DELETE /accounts/:id`：`deleteCredentials` 默认 true，调 `registry.deleteForUser`。
- `GET /admin/accounts`：校验 `req.user.role === 'admin'`，否则 403 `XHS_ADMIN_REQUIRED`；返回按 `userId` 分组的脱敏 DTO（与列表 DTO 相同字段，不含 token/完整 openId/绝对路径）。
- 现有 `/`、`/login`、`/session/:id`、`/logout` 均从 `req.query.accountId` 取账号并先校验归属（不属于当前用户 → 404）。

`routes/publish.js` 的 `createMiniToolPublishHandler`：

- `canonicalizeMiniToolPublishRequest` 增加 `accountId` 字段校验。
- 发布前 `registry.resolveCredentialDir(req.user.userId, accountId)`；无 → 404。
- `authManager.getStatus(userId, accountId)` / `startLogin(userId, accountId, credentialDir)`。
- `buildMiniToolZip` / `uploadPackage` / `createPreview` 传 `credentialHome: credentialDir`。

- [ ] **Step 4: 运行测试与语法检查**

```bash
cd server && node --test test/redappAuth.test.mjs test/xhsAccountRegistry.test.mjs
node --check src/routes/redappAuth.js
node --check src/routes/publish.js
```

Expected: 全部 PASS / 无语法错误。

- [ ] **Step 5: 提交**

```bash
git add server/src/routes/redappAuth.js server/src/routes/publish.js server/test/redappAuth.test.mjs
git commit -m "feat: expose per-account xhs auth APIs and account-bound publish"
```

---

### Task 6: 前端账号列表与账号选择器

**Files:**
- Modify: `web/src/redappAuthFlow.js`
- Modify: `web/src/RedappAuth.jsx`
- Modify: `web/src/App.jsx`
- Modify: `web/src/App.css`
- Create: `web/test/xhsAccountUi.test.mjs`

**Interfaces:**
- `createRedappAuthClient` 增加 `listAccounts()` / `createAccount()` / `deleteAccount(id, { deleteCredentials })`。
- `RedappAuthCard` 改账号列表（含 `pending_bind` 条目）；删除确认含「同时删除凭证文件」勾选（默认勾选）。
- 发布弹框账号选择器（只列 `bound` 账号）；`publishWithAuth` 请求体带 `accountId`。

- [ ] **Step 1: 写失败测试：请求体保留 accountId + 选择器过滤待绑定**

```js
test('publish request snapshot preserves accountId', () => {
  const req = createPublishRequestSnapshot({ title, content, tags, images, accountId: 'acct-1' });
  assert.equal(req.accountId, 'acct-1');
});

test('account picker excludes pending_bind accounts', () => {
  const options = buildPublishAccountOptions([
    { id: 'a1', status: 'bound', openIdMasked: 'ob5c…fa90' },
    { id: 'a2', status: 'pending_bind', openIdMasked: null },
  ]);
  assert.deepEqual(options.map(o => o.id), ['a1']);
});
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd web && node --test test/xhsAccountUi.test.mjs
```

Expected: FAIL，`createPublishRequestSnapshot` 不保留 accountId / 选择器函数不存在。

- [ ] **Step 3: 实现前端逻辑**

`redappAuthFlow.js`：

- `createPublishRequestSnapshot` 增加 `accountId`。
- `createRedappAuthClient` 增加三个账号方法（`deleteAccount` 带 `deleteCredentials` query）。
- `publishWithAuth` 的发布与轮询按账号上下文传递。
- 抽出纯函数 `buildPublishAccountOptions(accounts)`（过滤 `pending_bind`）便于测试。

`RedappAuth.jsx`：

- 卡片改为账号列表渲染；`pending_bind` 条目显示「待扫码」并突出「扫码绑定」按钮。
- 「添加小红书账号」按钮调 `createAccount` 并立即对该账号发起扫码。
- 每账号显示状态/到期/掩码 openId/操作；删除二次确认弹框含「同时删除凭证文件」勾选（默认勾选），按勾选调 `deleteAccount(id, { deleteCredentials })`。

`App.jsx`：发布确认弹框 `publishConfirm` 里，「扫码直达」下方加账号选择器（`buildPublishAccountOptions` 的结果）；无已绑定账号时显示「去绑定账号」并禁用扫码直达；提交时把 `accountId` 放进快照。

`App.css`：账号列表行卡、待绑定样式、选择器、添加按钮、删除确认勾选样式。

- [ ] **Step 4: 运行前端测试与构建**

```bash
cd web && npm test
npm run build
```

Expected: 全部 PASS；Vite build 成功。

- [ ] **Step 5: 提交**

```bash
git add web/src/redappAuthFlow.js web/src/RedappAuth.jsx web/src/App.jsx web/src/App.css web/test/xhsAccountUi.test.mjs
git commit -m "feat: multi-account xhs auth UI and publish account picker"
```

---

### Task 7: 文档更新、安全回归与旧数据迁移策略

**Files:**
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-11-12-xhs-multi-account-user-isolation-design.md`（仅必要差异）

**Interfaces:** 无新 API。

- [ ] **Step 1: 运行服务端单元测试**

```bash
cd server && node --test test/redappAuth.test.mjs test/xhsAccountRegistry.test.mjs test/xhsAccountIsolation.test.mjs
```

Expected: 全部 PASS；不运行依赖本地库 5433 的全量套件。

- [ ] **Step 2: 运行前端测试与构建**

```bash
cd web && npm test && npm run build
```

Expected: 全部 PASS。

- [ ] **Step 3: 安全扫描**

```bash
rg -n "accessToken|refreshToken|credential_dir|credentialDir" server/src/routes web/src
```

Expected: 授权 API/前端无敏感字段；允许测试 fixture、sanitize 删除逻辑与 `credentialDirHint`（仅尾段）出现。

- [ ] **Step 4: 验证 per-user 隔离与当前真实账号**

- A 用户账号列表不含 B 用户账号。
- 未绑定账号（只有 pending 或完全没有）时扫码直达禁用。
- 不执行真实 logout，不破坏现有凭证。

- [ ] **Step 5: 更新文档**

README/SETUP/AGENTS 写明：用户各自管理自己的小红书账号、多账号绑定、扫码自动匹配、按账号发布、凭证目录在 `storage/auth/` 或 `SLENK_XHS_AUTH_ROOT`、删除账号默认清理磁盘凭证（可勾选保留）、管理员只读接口。

- [ ] **Step 6: 最终 diff、提交与推送**

```bash
git diff --check
git status --short
git add README.md SETUP.md AGENTS.md server/src server/test web/src web/test docs/superpowers
git commit -m "docs: document per-user multi-account xhs authorization"
git push origin master
```

Expected: commit 成功；push 成功或如实报告网络失败。

---

## 最终验收清单

- [ ] 用户 A 完全看不到用户 B 的账号与发布状态。
- [ ] 一个用户可绑定多个小红书账号，每个独立凭证目录。
- [ ] 待绑定账号（open_id NULL）出现在列表并标记「待扫码」。
- [ ] 同用户重复绑定同一 openId 被拒绝（409）；**不同用户绑定同一 openId 允许**。
- [ ] 扫码后 openId 自动匹配并回填落库，无需手动填账号；冲突时清理本次待绑定行与新目录。
- [ ] 同用户同时只一个登录会话；不同用户可并行。
- [ ] 发布时选择账号（待绑定条目不出现在选择器），按对应凭证目录执行 whoami/upload/preview。
- [ ] 无权限 accountId 返回 404。
- [ ] 删除账号默认删除磁盘凭证，可勾选仅解绑保留。
- [ ] 管理员只读接口返回全量脱敏数据，非管理员 403，管理员无任何操作接口。
- [ ] 前端/API 永不出现 token、完整 openId、credential_dir 绝对路径（hint 只给尾段）。
- [ ] 现有单共享凭证不被动退出；迁移策略已文档化。
