# ECS 云端部署（方案 A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Slenk Notes 部署到阿里云 ECS（Windows Server），通过 `https://236963.xyz:8443` 提供多人可用的 HTTPS 服务，进程全部 NSSM 服务化。

**Architecture:** Caddy（DNS-01 证书 + 反代）作为唯一公网入口反代 Express API（Express 已内置 web/dist 静态托管与 SPA 回退，比 spec 又少一层）；Redis/API/Worker/Caddy 四个 NSSM Windows 服务；服务器侧用 `XHS_PUBLISH_ENABLED=false` 禁用发布渠道；CORS 白名单收紧。

**Tech Stack:** Node 22 LTS、Express、BullMQ、tporadowski Redis 5.x、NSSM、Caddy（cloudflare DNS 插件定制构建）、node:test。

## Global Constraints（来自 spec，全部任务隐含遵守）

- 公网仅暴露 `8443/TCP`；API `3001` 与 Redis `6379` 只绑 `127.0.0.1`。
- 域名 `236963.xyz`，Cloudflare 灰云 DNS 直连；证书 Let's Encrypt DNS-01（CF Token 仅 `Zone.DNS:Edit` 单 zone）。
- 新环境变量：`XHS_PUBLISH_ENABLED`（默认 `true`，服务器设 `false`）、`CORS_ORIGINS`（默认 `PUBLIC_URL` + `http://localhost:5173`）、`HOST`（默认 `127.0.0.1`）。
- 发布禁用响应统一为 `409 { error: '发布功能已在服务器上禁用，请到本地机器发布', code: 'PUBLISH_DISABLED' }`；前端 `api()` 帮助函数直接 `throw new Error(data.error)` 并由现有 `setStatus` 展示，故前端零改动。
- 服务名固定：`slenk-caddy` / `slenk-redis` / `slenk-api` / `slenk-worker`；日志重定向到仓库 `logs/` 目录。
- 测试一律 `npm --prefix server test`（node:test）；提交信息遵循仓库现有 conventional commits 风格。
- spec：`docs/superpowers/specs/2026-11-13-ecs-cloud-deployment-design.md`。

---

### Task 1: `httpConfig` 模块 + index.js 接线（HOST 回环绑定 + CORS 白名单）

**Files:**
- Create: `server/src/lib/httpConfig.js`
- Create: `server/test/httpConfig.test.mjs`
- Modify: `server/src/index.js:59`（cors 行）和 `server/src/index.js:94-95`（listen 行）

**Interfaces:**
- Consumes: 无（纯 env 函数）。
- Produces: `hostFromEnv(env = process.env): string`、`corsOrigins(env = process.env): string[]`、`corsOptions(env = process.env): object`（形如 cors 包的 options，供 `app.use(cors(...))`）。

**背景（实现者需知）：** `server/src/index.js` 顶层有副作用（连库、启动 janitor），不能在测试里 import；所以把可测逻辑抽到纯函数模块。cors 包的 `origin` 回调签名是 `(origin, callback)`；同源/无 Origin 头的请求（curl、SPA 同源）`origin` 为 `undefined`，必须放行。

- [ ] **Step 1: 写失败测试**

```js
// server/test/httpConfig.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostFromEnv, corsOrigins, corsOptions } from '../src/lib/httpConfig.js';

test('hostFromEnv 默认 127.0.0.1，HOST 可覆盖', () => {
  assert.equal(hostFromEnv({}), '127.0.0.1');
  assert.equal(hostFromEnv({ HOST: '0.0.0.0' }), '0.0.0.0');
});

test('corsOrigins 默认 = PUBLIC_URL + 本地 dev 5173', () => {
  assert.deepEqual(corsOrigins({}), ['http://localhost:5173']);
  assert.deepEqual(corsOrigins({ PUBLIC_URL: 'https://236963.xyz:8443' }),
    ['https://236963.xyz:8443', 'http://localhost:5173']);
});

test('corsOrigins 用 CORS_ORIGINS 覆盖默认值', () => {
  assert.deepEqual(corsOrigins({ CORS_ORIGINS: 'https://a.example, https://b.example' }),
    ['https://a.example', 'https://b.example']);
});

test('corsOptions：无 Origin 放行，白名单内放行，白名单外拒绝', () => {
  const opts = corsOptions({ PUBLIC_URL: 'https://236963.xyz:8443' });
  let cb = (err, ok) => { assert.equal(err, null); assert.equal(ok, true); };
  opts.origin(undefined, cb);
  opts.origin('https://236963.xyz:8443', cb);
  let denied = false;
  opts.origin('https://evil.example', (err, ok) => { denied = !ok; });
  assert.equal(denied, true);
  assert.equal(opts.credentials, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test`
