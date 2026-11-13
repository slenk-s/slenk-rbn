# Slenk Notes 多账号小红书授权与用户隔离设计

日期：2026-11-12（2026-11-13 修订：五项开放问题已拍板）
状态：设计规格修订稿，待用户评审

> 本稿相对初稿的修订点（均已经用户确认）：
>
> 1. **openId 按用户各自绑定**：不同 Slenk 用户可以各自绑定同一个小红书账号（各自扫码、各自独立凭证）；唯一约束保持 `unique(user_id, open_id)`，不做全局唯一。
> 2. **待绑定账号先入库**：`open_id` 可空，`POST /accounts` 立即插行，扫码成功回填。
> 3. **删除账号时用户选择是否清理磁盘凭证**：`deleteCredentials` 参数，默认删除。
> 4. **管理员只读跨用户查看**：新增只读管理接口，无任何操作权限。
> 5. **前端只返回脱敏路径 hint**，不返回绝对路径。
> 6. 扫码冲突时**删除本次新建的凭证目录与待绑定记录**，复用已有绑定，不留孤儿文件。

## 1. 目标

把当前「本机所有 Slenk 用户共享一份小红书凭证」升级为：

- **用户与用户隔离**：每个 Slenk 用户只能查看和管理自己绑定的小红书账号，不能看到或操作其他用户的账号。
- **每用户多账号**：一个 Slenk 用户可以同时绑定多个不同的小红书账号。
- **扫码自动匹配**：用户扫码授权后，服务端根据登录返回的 `openId` 自动识别并落库到对应账号绑定，无需手动填写账号标识。
- **按账号发布**：用户发布时选择一个已绑定账号，服务端用该账号的独立凭证执行 `whoami` / `upload` / `preview`。

## 2. 非目标

本期不实现：

- 管理员跨用户**操作**（删除、代管、代发布）其他用户的绑定账号；管理员只读查看除外（见 7.4）。
- 云端集中托管多个用户的多份凭证（凭证始终留在本机）。
- 账号级别的发布记录、发布历史、账号级统计。
- 服务重启后恢复未完成的扫码会话或待发布请求（待绑定账号的数据库行保留，但登录会话不恢复）。
- 自动送审、发布正式小工具或修改远端小工具资料。
- 管理员前端界面（本期只提供只读 API，界面后续再说）。

> 说明：**不同 Slenk 用户绑定同一个小红书账号是允许的**。小红书侧本来就允许多次授权同一小工具；每个用户各自扫码、各自持有独立凭证目录，绑定记录按用户隔离，互不感知。

## 3. 技术前提（已确认）

redapp CLI 的凭证根目录由环境变量 `SKILLHUB_UPLOAD_HOME` 决定，源码位于
`storage/redapp-npm/prefix/node_modules/redskillhub-upload/cli/config.mjs`：

```js
export function getHomeDir(env = process.env) {
  return env.SKILLHUB_UPLOAD_HOME || path.join(os.homedir(), '.skillhub-upload');
}
export function getEnvironmentHomeDir(env, flags) {
  const home = getHomeDir(env);
  return resolveApiEnvironment(flags) === 'beta' ? path.join(home, 'beta') : home;
}
```

因此：

- 每个 CLI 进程使用**一个**凭证目录，目录内 `credentials.json` 对应**一个**小红书账号。
- 给不同账号注入不同的 `SKILLHUB_UPLOAD_HOME`，即可让同一机器上并存多套独立凭证。
- CLI 登录成功后，`RESULT_JSON` 返回 `credentials.openId`（完整值），可作为账号唯一标识。
- 改造**不需要修改 CLI 本体**，只需在 Slenk 服务端封装「凭证目录 ↔ 账号绑定」映射。

## 4. 安全模型

### 4.1 凭证归属与隔离

- 凭证归属于「某个 Slenk 用户绑定的某个小红书账号」，以**独立凭证目录**为隔离单位。
- 每个凭证目录只包含一个账号的 `credentials.json`；目录路径由服务端生成，不依赖用户输入。
- 所有账号 CRUD 与状态查询都必须带 `req.user.userId`，服务端强制过滤，禁止跨用户访问（7.4 的管理员只读接口除外）。
- 凭证内容（access/refresh token、完整 openId、凭证绝对路径）**永不返回前端、不写日志、不进 git**。

