# Redapp 本机授权中心实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Slenk Notes 增加本机共享的 redapp 授权中心，使所有 Slenk 用户可扫码登录、查看脱敏状态、重新授权/退出，并在“扫码直达”未登录时授权成功后自动继续原发布请求。

**Architecture:** 服务端新增独立授权状态机，唯一持有 CLI 登录子进程与短期二维码会话；现有 `redappCli.js` 扩展为可注入/可测试的 CLI 执行层。前端新增授权 API 客户端与纯逻辑自动续发控制器，再在仪表盘和笔记发布弹框接入；凭证仍完全由 redapp CLI 保管。

**Tech Stack:** Node.js ES modules、Express、React 19、Node `child_process`、`node:test`、现有 Bearer JWT、redapp CLI 1.0.x。

## Global Constraints

- 所有 Slenk 用户共享并可管理运行 server 的 Windows 用户下的一份 redapp 凭证。
- 永远不读取或返回 access token、refresh token、完整 openId、凭证文件路径。
- 任何 redapp 业务命令前先通过版本门禁；只有 `CLI_VERSION_JSON.status=current|installed|updated` 才继续。
- redapp CLI 使用 `storage/redapp-npm/` 的进程级 npm prefix/cache，不永久修改 npm 配置。
- 同一时间最多一个登录会话；并发登录请求复用同一 sessionId。
- 授权成功后自动重放原扫码直达请求一次；失败时不得循环重试。
- 服务重启后不恢复正在扫码的临时会话或浏览器内待发布请求。
- 自动测试不得退出或破坏当前真实 redapp 登录。

---

## 文件结构

### 新建

- `server/src/lib/redappAuth.js`：登录状态机、CLI 行解析、脱敏 DTO、会话生命周期。
- `server/src/routes/redappAuth.js`：授权状态、登录会话、取消、退出 API。
- `server/test/redappAuth.test.mjs`：状态机、脱敏、并发、取消、过期测试（注入假 CLI）。
- `web/src/redappAuthFlow.js`：前端 API 客户端与“授权成功后仅重放一次”纯逻辑控制器。
- `web/test/redappAuthFlow.test.mjs`：自动续发、失败、去重测试。

### 修改

- `server/src/lib/redappCli.js`：公开安全的 CLI 执行/解析接口，并支持异步 spawn 注入。
- `server/src/routes/publish.js`：小工具发布前检查登录，未登录返回结构化 `AUTH_REQUIRED`。
- `server/src/index.js`：挂载 `/api/redapp/auth`。
- `web/src/App.jsx`：仪表盘授权卡片、授权弹框、扫码直达自动续发。
- `web/src/App.css`：授权卡片、二维码与状态样式。

---

### Task 1: 抽取可测试的 Redapp CLI 输出解析与安全 DTO

**Files:**
- Modify: `server/src/lib/redappCli.js`
- Test: `server/test/redappAuth.test.mjs`

**Interfaces:**
- Produces: `parseTaggedOutput(output: string): { prompts: object[], results: object[] }`
- Produces: `sanitizeCredentials(credentials: object): AuthStatusDTO`
- Produces: `runRedappCommand(args: string[], options?): RedappResult`
- `AuthStatusDTO`: `{ available, loggedIn, openIdMasked, scope, expireTimeMs, refreshExpireTimeMs, needsReauth, error? }`

- [ ] **Step 1: 写失败测试：解析输出且不泄露 token**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaggedOutput, sanitizeCredentials } from '../src/lib/redappCli.js';

test('parses PROMPT and RESULT_JSON lines', () => {
  const parsed = parseTaggedOutput([
    'PROMPT:{"type":"auth_device_code","userCode":"ABCD-EFGH"}',
    'RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openId":"ob1234567890","accessToken":"secret","refreshToken":"secret2","scope":"base_info,skill_publish","expireTimeMs":"1794"}}'
  ].join('\n'));
  assert.equal(parsed.prompts[0].userCode, 'ABCD-EFGH');
  assert.equal(parsed.results[0].status, 'ok');
});