Expected: FAIL —— `Cannot find module '.../server/src/lib/httpConfig.js'`

- [ ] **Step 3: 实现**

```js
// server/src/lib/httpConfig.js
// 部署配置纯函数：HOST 绑定与 CORS 白名单。index.js 顶层有副作用无法直接单测，
// 逻辑集中在这里。服务器部署默认只监听回环，公网流量一律经 Caddy 反代进来。
export function hostFromEnv(env = process.env) {
  return env.HOST || '127.0.0.1';
}

export function corsOrigins(env = process.env) {
  const fromEnv = (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const origins = [];
  if (env.PUBLIC_URL) origins.push(env.PUBLIC_URL);
  // 本地 dev：浏览器经 Vite proxy 访问 API 时 Origin 是 5173，白名单缺了它本地就打不开。
  origins.push('http://localhost:5173');
  return origins;
}

export function corsOptions(env = process.env) {
  const allowed = new Set(corsOrigins(env));
  return {
    credentials: true,
    origin(origin, cb) {
      // 无 Origin 头 = 同源请求或 curl 直连，放行；拦截交给鉴权层。
      if (!origin || allowed.has(origin)) return cb(null, true);
      return cb(null, false);
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test`
Expected: PASS（新文件 4 个 test，且既有全部 test 仍绿）

- [ ] **Step 5: 接线 index.js**

`server/src/index.js` 第 3 行后加 import；第 59 行与第 94-95 行替换：

```js
// import 区（第 3 行 cors import 之后）加入：
import { hostFromEnv, corsOptions } from './lib/httpConfig.js';

// 第 59 行：
app.use(cors(corsOptions()));

// 第 94-95 行替换为：
const port = Number(process.env.PORT || 3001);
const host = hostFromEnv();
app.listen(port, host, () => console.log(`server listening on ${host}:${port}`));
```

- [ ] **Step 6: 全量测试 + 手动冒烟**

Run: `npm --prefix server test`
Expected: PASS
Run: `npm --prefix server run dev`（本机），浏览器打开 `http://localhost:3001/api/health`
Expected: `{"ok":true,"app":"slenk-notes"}`；Ctrl+C 停止。

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/httpConfig.js server/test/httpConfig.test.mjs server/src/index.js
git commit -m "feat: bind API to loopback by default and add CORS allowlist"
```

---

### Task 2: 发布渠道开关 `XHS_PUBLISH_ENABLED`

**Files:**
- Create: `server/test/publishDisabled.test.mjs`
- Modify: `server/src/routes/publish.js`（import 区 + 三个接线点，见 Step 3）

**Interfaces:**
- Consumes: Task 1 无依赖。
- Produces: `createPublishDisabledMiddleware({ isDisabled } = {}) => (req, res, next)`（DI 注入便于测试）；模块级 `publishDisabledMiddleware`。`isDisabled` 默认 `() => process.env.XHS_PUBLISH_ENABLED === 'false'`。

**背景（实现者需知）：** 两个发布渠道的 HTTP 入口都在 `server/src/routes/publish.js`：草稿箱是 `router.post('/', ...)`（第 22 行起，入 BullMQ 队列，worker 端 `headless: false` 弹 Chrome）；扫码直达是 `router.post('/minitool', ...)`（第 350 行）与工厂 `createMiniToolPublishRouter`（第 342 行，测试里也用）。在 HTTP 入口拦截即可，任务根本不进队列，worker 不需要改动。前端 `api()` 帮助函数对非 2xx `throw new Error(data.error)`，现有 `setStatus(...)` 会把中文错误原文展示给用户，前端零改动。

- [ ] **Step 1: 写失败测试**

```js
// server/test/publishDisabled.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublishDisabledMiddleware } from '../src/routes/publish.js';

function call(mw, done) {
  return new Promise(resolve => {
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } };
    mw({}, res, () => resolve({ next: true }));
  });
}

test('isDisabled=true 时返回 409 PUBLISH_DISABLED', async () => {
  const mw = createPublishDisabledMiddleware({ isDisabled: () => true });
  const result = await call(mw);
  assert.equal(result.code, 409);
  assert.equal(result.body.code, 'PUBLISH_DISABLED');
  assert.equal(result.body.error, '发布功能已在服务器上禁用，请到本地机器发布');
});