### 4.2 凭证目录位置

- 默认位于项目 `storage/auth/<userId>/<accountId>/`（`storage/` 已在 `.gitignore`，不会进仓库）。
- 也可通过环境变量 `SLENK_XHS_AUTH_ROOT` 覆盖，便于安装包场景放到 Windows 用户目录。
- 每个目录内只放该账号的 CLI 凭证与临时二维码文件；二维码读取后立即转内存 data URL。
- 扫码冲突（用户扫了已绑定的账号）时，本次新建的凭证目录与待绑定记录一并删除，复用已有绑定，不留孤儿文件。

### 4.3 前端可见数据

账号列表接口只允许返回：

```json
{
  "id": "acct-1",
  "status": "bound",
  "openIdMasked": "ob5c…fa90",
  "nickname": "可选昵称",
  "credentialDirHint": "…/acct-1",
  "loggedIn": true,
  "scope": ["base_info", "skill_publish"],
  "expireTimeMs": 1794289913641,
  "needsReauth": false,
  "createdAt": 1794000000000
}
```

- `status`：`pending_bind`（已添加未扫码，`openIdMasked` 为 `null`）或 `bound`。
- `credentialDirHint`：只给目录尾段（如 `…/acct-1`），供用户排查时口头描述，**绝不给绝对路径**。
- 禁止返回 `accessToken`、`refreshToken`、完整 `openId`、`credentialDir` 绝对路径。

## 5. 数据模型

新增表 `slenk_notes_xhs_accounts`（沿用 `slenk_notes_` 前缀与 RLS revoke 模式）：

```sql
create table if not exists slenk_notes_xhs_accounts (
  id text primary key,
  user_id text not null references slenk_notes_users(id) on delete cascade,
  credential_dir text not null unique,
  open_id text,                          -- 扫码成功后回填；NULL 表示待绑定
  nickname text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, open_id)              -- Postgres 中 NULL 互不冲突，允许同用户多个待绑定
);

create index if not exists slenk_notes_xhs_accounts_user_idx
  on slenk_notes_xhs_accounts (user_id, created_at desc);

alter table slenk_notes_xhs_accounts enable row level security;
revoke all on slenk_notes_xhs_accounts from anon, authenticated;
revoke all on slenk_notes_xhs_accounts from public;
```

约束：

- `unique (user_id, open_id)`：同一用户不能重复绑定同一小红书账号；不同用户绑定同一 openId **允许**（各自独立凭证）。
- `credential_dir` 全局唯一：一个凭证目录只属于一个账号（不再重复声明 `unique(user_id, credential_dir)`）。
- `open_id` 可空：`POST /accounts` 先插待绑定行，扫码成功回填；`open_id` 仅服务端使用，前端只暴露 `openIdMasked`。

## 6. 服务端组件

### 6.1 CLI 凭证目录注入（`server/src/lib/redappCli.js`）

现有 `createRedappNpmEnv(platform)` 只设 npm prefix/cache，需扩展为可注入凭证目录：

```js
export function createRedappNpmEnv(platform = process.platform, { credentialHome } = {}) {
  const env = { ...process.env, NPM_CONFIG_PREFIX, NPM_CONFIG_CACHE, PATH: ... };
  if (credentialHome) env.SKILLHUB_UPLOAD_HOME = credentialHome;
  return env;
}
```

透传链：

- `spawnRedappLogin({ credentialHome })`：`login --agent` 用 `SKILLHUB_UPLOAD_HOME=<credentialHome>`。
- `runRedappCommandAsync(args, { credentialHome, ... })`：`whoami`/`logout`/`login --cancel` 透传。
- `createRedappOperationsAsync({ runCommand, ... })`：`uploadPackageAsync`/`createPreviewAsync` 增加 `credentialHome`。
- `createAsyncProcessRunner` 的 `spawnProcess` 与 `npmEnv` 改为按调用参数传入 env，而非闭包固定。

### 6.2 绑定注册表（`server/src/lib/xhsAccountRegistry.js`，新建）