test('sanitizes credentials and never serializes tokens', () => {
  const dto = sanitizeCredentials({
    loggedIn: true,
    openId: 'ob1234567890',
    accessToken: 'secret',
    refreshToken: 'secret2',
    scope: 'base_info,skill_publish',
    expireTimeMs: '1794'
  });
  assert.equal(dto.openIdMasked, 'ob12…7890');
  assert.deepEqual(dto.scope, ['base_info', 'skill_publish']);
  assert.equal(JSON.stringify(dto).includes('secret'), false);
  assert.equal('accessToken' in dto, false);
  assert.equal('refreshToken' in dto, false);
});
```

- [ ] **Step 2: 运行测试，确认因导出不存在而失败**

Run:

```bash
cd server && node --test test/redappAuth.test.mjs
```

Expected: FAIL，提示 `parseTaggedOutput` 或 `sanitizeCredentials` 未导出。

- [ ] **Step 3: 实现最小解析与脱敏函数**

在 `server/src/lib/redappCli.js` 增加：

```js
export function parseTaggedOutput(output) {
  const prompts = [];
  const results = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    for (const [tag, target] of [['PROMPT:', prompts], ['RESULT_JSON:', results]]) {
      if (!line.startsWith(tag)) continue;
      try { target.push(JSON.parse(line.slice(tag.length))); } catch {}
    }
  }
  return { prompts, results };
}

function maskOpenId(value) {
  const s = String(value || '');
  if (!s) return null;
  if (s.length <= 8) return s.slice(0, 2) + '…' + s.slice(-2);
  return s.slice(0, 4) + '…' + s.slice(-4);
}