test('isDisabled=false 时放行 next', async () => {
  const mw = createPublishDisabledMiddleware({ isDisabled: () => false });
  assert.equal((await call(mw)).next, true);
});

test('默认 isDisabled 读 XHS_PUBLISH_ENABLED', async () => {
  const saved = process.env.XHS_PUBLISH_ENABLED;
  try {
    process.env.XHS_PUBLISH_ENABLED = 'false';
    const mw = createPublishDisabledMiddleware();
    assert.equal((await call(mw)).code, 409);
    process.env.XHS_PUBLISH_ENABLED = 'true';
    assert.equal((await createPublishDisabledMiddleware()({}, {}, () => {}) && true), true);
  } finally { if (saved === undefined) delete process.env.XHS_PUBLISH_ENABLED; else process.env.XHS_PUBLISH_ENABLED = saved; }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test`
Expected: FAIL —— `createPublishDisabledMiddleware is not a function`（import 自 publish.js 但未导出）

- [ ] **Step 3: 实现**

`server/src/routes/publish.js` 在 `export const router = Router();`（第 19 行）之后加入：

```js
// 部署在云服务器时用 XHS_PUBLISH_ENABLED=false 关闭两个发布渠道：
// worker 在哪台机器上，弹出的 Chrome 就在哪台机器上；服务器没有桌面会话。
// 在 HTTP 入口拦下，任务不进队列。前端把 error 原文展示给用户。
export function createPublishDisabledMiddleware({ isDisabled = () => process.env.XHS_PUBLISH_ENABLED === 'false' } = {}) {
  return (req, res, next) => {
    if (isDisabled()) return res.status(409).json({ error: '发布功能已在服务器上禁用，请到本地机器发布', code: 'PUBLISH_DISABLED' });
    next();
  };
}
export const publishDisabledMiddleware = createPublishDisabledMiddleware();
```

三个接线点（同文件）：

1. 草稿箱入口，第 22 行 `router.post('/', async (req, res, next) => {` 改为：
   ```js
   router.post('/', publishDisabledMiddleware, async (req, res, next) => {
   ```
2. 扫码直达入口，第 350 行 `router.post('/minitool', miniToolPublishHandler);` 改为：
   ```js
   router.post('/minitool', publishDisabledMiddleware, miniToolPublishHandler);
   ```
3. 工厂 `createMiniToolPublishRouter`（第 342-348 行）内的 `miniRouter.post('/', createMiniToolPublishHandler({ registry, ...dependencies }));` 改为：
   ```js
   miniRouter.post('/', publishDisabledMiddleware, createMiniToolPublishHandler({ registry, ...dependencies }));
   ```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix server test`
Expected: PASS（新 3 个 test + 既有 publishJobs 测试全绿——注意既有测试里凡 `POST /api/publish/minitool` 的用例默认 env 未设开关，不受影响）

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/publish.js server/test/publishDisabled.test.mjs
git commit -m "feat: add XHS_PUBLISH_ENABLED switch to disable publish channels server-side"
```

---

### Task 3: 部署脚本 —— Caddyfile + deploy-server.ps1

**Files:**
- Create: `scripts/deploy/Caddyfile`
- Create: `scripts/deploy/deploy-server.ps1`

**Interfaces:**
- Consumes: 无代码接口。
- Produces: `deploy-server.ps1 -CfToken <token> [-Root C:\slenk-notes] [-Domain 236963.xyz] [-HttpsPort 8443] [-CheckOnly]`，幂等：服务已存在则跳过注册、依赖已装则跳过安装。

**背景（实现者需知）：** 全部在服务器（管理员 PowerShell）运行。Node/Git/Redis/NSSM/Caddy 五个依赖全部走静默安装，下载地址优先官方 API（GitHub releases API、nodejs.org dist index、caddyserver.com download API），失败给出明确错误。Windows Server 没有 winget，不要用。Caddy 反代到 3001，**静态托管交给 Express**（index.js:80-84 已有 web/dist + SPA 回退），Caddyfile 里没有 root/file_server。

- [ ] **Step 1: 写 Caddyfile**

```
# scripts/deploy/Caddyfile —— ECS 唯一公网入口。
# 证书 DNS-01（Cloudflare），不占用 80 端口，避开大陆节点未备案域名拦截。
# 静态 web/dist 由 Express（index.js）托管，这里只做 TLS 终结 + 反代。
# CF_API_TOKEN 由 NSSM 服务环境变量注入（deploy-server.ps1 设置）。
https://236963.xyz:8443 {
	tls {
		dns cloudflare {env.CF_API_TOKEN}
	}
	encode gzip
	reverse_proxy 127.0.0.1:3001
}
```

- [ ] **Step 2: 写 deploy-server.ps1**

```powershell
# scripts/deploy/deploy-server.ps1 —— ECS 首次部署主脚本（管理员 PowerShell 运行）。
# 幂等：依赖已装则跳过安装，服务已注册则跳过注册。脚本不建仓库：先 git clone 再跑本脚本。
# 用法：.\deploy-server.ps1 -CfToken <Cloudflare Zone.DNS:Edit token> [-Root C:\slenk-notes] [-Domain 236963.xyz] [-HttpsPort 8443] [-CheckOnly]
param(
  [Parameter(Mandatory = $true)] [string] $CfToken,
  [string] $Root = 'C:\slenk-notes',
  [string] $Domain = '236963.xyz',
  [int] $HttpsPort = 8443,
  [string] $ToolsDir = 'C:\slenk-tools',
  [switch] $CheckOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Fail($m)  { Write-Host "  ERR  $m" -ForegroundColor Red; exit 1 }
function Get-LatestAsset($repo, $nameLike) {
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
  $asset = $rel.assets | Where-Object { $_.name -like $nameLike } | Select-Object -First 1
  if (-not $asset) { Fail "GitHub $repo 找不到资产匹配 $nameLike" }
  return $asset.browser_download_url
}

if (-not (Test-Path (Join-Path $Root 'server\src\index.js'))) { Fail "$Root 不是 Slenk Notes 仓库，请先 git clone 并进入目录运行。" }
if (-not (Test-Path (Join-Path $Root '.env'))) { Fail "$Root\.env 缺失：从本机复制并按 RUNBOOK 修改后再运行。" }
Set-Location -LiteralPath $Root
if ($CheckOnly) { $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + $env:PATH }

# --- 1. 依赖安装（已装跳过）----------------------------------------------
Step '检查/安装依赖：Node / Git / Redis / NSSM / Caddy'
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
if (-not $nodeExe) {
  if ($CheckOnly) { Fail 'Node 未安装（-CheckOnly 模式不执行安装）' }
  Step '安装 Node.js LTS（MSI 静默）'
  $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
  $msi = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
  $tmp = Join-Path $env:TEMP (Split-Path $msi -Leaf)
  Invoke-WebRequest $msi -OutFile $tmp
  Start-Process msiexec -ArgumentList '/i', $tmp, '/qn', '/norestart' -Wait
  $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + $env:PATH
  $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
  if (-not $nodeExe) { Fail 'Node 安装后仍未找到 node.exe' }
}
Ok "Node: $nodeExe"

$gitExe = (Get-Command git.exe -ErrorAction SilentlyContinue)?.Source
if (-not $gitExe) {
  if ($CheckOnly) { Fail 'Git 未安装（-CheckOnly 模式不执行安装）' }
  Step '安装 Git for Windows（静默）'
  $url = Get-LatestAsset 'git-for-windows/git' '*64-bit.exe'
  $tmp = Join-Path $env:TEMP (Split-Path $url -Leaf)
  Invoke-WebRequest $url -OutFile $tmp
  Start-Process $tmp -ArgumentList '/VERYSILENT', '/NORESTART' -Wait
  $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + $env:PATH
  $gitExe = (Get-Command git.exe -ErrorAction SilentlyContinue)?.Source
  if (-not $gitExe) { Fail 'Git 安装失败' }
}
Ok "Git: $gitExe"

New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null
$redisDir = Join-Path $ToolsDir 'redis'
$redisServer = Join-Path $redisDir 'redis-server.exe'
if (-not (Test-Path $redisServer)) {
  if ($CheckOnly) { Fail 'Redis 未安装（-CheckOnly 模式不执行安装）' }
  Step '下载 Redis for Windows（tporadowski 移植版）'
  $url = Get-LatestAsset 'tporadowski/redis' '*.zip'
  $tmp = Join-Path $env:TEMP 'redis-tporadowski.zip'
  Invoke-WebRequest $url -OutFile $tmp
  Expand-Archive $tmp -DestinationPath $redisDir -Force
  $redisServer = (Get-ChildItem $redisDir -Recurse -Filter redis-server.exe | Select-Object -First 1).FullName
  $redisDir = Split-Path $redisServer
}
Ok "Redis: $redisServer"

$nssmExe = Join-Path $ToolsDir 'nssm\nssm.exe'
if (-not (Test-Path $nssmExe)) {
  if ($CheckOnly) { Fail 'NSSM 未安装（-CheckOnly 模式不执行安装）' }
  Step '下载 NSSM'
  $tmp = Join-Path $env:TEMP 'nssm-2.24.zip'
  Invoke-WebRequest 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $tmp
  Expand-Archive $tmp -DestinationPath (Join-Path $ToolsDir 'nssm-extract') -Force
  $nssmExe = (Get-ChildItem (Join-Path $ToolsDir 'nssm-extract') -Recurse -Filter nssm.exe | Where-Object FullName -like '*win64*' | Select-Object -First 1).FullName
  $dst = Join-Path $ToolsDir 'nssm'; New-Item -ItemType Directory -Path $dst -Force | Out-Null
  Copy-Item $nssmExe (Join-Path $dst 'nssm.exe'); $nssmExe = Join-Path $dst 'nssm.exe'
}
Ok "NSSM: $nssmExe"

$caddyExe = Join-Path $ToolsDir 'caddy\caddy.exe'
if (-not (Test-Path $caddyExe)) {
  if ($CheckOnly) { Fail 'Caddy 未安装（-CheckOnly 模式不执行安装）' }
  Step '下载 Caddy（含 cloudflare DNS 插件定制构建）'
  $tmp = Join-Path $env:TEMP 'caddy-custom.zip'
  Invoke-WebRequest 'https://caddyserver.com/api/download?os=windows&arch=amd64&p=github.com%2Fcaddy-dns%2Fcloudflare' -OutFile $tmp
  Expand-Archive $tmp -DestinationPath (Join-Path $ToolsDir 'caddy') -Force
}
Ok "Caddy: $caddyExe"

# --- 2. 构建 ----------------------------------------------------------------
Step '安装 npm 依赖 + 构建前端'
if (-not $CheckOnly) {
  if (-not (Test-Path 'server\node_modules')) { & npm --prefix server install --no-audit --no-fund; if ($LASTEXITCODE) { Fail 'server npm install 失败' } }
  if (-not (Test-Path 'web\node_modules'))  { & npm --prefix web install --no-audit --no-fund;   if ($LASTEXITCODE) { Fail 'web npm install 失败' } }
  & npm --prefix web run build; if ($LASTEXITCODE) { Fail 'web build 失败' }
}
Ok '依赖与前端构建就绪'

# --- 3. 防火墙 + 服务注册 ----------------------------------------------------
Step '防火墙放行 8443'
$fw = Get-NetFirewallRule -DisplayName 'slenk-8443' -ErrorAction SilentlyContinue
if (-not $fw) { New-NetFirewallRule -DisplayName 'slenk-8443' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpsPort | Out-Null }
Ok '防火墙规则就绪（阿里云安全组仍需放行，见 RUNBOOK）'

$logDir = Join-Path $Root 'logs'; New-Item -ItemType Directory -Path $logDir -Force | Out-Null
function Ensure-Service($name, $exePath, $args, $cwd) {
  if (Get-Service $name -ErrorAction SilentlyContinue) { Ok "$name 已注册，跳过"; return }
  if ($CheckOnly) { Fail "$name 未注册（-CheckOnly 模式不注册服务）" }
  & $script:nssmExe install $name $exePath @args | Out-Null
  & $script:nssmExe set $name AppDirectory $cwd | Out-Null
  & $script:nssmExe set $name AppStdout (Join-Path $logDir "$name.log") | Out-Null
  & $script:nssmExe set $name AppStderr (Join-Path $logDir "$name.err.log") | Out-Null
  & $script:nssmExe set $name AppRotateBytes 10485760 | Out-Null
  & $script:nssmExe start $name | Out-Null
  Ok "$name 已注册并启动"
}

Step '注册/启动 slenk-redis'
Ensure-Service 'slenk-redis' $redisServer @('--port', '6379', '--bind', '127.0.0.1', '--protected-mode', 'yes') $redisDir
Step '注册/启动 slenk-api'
Ensure-Service 'slenk-api' $nodeExe @((Join-Path $Root 'server\src\index.js')) (Join-Path $Root 'server')
Step '注册/启动 slenk-worker'
Ensure-Service 'slenk-worker' $nodeExe @((Join-Path $Root 'server\src\worker.js')) (Join-Path $Root 'server')
Step '注册/启动 slenk-caddy'
if (-not (Get-Service 'slenk-caddy' -ErrorAction SilentlyContinue)) {
  if ($CheckOnly) { Fail 'slenk-caddy 未注册（-CheckOnly 模式不注册服务）' }
  & $nssmExe install 'slenk-caddy' $caddyExe @('run', '--config', (Join-Path $Root 'scripts\deploy\Caddyfile')) | Out-Null
  & $nssmExe set 'slenk-caddy' AppDirectory $ToolsDir | Out-Null
  & $nssmExe set 'slenk-caddy' AppEnvironmentExtra "CF_API_TOKEN=$CfToken" | Out-Null
  & $nssmExe set 'slenk-caddy' AppStdout (Join-Path $logDir 'slenk-caddy.log') | Out-Null
  & $nssmExe set 'slenk-caddy' AppStderr (Join-Path $logDir 'slenk-caddy.err.log') | Out-Null
  & $nssmExe start 'slenk-caddy' | Out-Null
  Ok 'slenk-caddy 已注册并启动'
} else { Ok 'slenk-caddy 已注册，跳过' }

# --- 4. 验证 ----------------------------------------------------------------
if (-not $CheckOnly) {
  Step '等待 API 就绪'
  $deadline = (Get-Date).AddSeconds(30); $ok = $false
  while ((Get-Date) -lt $deadline) {
    try { $r = Invoke-RestMethod 'http://127.0.0.1:3001/api/health' -TimeoutSec 3; if ($r.ok) { $ok = $true; break } } catch { Start-Sleep -Milliseconds 500 }
  }
  if ($ok) { Ok 'API 在 127.0.0.1:3001 健康检查通过' } else { Fail 'API 未就绪，查看 logs\slenk-api.err.log' }
  Write-Host "`n部署完成。浏览器验证：https://${Domain}:${HttpsPort}（Turnstile 须真实浏览器）" -ForegroundColor Green
} else {
  Write-Host "`nCheckOnly 通过：依赖、仓库、.env 均就绪，可去掉 -CheckOnly 正式部署。" -ForegroundColor Green
}
```

- [ ] **Step 3: 本机干跑自检**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/deploy-server.ps1 -CfToken dummy -CheckOnly`（在仓库根目录；本机已装 Node/Git，预期在 Redis/NSSM/Caddy 未安装处停止并打印明确错误——这正是干跑的验收点：错误信息可读、无副作用。）

Expected: 打印 `==> 检查/安装依赖` 与 Node/Git 两行 OK，随后 `ERR Redis 未安装（-CheckOnly 模式不执行安装）` 退出码 1；`git status` 无新增文件、`Get-Service slenk-*` 不存在。

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy/Caddyfile scripts/deploy/deploy-server.ps1
git commit -m "feat: add ECS deploy Caddyfile and idempotent deploy-server script"
```

---

### Task 4: update-server.ps1 + RUNBOOK.md + README 部署章节

**Files:**
- Create: `scripts/deploy/update-server.ps1`
- Create: `scripts/deploy/RUNBOOK.md`
- Modify: `README.md`（末尾追加「云端部署」小节，链接 RUNBOOK）

**Interfaces:**
- Consumes: Task 3 的服务名（`slenk-api`/`slenk-worker`）与 `scripts/deploy/` 目录；NSSM 安装于 `C:\slenk-tools\nssm\nssm.exe`。
- Produces: `update-server.ps1 [-Root C:\slenk-notes] [-SkipBuild]`；文档。

- [ ] **Step 1: 写 update-server.ps1**

```powershell
# scripts/deploy/update-server.ps1 —— 日常更新：pull → install → build → 重启 API/worker。
# Caddy 不需要重启（配置没变）；要改 Caddyfile 时手动 nssm restart slenk-caddy。
# 用法：.\update-server.ps1 [-Root C:\slenk-notes] [-SkipBuild]
param(
  [string] $Root = 'C:\slenk-notes',
  [string] $Nssm = 'C:\slenk-tools\nssm\nssm.exe',
  [switch] $SkipBuild
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $Root 'server\src\index.js'))) { Write-Error "$Root 不是 Slenk Notes 仓库"; exit 1 }
Set-Location -LiteralPath $Root

Write-Host '==> git pull' -ForegroundColor Cyan
& git pull --ff-only
if ($LASTEXITCODE) { Write-Error 'git pull 失败（有本地改动或需要先 rebase），中止以免重启到不一致状态'; exit 1 }

if (-not $SkipBuild) {
  Write-Host '==> npm install + web build' -ForegroundColor Cyan
  & npm --prefix server install --no-audit --no-fund; if ($LASTEXITCODE) { Write-Error 'server npm install 失败'; exit 1 }
  & npm --prefix web install --no-audit --no-fund;     if ($LASTEXITCODE) { Write-Error 'web npm install 失败'; exit 1 }
  & npm --prefix web run build;                          if ($LASTEXITCODE) { Write-Error 'web build 失败'; exit 1 }
}

Write-Host '==> 重启 slenk-api / slenk-worker' -ForegroundColor Cyan
& $Nssm restart slenk-api; if ($LASTEXITCODE) { Write-Error 'slenk-api 重启失败'; exit 1 }
& $Nssm restart slenk-worker; if ($LASTEXITCODE) { Write-Error 'slenk-worker 重启失败'; exit 1 }

$deadline = (Get-Date).AddSeconds(30); $ok = $false
while ((Get-Date) -lt $deadline) {
  try { $r = Invoke-RestMethod 'http://127.0.0.1:3001/api/health' -TimeoutSec 3; if ($r.ok) { $ok = $true; break } } catch { Start-Sleep -Milliseconds 500 }
}
if ($ok) { Write-Host '  OK  更新完成，API 健康' -ForegroundColor Green } else { Write-Error 'API 未就绪，查看 logs\slenk-api.err.log'; exit 1 }
```

- [ ] **Step 2: 写 RUNBOOK.md**

```markdown
# ECS 云端部署 RUNBOOK（Slenk Notes → https://236963.xyz:8443）

设计文档：`docs/superpowers/specs/2026-11-13-ecs-cloud-deployment-design.md`。
本机代码先推送到 GitHub（私有仓库），服务器从 GitHub 拉取。

## 一、控制台操作（一次性，约 10 分钟）

1. **阿里云安全组**（ECS 实例 i-f8zcp6vvis4q14qp0z5q）：入方向放行 `8443/TCP`（源 0.0.0.0/0）；
   3389 建议限源 IP。
2. **Cloudflare DNS**：A 记录 `236963.xyz` → ECS 公网 IP，**灰云（仅 DNS）**。
3. **Cloudflare API Token**：权限 `Zone.DNS:Edit`，作用域仅 `236963.xyz` 一个 zone。保存好。
4. **Turnstile**：widget hostnames 添加 `236963.xyz`。

## 二、服务器上（管理员 PowerShell）

1. `git clone https://github.com/slenk-s/slenk-rbn.git C:\slenk-notes`
2. 从本机复制 `.env` 到 `C:\slenk-notes\.env`，修改：
   - `TURNSTILE_HOSTNAMES=236963.xyz`
   - `PUBLIC_URL=https://236963.xyz:8443`
   - `XHS_PUBLISH_ENABLED=false`（新增一行，禁用服务器端发布）
   - `STORAGE_PATH` / `UPLOADS_PATH` / `VIDEO_OUT_PATH` → 服务器绝对路径
     （指向 `C:\slenk-notes\storage\...`）
   - `FFMPEG_PATH` 可保留本机路径：不存在时 worker 自动回退到 npm 的 ffmpeg-static
   - 其余（JWT_SECRET、DATABASE_URL、SUPABASE_*、REDIS_URL、TURNSTILE_SECRET）原样不动
3. `node server/scripts/apply-schema.mjs`（幂等；本地已跑过则直接自检通过）
4. `.\scripts\deploy\deploy-server.ps1 -CfToken <第 3 步的 token>`

## 三、验证清单（手机流量 + 真实浏览器；自动化浏览器会被 Turnstile 300030 拦截）

- [ ] `https://236963.xyz:8443` 打开，证书有效（Caddy 首次签发约需 30 秒，失败看 `logs\slenk-caddy.err.log`）
- [ ] Turnstile 挑战出现，登录成功
- [ ] 建一个任务 → worker 消费 → 结果图显示（图走 Supabase URL）
- [ ] 点发布 → 显示「发布功能已在服务器上禁用，请到本地机器发布」
- [ ] 公网直连 `http://<公网IP>:3001/api/health` **失败**（仅回环）
- [ ] 重启机器一次：四个服务全部自动起来

## 四、日常更新 / 回滚 / 备案后切换

- 更新：`.\scripts\deploy\update-server.ps1`
- 回滚：`git checkout <旧 commit> && nssm restart slenk-api slenk-worker`（server\ 下执行 nssm，或用完整路径）
- 备案下来后：`scripts/deploy/Caddyfile` 里 `8443` → `443`，安全组放行 443，
  `nssm restart slenk-caddy`，更新 `.env` 的 `PUBLIC_URL` 去掉端口。
```

- [ ] **Step 3: README 追加部署章节**

在 `README.md` 末尾追加：

```markdown
## 云端部署

阿里云 ECS（Windows Server）部署见 `scripts/deploy/RUNBOOK.md`。要点：域名 236963.xyz
非标端口 8443 HTTPS（DNS-01），Caddy 反代 Express（同进程托管 web/dist），Redis/API/Worker/Caddy
四个 NSSM 服务；服务器端 `.env` 加 `XHS_PUBLISH_ENABLED=false` 禁用发布渠道。备案完成后
8443 切 443。
```

- [ ] **Step 4: 语法自检 + Commit**

Run: `powershell -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('scripts/deploy/deploy-server.ps1', [ref]$null, [ref]$e); $e.Count; $null = [System.Management.Automation.Language.Parser]::ParseFile('scripts/deploy/update-server.ps1', [ref]$null, [ref]$e2); $e2.Count"`
Expected: `0` 和 `0`（两个脚本无解析错误）

```bash
git add scripts/deploy/update-server.ps1 scripts/deploy/RUNBOOK.md README.md
git commit -m "docs: add cloud deployment runbook and update-server script"
```

---

### Task 5: 收尾验证（全量回归 + 干跑 + spec 对照）

**Files:** 无新文件；只读验证。

**Interfaces:**
- Consumes: Task 1-4 全部产物。
- Produces: 验证结论（用于最终交付说明）。

- [ ] **Step 1: 全量测试**

Run: `npm --prefix server test`
Expected: 全绿（含既有 12 个 test 文件 + 新增 2 个）

- [ ] **Step 2: 前端生产构建**

Run: `npm --prefix web run build`
Expected: 构建成功；`grep -c "localhost:3001" web/dist/assets/*.js` 为 0（生产包无 API 硬编码——App_backup.jsx 未参与构建，dist 里不应出现）。

- [ ] **Step 3: 发布开关端到端冒烟（本机）**

Run（本机起服务）：
```bash
XHS_PUBLISH_ENABLED=false npm --prefix server run dev &
curl -sk https://localhost/api/health   # 不通是正常的（端口只在 3001）
curl -s -X POST http://127.0.0.1:3001/api/publish -H "Content-Type: application/json" -H "Authorization: Bearer <任意串>" -d '{}'
```
Expected: 返回 `409 {"error":"发布功能已在服务器上禁用，请到本地机器发布","code":"PUBLISH_DISABLED"}`（开关在鉴权后、业务前生效即可——注意 `router.use(verify)` 在前，无 token 应先返回 401；换成本机真实 token 验证 409）。杀掉 dev 进程。

- [ ] **Step 4: deploy 脚本干跑**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy/deploy-server.ps1 -CfToken dummy -CheckOnly`
Expected: 与 Task 3 Step 3 相同的可读错误路径，`git status` 干净。

- [ ] **Step 5: spec 对照自查**

对照 `docs/superpowers/specs/2026-11-13-ecs-cloud-deployment-design.md` 4.3 逐条：
- [ ] HOST 回环（Task 1）
- [ ] 发布开关 409（Task 2）
- [ ] CORS_ORIGINS（Task 1）
- [ ] 前端无硬编码（Task 5 Step 2）
- [ ] 5.x 部署步骤完整可照做（Task 3/4）
全部满足后收尾，不做额外 commit（Task 1-4 已各自提交）。

---

## Self-Review 记录

- **Spec 覆盖**：4.3 四处代码改动 → Task 1/2/5；4.1 服务化 + 3 架构 → Task 3；5 部署流程 → Task 3/4；6 运维回滚 → Task 4；8 测试 → 各 Task 内 TDD + Task 5。
- **占位符**：无 TBD/TODO；所有代码块完整。
- **类型一致性**：`createPublishDisabledMiddleware`、`hostFromEnv`、`corsOptions`、服务名 `slenk-*`、`XHS_PUBLISH_ENABLED`/`CORS_ORIGINS`/`HOST` 在各任务与 RUNBOOK 中一致。
- **与 spec 的偏差（有意为之，更简）**：Caddy 不静态托管 web/dist，改由 Express（既有代码）托管，Caddyfile 只有 TLS + reverse_proxy —— spec 3 的意图（单一入口、同源）不变。