封装 `slenk_notes_xhs_accounts` 的读写与匹配逻辑：

```js
createXhsAccountRegistry({
  listForUser, getForUser, createPendingForUser, bindOpenIdForUser,
  findByOpenIdForUser, deleteForUser, resolveCredentialDir,
  generateAccountId, generateCredentialDir
})
```

方法（除管理接口外全部以 `userId` 为第一参数）：

- `listForUser(userId)`：返回该用户全部账号（含待绑定；脱敏，不返回 credentialDir 绝对路径/openId 原文）。
- `getForUser(userId, accountId)`：单账号；不存在或不属于该用户返回 `null`。
- `createPendingForUser(userId, { credentialDir })`：插入待绑定行（`open_id` 为 NULL）。
- `bindOpenIdForUser(userId, accountId, { openId, nickname? })`：扫码成功后回填；`unique` 冲突映射为 `XHS_ACCOUNT_DUPLICATE`。
- `findByOpenIdForUser(userId, openId)`：扫码自动匹配用，返回匹配账号或 `null`。
- `deleteForUser(userId, accountId, { deleteCredentials })`：仅删除属于该用户的绑定；`deleteCredentials` 为 true 时同时删除磁盘凭证目录；返回是否删除。
- `resolveCredentialDir(userId, accountId)`：发布前解析凭证目录，校验归属；待绑定账号同样可解析（用于发起登录）。

### 6.3 授权状态机 per-user / per-account（`server/src/lib/redappAuth.js`）

把现有「全局单例 `active` + 单一 `sessions` Map」改为：

```js
// 外层：Map<userId, UserAuthState>
// UserAuthState = { active: Session|null, sessions: Map<accountId, Session>, lock: boolean }
```

方法签名变更：

- `getStatus(userId, accountId)`：读取该账号凭证目录的 `whoami`。
- `startLogin(userId, accountId, credentialDir)`：用该目录启动 `login --agent`。
- `getSession(userId, accountId, sessionId)`：查询该账号会话。
- `cancelLogin(userId, accountId, sessionId)`：取消该账号会话。
- `logout(userId, accountId, credentialDir)`：该账号退出。

约束：

- **一个用户同一时刻最多一个登录会话**（`userState.lock`）。不同用户可并行。
- 同一账号重复调用 `startLogin` 复用当前会话。
- 登录完成时回调 `onLoginDone({ userId, accountId, credentialDir, openId })`，由上层做扫码自动匹配与落库。
- 会话默认 10 分钟过期（上限 600s），终态保留 5 分钟供前端读取。
- 取消/过期/异常退出必须 kill CLI 子进程并清理该账号目录临时文件。

### 6.4 扫码自动匹配（`server/src/lib/xhsAccountMatcher.js`，新建）

登录完成后调用：

```js
async function matchLoginToAccount({ userId, accountId, credentialDir, openId, registry }) {
  const existing = await registry.findByOpenIdForUser(userId, openId);
  if (existing && existing.id !== accountId) {
    // 该用户已绑定同一小红书账号：删除本次待绑定行与新建凭证目录，复用已有绑定。
    await registry.deleteForUser(userId, accountId, { deleteCredentials: true });
    return { matched: false, conflict: true, existingId: existing.id };
  }
  if (existing && existing.id === accountId) {
    // 已绑定账号重新扫码（刷新授权），无需改库。
    return { matched: true, accountId };
  }
  // 待绑定行回填 openId；若并发下撞 unique，映射为 XHS_ACCOUNT_DUPLICATE。
  await registry.bindOpenIdForUser(userId, accountId, { openId });
  return { matched: true, accountId };
}
```

注意匹配只在**当前用户**范围内进行；其他用户是否绑过同一 openId 不影响本流程（见 §2 说明）。

## 7. API 设计

除 7.4 外，所有接口沿用现有 Bearer JWT 鉴权，并从 `req.user.userId` 取当前 Slenk 用户，禁止跨用户。

### 7.1 账号管理