export function sanitizeCredentials(credentials = {}) {
  const expireTimeMs = Number(credentials.expireTimeMs) || null;
  return {
    available: true,
    loggedIn: Boolean(credentials.loggedIn),
    openIdMasked: maskOpenId(credentials.openId),
    scope: String(credentials.scope || '').split(',').map(s => s.trim()).filter(Boolean),
    expireTimeMs,
    refreshExpireTimeMs: Number(credentials.refreshExpireTimeMs) || null,
    needsReauth: !credentials.loggedIn || (expireTimeMs !== null && expireTimeMs <= Date.now())
  };
}
```

将内部 `runRedapp` 改名并导出为：

```js
export function runRedappCommand(args, { timeoutMs = 120000 } = {}) { /* 保持现有同步逻辑 */ }
```

保留现有 upload/preview 调用兼容。

- [ ] **Step 4: 运行测试并确认通过**

Run:

```bash
cd server && node --test test/redappAuth.test.mjs
```

Expected: PASS 2 tests。

- [ ] **Step 5: 提交**

```bash
git add server/src/lib/redappCli.js server/test/redappAuth.test.mjs
git commit -m "test: add safe redapp output parsing"
```

---

### Task 2: 实现单例登录会话状态机

**Files:**
- Create: `server/src/lib/redappAuth.js`
- Modify: `server/test/redappAuth.test.mjs`

**Interfaces:**
- Consumes: `ensureRedappCli()`, `parseTaggedOutput()`, `sanitizeCredentials()`
- Produces: `createRedappAuthManager({ spawnCli, runCli, readFile, now, randomId, setTimer, clearTimer })`
- Manager methods: `getStatus()`, `startLogin()`, `getSession(id)`, `cancelLogin(id)`, `logout()`, `dispose()`

- [ ] **Step 1: 写失败测试：并发复用、PROMPT、done 脱敏**

在 `server/test/redappAuth.test.mjs` 增加 fake child（EventEmitter + stdout PassThrough）并测试：

```js
test('reuses one active login session and sanitizes completion', async () => {
  const fake = createFakeChild();
  let spawnCount = 0;
  const manager = createRedappAuthManager({
    spawnCli: () => { spawnCount++; return fake; },
    runCli: () => ({ status: 'ok', credentials: { loggedIn: false } }),
    readFile: () => Buffer.from('png'),
    now: () => 1000,
    randomId: () => 'session-1'
  });
  const first = manager.startLogin();
  const second = manager.startLogin();
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(spawnCount, 1);

  fake.stdout.write('PROMPT:{"type":"auth_device_code","qrCodePath":"x.png","authorizeH5Url":"https://auth","userCode":"ABCD","expiresInSeconds":600}\n');
  await tick();
  assert.equal(manager.getSession('session-1').status, 'waiting_scan');
  assert.match(manager.getSession('session-1').qrImage, /^data:image\/png;base64,/);

  fake.stdout.write('RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openId":"ob1234567890","accessToken":"hidden","scope":"base_info,skill_publish"}}\n');
  fake.emit('close', 0);
  await tick();
  const done = manager.getSession('session-1');
  assert.equal(done.status, 'done');
  assert.equal(JSON.stringify(done).includes('hidden'), false);
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```bash
cd server && node --test test/redappAuth.test.mjs
```

Expected: FAIL，`redappAuth.js` 不存在。

- [ ] **Step 3: 实现最小状态机**

`redappAuth.js` 内：

```js
export function createRedappAuthManager(deps) {
  let active = null;
  const sessions = new Map();

  function publicSession(session) {
    return {
      sessionId: session.id,
      status: session.status,
      qrImage: session.qrImage || null,
      authorizeUrl: session.authorizeUrl || null,
      userCode: session.userCode || null,
      expiresAt: session.expiresAt || null,
      auth: session.auth || null,
      error: session.error || null
    };
  }

  function startLogin() {
    if (active && ['waiting_prompt', 'waiting_scan'].includes(active.status)) return publicSession(active);
    // spawn CLI；逐行处理 PROMPT/RESULT_JSON；最多保留脱敏字段
  }

  return { getStatus, startLogin, getSession, cancelLogin, logout, dispose };
}
```

规则：

- `PROMPT`：读取 qrCodePath 后立刻转 data URL；不在 DTO 保留本地路径。
- `expiresAt = now() + min(expiresInSeconds, 600) * 1000`。
- `RESULT_JSON status=ok && credentials.loggedIn=true` → `done`。
- close 前无 done → `failed`。
- timeout → kill child、`expired`。
- 终态保留 5 分钟供前端读取，之后清理 Map。

- [ ] **Step 4: 写并验证取消/过期/异常退出测试**

测试至少覆盖：

```js
assert.equal(manager.cancelLogin('session-1').status, 'cancelled');
assert.equal(fake.killed, true);
assert.equal(manager.getSession('missing'), null);
```

用可控 timer 注入触发 expired，断言进程已 kill。

Run:

```bash
cd server && node --test test/redappAuth.test.mjs
```

Expected: 所有授权状态机测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add server/src/lib/redappAuth.js server/test/redappAuth.test.mjs
git commit -m "feat: add singleton redapp login sessions"
```

---

### Task 3: 增加授权 API 并接入发布前登录检查

**Files:**
- Create: `server/src/routes/redappAuth.js`
- Modify: `server/src/index.js`
- Modify: `server/src/routes/publish.js`
- Modify: `server/test/redappAuth.test.mjs`

**Interfaces:**
- API: `GET /api/redapp/auth`
- API: `POST /api/redapp/auth/login`
- API: `GET /api/redapp/auth/session/:id`
- API: `POST /api/redapp/auth/session/:id/cancel`
- API: `POST /api/redapp/auth/logout`
- `POST /api/publish/minitool` returns HTTP 401 `{ code: 'AUTH_REQUIRED', auth: SessionDTO }`

- [ ] **Step 1: 写失败测试：未登录发布返回结构化 AUTH_REQUIRED**

将 `publish.js` 的业务处理器抽成可注入函数：

```js
export function createMiniToolPublishHandler({ authManager, buildMiniToolZip, uploadPackage, createPreview }) { /* ... */ }
```

测试：

```js
test('minitool publish returns AUTH_REQUIRED before building files', async () => {
  let built = false;
  const handler = createMiniToolPublishHandler({
    authManager: {
      getStatus: () => ({ available: true, loggedIn: false }),
      startLogin: () => ({ sessionId: 's1', status: 'waiting_scan' })
    },
    buildMiniToolZip: async () => { built = true; }
  });
  const response = await invokeHandler(handler, validRequest());
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'AUTH_REQUIRED');
  assert.equal(response.body.auth.sessionId, 's1');
  assert.equal(built, false);
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```bash
cd server && node --test test/redappAuth.test.mjs
```

Expected: FAIL，工厂函数不存在或发布仍先构建。

- [ ] **Step 3: 实现授权 Router**

`server/src/routes/redappAuth.js`：

```js
router.use(verify);
router.get('/', asyncHandler(async (req, res) => res.json(await authManager.getStatus())));
router.post('/login', asyncHandler(async (req, res) => res.json(authManager.startLogin())));
router.get('/session/:id', (req, res) => {
  const session = authManager.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  res.json(session);
});
router.post('/session/:id/cancel', asyncHandler(async (req, res) => res.json(await authManager.cancelLogin(req.params.id))));
router.post('/logout', asyncHandler(async (req, res) => res.json(await authManager.logout())));
```

导出单例 `authManager` 和 router。

- [ ] **Step 4: 在 `index.js` 挂载路由**

```js
import { router as redappAuthRoutes } from './routes/redappAuth.js';
app.use('/api/redapp/auth', redappAuthRoutes);
```

- [ ] **Step 5: 修改 publish 检查顺序**

在任何 build/audit/upload 前：

```js
const auth = await authManager.getStatus();
if (!auth.available) return res.status(503).json({ error: auth.error, code: 'REDAPP_UNAVAILABLE' });
if (!auth.loggedIn) {
  return res.status(401).json({
    error: '需要连接小红书后继续',
    code: 'AUTH_REQUIRED',
    auth: authManager.startLogin()
  });
}
```

- [ ] **Step 6: 运行测试与语法检查**

Run:

```bash
cd server && node --test test/redappAuth.test.mjs
node --check src/lib/redappAuth.js
node --check src/routes/redappAuth.js
node --check src/routes/publish.js
```

Expected: 全部 PASS / 无输出错误。

- [ ] **Step 7: 提交**

```bash
git add server/src/routes/redappAuth.js server/src/index.js server/src/routes/publish.js server/test/redappAuth.test.mjs
git commit -m "feat: expose redapp authorization APIs"
```

---

### Task 4: 实现前端授权 API 与单次自动续发控制器

**Files:**
- Create: `web/src/redappAuthFlow.js`
- Create: `web/test/redappAuthFlow.test.mjs`

**Interfaces:**
- Produces: `createRedappAuthClient({ api, pollMs })`
- Produces: `publishWithAuth({ publish, pollSession, onAuthRequired, onAuthorized })`
- `publishWithAuth` 最多调用 `publish` 两次（初次 + 登录成功后一次）

- [ ] **Step 1: 写失败测试：AUTH_REQUIRED 后只重放一次**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { publishWithAuth } from '../src/redappAuthFlow.js';

test('replays publish exactly once after login succeeds', async () => {
  let calls = 0;
  const result = await publishWithAuth({
    publish: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('auth'), { code: 'AUTH_REQUIRED', auth: { sessionId: 's1' } });
      return { ok: true };
    },
    pollSession: async () => ({ status: 'done' }),
    onAuthRequired: () => {},
    onAuthorized: () => {}
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('does not loop when replay also returns AUTH_REQUIRED', async () => {
  let calls = 0;
  await assert.rejects(() => publishWithAuth({
    publish: async () => { calls++; throw Object.assign(new Error('auth'), { code: 'AUTH_REQUIRED', auth: { sessionId: 's1' } }); },
    pollSession: async () => ({ status: 'done' }),
    onAuthRequired: () => {},
    onAuthorized: () => {}
  }));
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: 运行并确认失败**

Run:

```bash
cd web && node --test test/redappAuthFlow.test.mjs
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现最小纯逻辑控制器**

```js
export async function publishWithAuth({ publish, pollSession, onAuthRequired, onAuthorized }) {
  try {
    return await publish();
  } catch (err) {
    if (err.code !== 'AUTH_REQUIRED' || !err.auth?.sessionId) throw err;
    onAuthRequired(err.auth);
    const session = await pollSession(err.auth.sessionId);
    if (session.status !== 'done') throw Object.assign(new Error(session.error || '授权未完成'), { code: 'AUTH_NOT_COMPLETED' });
    onAuthorized(session);
    return publish();
  }
}
```

`createRedappAuthClient` 实现状态、login、session、cancel、logout 请求；API error 必须保留 `code` 和 `auth` 字段：

```js
export async function readApiError(response) {
  const body = await response.json().catch(() => ({}));
  return Object.assign(new Error(body.error || response.statusText), body);
}
```

- [ ] **Step 4: 增加失败/取消/过期测试并运行**

覆盖 `failed`、`expired`、`cancelled`，断言不重放 publish。

Run:

```bash
cd web && npm test
```

Expected: 现有测试 + 新测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/redappAuthFlow.js web/test/redappAuthFlow.test.mjs
git commit -m "test: add redapp publish resume flow"
```

---

### Task 5: 增加仪表盘授权卡片与共享管理动作

**Files:**
- Modify: `web/src/App.jsx`
- Modify: `web/src/App.css`

**Interfaces:**
- Consumes: `createRedappAuthClient()`
- Produces UI: `RedappAuthCard`, `RedappAuthModal`

- [ ] **Step 1: 在 `App.jsx` 增加 `RedappAuthCard`**

组件状态：

```js
const [auth, setAuth] = useState({ available: true, loggedIn: false });
const [loading, setLoading] = useState(true);
const [session, setSession] = useState(null);
const [confirmLogout, setConfirmLogout] = useState(false);
```

行为：

- mount 时 GET 状态。
- 连接/重新授权：POST login，打开 modal。
- 退出：两步确认，第二次点击才 POST logout。
- 卡片始终显示“本机共享授权”提示。

- [ ] **Step 2: 实现授权弹框与轮询**

展示二维码/链接/授权码/倒计时；每 1500ms 查询 session。终态停止轮询，done 后刷新卡片状态并关闭弹框（仪表盘主动授权不触发发布）。

- [ ] **Step 3: 在 Dashboard 挂载授权卡片**

修改签名：

```js
function Dashboard({ token, me, ..., setMessage })
```

在 ProviderManager 同级或其下方加入：

```jsx
<RedappAuthCard token={token} setMessage={setMessage} />
```

所有用户都可见，不套 `me?.isAdmin`。

- [ ] **Step 4: 添加样式**

`App.css` 添加 `.redapp-auth-card`、`.auth-status-dot`、`.auth-qr-modal`、`.auth-shared-warning`；复用现有 `prompt-config-backdrop`、按钮与二维码样式，避免另造视觉系统。

- [ ] **Step 5: 构建并 Browser Preview 验证**

Run:

```bash
cd web && npm run build
```

Expected: Vite build 成功。

Browser Preview：

- 仪表盘显示当前登录状态。
- 不出现完整 openId/token。
- 二次退出确认可取消。
- 当前已登录账号不会被测试代码退出。

- [ ] **Step 6: 提交**

```bash
git add web/src/App.jsx web/src/App.css
git commit -m "feat: add shared redapp authorization card"
```

---

### Task 6: 接入“扫码直达”授权弹框与自动续发

**Files:**
- Modify: `web/src/App.jsx`
- Modify: `web/src/App.css`
- Modify: `web/test/redappAuthFlow.test.mjs`

**Interfaces:**
- Consumes: `publishWithAuth()`、`createRedappAuthClient()`
- Existing API payload remains `{ title, content, tags, images }`

- [ ] **Step 1: 修改 `submitMinitoolPublish` 使用纯逻辑控制器**

保存不可变请求快照：

```js
const request = {
  title: String(title),
  content: String(content),
  tags: [...tags],
  images: [...publishImages]
};
```

调用：

```js
await publishWithAuth({
  publish: () => api('/api/publish/minitool', { method: 'POST', body: JSON.stringify(request) }),
  pollSession: waitForRedappSession,
  onAuthRequired: auth => setRedappLogin({ open: true, ...auth, mode: 'resume-publish' }),
  onAuthorized: () => setStatus('授权成功，正在继续发布…')
});
```

- [ ] **Step 2: 让 `api()` 保留结构化错误**

当前 `NoteRewriteWorkspace.api()` 只抛 message；改为：

```js
if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), data, { status: r.status });
```

这样 `AUTH_REQUIRED` 的 `code/auth` 不会丢失。

- [ ] **Step 3: 授权弹框复用 Card Modal**

将 `RedappAuthModal` 抽成共享组件；发布模式 done 后不立即显示成功提示，而由 `publishWithAuth` 继续，最终显示小工具预览二维码。

取消时：

- 调用 session cancel API。
- `publishWithAuth` 抛 `AUTH_NOT_COMPLETED`。
- 保留标题、正文、标签、图片和渠道选择。

- [ ] **Step 4: 运行前端测试和构建**

Run:

```bash
cd web && npm test
npm run build
```

Expected: 所有测试 PASS；Vite build 成功。

- [ ] **Step 5: Browser Preview 验证已登录路径**

- 选“扫码直达”。
- 当前已登录时直接上传并显示笔记预览二维码。
- 不出现授权弹框。
- 控制台无错误。

- [ ] **Step 6: 提交**

```bash
git add web/src/App.jsx web/src/App.css web/test/redappAuthFlow.test.mjs
git commit -m "feat: resume scan publish after redapp login"
```

---

### Task 7: 服务端安全回归、真实状态验证与文档

**Files:**
- Modify: `README.md`
- Modify: `SETUP.md`
- Modify: `docs/superpowers/specs/2026-11-11-redapp-local-auth-center-design.md`（仅在实现与规格有必要差异时更新）

**Interfaces:**
- No new API.

- [ ] **Step 1: 运行服务端单元测试**

```bash
cd server && node --test test/redappAuth.test.mjs test/referenceImages.test.mjs
```

Expected: 全部 PASS。避免运行依赖未启动本地测试库 5433 的全量数据库套件。

- [ ] **Step 2: 运行前端测试与构建**

```bash
cd web && npm test && npm run build
```

Expected: 全部 PASS。

- [ ] **Step 3: 安全扫描 API 响应与代码**

```bash
rg -n "accessToken|refreshToken" server/src/routes web/src
```

Expected: 授权 API/前端无 token 字段；允许测试 fixture 与 `sanitizeCredentials` 删除逻辑出现。

实际请求：

```bash
curl -H "Authorization: Bearer <LOCAL_TEST_JWT>" http://localhost:3001/api/redapp/auth
```

Expected: JSON 不含 `accessToken` / `refreshToken` / 完整凭证路径。

- [ ] **Step 4: 验证当前真实登录但不执行退出**

- 授权卡片显示 `loggedIn=true`。
- openId 仅为掩码。
- “扫码直达”正常生成预览二维码。
- 不执行真实 logout，不破坏当前凭证。

- [ ] **Step 5: 更新部署文档**

README/SETUP 写明：

- 安装包不包含 `.skillhub-upload/`。
- 新机器首次发布会扫码授权。
- 所有 Slenk 用户共享同一 Windows 用户凭证。
- 卸载默认保留凭证；退出授权会影响所有用户。

- [ ] **Step 6: 最终 diff、提交与推送**

```bash
git diff --check
git status --short
git add README.md SETUP.md server/src server/test web/src web/test
git commit -m "docs: document local redapp authorization"
git push origin master
```

Expected: commit 成功；push 成功或如实报告 GitHub 网络失败。

---

## 最终验收清单

- [ ] CLI 版本门禁失败时不会继续业务命令。
- [ ] 前端/API 永远不出现 token 或完整 openId。
- [ ] 已登录状态可查看，凭证仍由 CLI 管理。
- [ ] 并发登录只启动一个 CLI 子进程。
- [ ] 授权二维码/链接/授权码可展示并有倒计时。
- [ ] 授权成功自动继续原扫码直达且只重放一次。
- [ ] 取消/过期/失败不丢笔记表单、不循环上传。
- [ ] 所有用户均可查看、登录、重新授权、退出。
- [ ] UI 明示共享授权会影响本机所有用户。
- [ ] 真实凭证未被自动测试退出或修改。