```text
GET    /api/redapp/accounts                                # 当前用户账号列表（脱敏，含待绑定）
POST   /api/redapp/accounts                                # 创建待绑定账号：插入 open_id=NULL 行，返回 { id, status: 'pending_bind', credentialDirHint }
DELETE /api/redapp/accounts/:id?deleteCredentials=true     # 解绑账号；deleteCredentials 默认 true（同时删除磁盘凭证目录），false 仅解绑保留凭证
```

### 7.2 授权状态（按账号）

```text
GET  /api/redapp/auth?accountId=...            # 该账号脱敏状态
POST /api/redapp/auth/login?accountId=...      # 该账号发起/复用登录
GET  /api/redapp/auth/session/:id?accountId=...  # 该账号会话
POST /api/redapp/auth/session/:id/cancel?accountId=...  # 取消
POST /api/redapp/auth/logout?accountId=...     # 该账号退出
```

`accountId` 必须属于当前用户，否则返回 404。

### 7.3 发布（按账号）

`POST /api/publish/minitool` 请求体增加：

```json
{ "title": "...", "content": "...", "tags": [], "images": [], "accountId": "acct-1" }
```

服务端流程：

1. 校验 `accountId` 属于当前用户（否则 404 / `XHS_ACCOUNT_NOT_FOUND`）。
2. 解析该账号 `credentialDir`。
3. 用该目录执行 `whoami`；未登录返回 `AUTH_REQUIRED` + `auth.accountId`。
4. 已登录才进行打包、审计、上传、预览（全部带 `credentialDir`）。

### 7.4 管理员只读

```text
GET /api/redapp/admin/accounts   # 全部用户的脱敏账号列表，按用户分组；只读
```

- 要求当前用户具有管理员角色；非管理员返回 403 `XHS_ADMIN_REQUIRED`。
- 返回数据与 7.1 相同的脱敏 DTO（外加 `userId` 分组），**不暴露** token、完整 openId、绝对路径。
- 不提供任何管理操作接口（删除、代绑、代发布一律不做）。
- 前提：`slenk_notes_users` 需要角色标识；实施时先确认是否已有 `role` 列，没有则新增（`role text not null default 'user'`）。

## 8. 前端设计

### 8.1 授权卡片改为账号列表

`RedappAuthCard` 改为展示当前用户的**账号列表**：

- 每个账号一张行卡：状态（待绑定/已绑定）、掩码 openId、授权状态、到期时间、操作（扫码绑定 / 重新授权 / 退出 / 删除）。
- 「添加小红书账号」按钮：调 `POST /api/redapp/accounts` 创建待绑定账号（列表立即出现「待扫码」条目）并立即发起扫码。
- 顶部去掉「共享电脑提示」，改为「每个用户管理自己的小红书账号，互不影响」。
- 删除账号需二次确认，弹框内含「同时删除凭证文件」勾选项，**默认勾选**；取消勾选则仅解绑、磁盘凭证保留。

### 8.2 发布账号选择器

`NoteRewriteWorkspace` 的发布确认弹框（`publishConfirm`）中，「扫码直达」下方新增：

- 「发布到小红书账号」下拉选择器，列出当前用户**已绑定**的账号（`GET /api/redapp/accounts`，过滤掉 `pending_bind`）。
- 无已绑定账号时显示「去绑定账号」按钮并禁用扫码直达。
- 提交时把 `accountId` 放进 `createPublishRequestSnapshot` 的请求体。

### 8.3 自动续发保留账号上下文

- `publishWithAuth` 的请求快照携带 `accountId`。
- 授权完成自动重放时，用**同一账号**重放发布，不切换到其他账号。
- 弹框轮询会话按 `accountId` 维度查询。

## 9. 状态机

### 9.1 账号绑定生命周期

```text
pending_bind         # POST /accounts 已插行（open_id NULL），尚未扫码
  ├─ login done → 回填 openId → bound        # 扫码后自动匹配并落库
  ├─ login done → conflict → 删除本行与新目录，复用已有绑定   # 该用户已绑同账号
  └─ failed / cancelled → pending_bind       # 可重新发起；用户也可删除该待绑定账号
bound                # 已绑定，凭证在 credentialDir
  ├─ whoami ok → usable
  ├─ whoami AUTH_REQUIRED → needs_bind（重新扫码，复用同一行与目录）
  └─ delete → unbound（按 deleteCredentials 决定是否清磁盘）
```

### 9.2 登录会话状态机（按账号）

```text
idle
  ├─ start(userId, accountId) → waiting_prompt
  │        ├─ PROMPT → waiting_scan
  │        ├─ RESULT ok → done（触发自动匹配）
  │        ├─ timeout → expired
  │        ├─ cancel → cancelled
  │        └─ process error → failed
  ├─ 同账号 active → reuse
  └─ 同用户已有 active（另一账号）→ blocked：提示「请先完成当前授权」
```

## 10. 错误处理

- `XHS_ACCOUNT_NOT_FOUND`：accountId 不存在或不属于当前用户，HTTP 404。
- `XHS_ACCOUNT_DUPLICATE`：同用户重复绑定同一 openId（回填时撞 unique），HTTP 409。
- `XHS_BIND_CONFLICT`：扫码发现该用户已绑同一账号，HTTP 409，返回 `existingId`；本次待绑定行与新凭证目录已清理。
- `XHS_LOGIN_BUSY`：同用户已有登录会话进行中，HTTP 409。
- `XHS_ADMIN_REQUIRED`：非管理员访问管理接口，HTTP 403。
- `AUTH_REQUIRED`：发布时该账号未登录，返回 `auth.accountId`。
- `REDAPP_UNAVAILABLE`：CLI 缺失/门禁失败，HTTP 503。

## 11. 测试策略

### 11.1 自动测试

CLI 进程注入假替身，不读取真实凭证：

- per-user 隔离：A 用户列表/会话不包含 B 用户数据；跨用户访问返回 404。
- 多账号：同一用户可绑定多个账号（含多个待绑定）；同用户重复绑定同 openId 拒绝；**不同用户绑定同 openId 允许**。
- 待绑定：`POST /accounts` 插入 open_id NULL 行并出现在列表（`status: pending_bind`）；扫码后回填变 `bound`。
- 扫码自动匹配：登录返回 openId 后，未绑定回填、已绑定返回 conflict 且新目录/待绑定行被清理。
- 并发：同用户两账号同时 startLogin 只允许一个；不同用户可并行。
- 删除：`deleteCredentials=true` 删目录，`false` 保留；均只删本用户绑定。
- 管理员：只读接口返回全量脱敏数据；非管理员 403；管理员无操作接口可用。
- 脱敏：任何账号列表/状态/会话/管理 DTO 不含 token、完整 openId、credentialDir 绝对路径。
- 发布：按 accountId 走对应 credentialDir；无权限 accountId 返回 404。

### 11.2 集成验证

- 不破坏现有真实账号前提下验证账号列表只显示当前用户。
- 真实扫码仅在用户明确操作时验证：添加 → 扫码 → 自动落库 → 发布成功。

## 12. 交付与部署

- 凭证目录在 `storage/auth/` 或 `SLENK_XHS_AUTH_ROOT`，均不进入安装包/git。
- 新机器首次使用需要用户逐个添加并扫码绑定自己的账号。
- 删除用户账号（Slenk 用户）时，其绑定记录随 `on delete cascade` 删除；磁盘凭证目录由应用清理（复用 `deleteForUser` 的清理路径）。
- 删除小红书账号绑定时，默认同时删除磁盘凭证目录；用户可在确认弹框取消勾选以保留凭证。
- 现有单共享凭证不自动迁移；本期建议旧账号保留在 `~/.skillhub-upload` 作为默认，或要求用户重新绑定。

## 13. 已决事项（2026-11-13 拍板）

- 删除账号时磁盘凭证：**用户选择**，确认弹框「同时删除凭证文件」默认勾选；接口 `deleteCredentials` 默认 true。
- 管理员跨用户查看：**允许只读**（7.4），无任何操作权限；前端管理界面本期不做。
- 凭证路径：**只返回脱敏 hint**（目录尾段），不返回绝对路径。
- openId 唯一性：**按用户各自绑定**（`unique(user_id, open_id)`），不做全局唯一；不同用户可绑同一小红书账号。
- 待绑定账号：**先入库**（`open_id` 可空），扫码回填。
- 扫码冲突：删除本次待绑定行与新建凭证目录，复用已有绑定。
