# Slenk Notes 本机 Redapp 授权中心设计

日期：2026-11-11  
状态：用户已批准交互与安全设计，等待书面规格确认

## 1. 目标

把 Slenk Notes 封装为本机桌面工作台时，实现一套可视、可恢复的“小红书发布授权”流程：

- Skill 与应用一起分发；登录凭证不进入安装包、仓库、Supabase 或应用日志。
- 凭证继续由 `redapp` CLI 保存和刷新，Slenk Notes 不读取 token 文件。
- 所有 Slenk 用户共享当前 Windows 用户下的一份小红书凭证。
- 所有 Slenk 用户均可查看状态、登录、重新授权、退出和使用“扫码直达”。
- 用户在发布时遇到未登录，可扫码授权；成功后自动继续刚才的发布，不需要重新提交。

## 2. 非目标

本期不实现：

- 多租户、每个 Slenk 用户绑定不同小红书账号。
- 将 redapp access token / refresh token 写入数据库或前端。
- 云服务器集中托管多个用户的本地凭证。
- 服务重启后恢复尚未完成的扫码会话或待发布请求。
- 自动送审、发布正式小工具或修改远端小工具资料。

## 3. 安全模型

### 3.1 凭证归属

- redapp 凭证归属于运行 Slenk Notes server 的 Windows 用户。
- 生产与 Beta 环境由 CLI 自身隔离。
- Slenk Notes 仅通过 `redapp whoami/login/logout --agent` 与业务命令交互。
- 不读取、复制、备份、序列化或返回凭证文件内容。

### 3.2 前端可见数据

仅允许返回：

```json
{
  "available": true,
  "loggedIn": true,
  "openIdMasked": "ob5c…fa90",
  "scope": ["base_info", "skill_publish"],
  "expireTimeMs": 1794289913641,
  "needsReauth": false
}
```

禁止返回：

- `accessToken`
- `refreshToken`
- 完整 `openId`
- 凭证文件路径或目录内容
- CLI 原始 `credentials` 对象

### 3.3 共享授权提示

授权卡片和退出确认必须明确提示：

> 这是本机共享的小红书授权；重新授权或退出会影响所有 Slenk 用户。

## 4. 服务端组件

新增独立模块 `server/src/lib/redappAuth.js`。该模块依赖现有 `redappCli.js` 的版本门禁、进程级 npm prefix/cache 和 CLI 入口解析，但不共享业务上传状态。

### 4.1 `getAuthStatus()`

执行 `redapp whoami --agent`，输出脱敏状态。

行为：

- 已登录：返回 `loggedIn=true`、掩码 openId、scope、有效期。
- 未登录 / `AUTH_REQUIRED`：返回 `loggedIn=false`，不是 HTTP 500。
- CLI 版本门禁失败：返回 `available=false` 和可操作错误，不泄露 CLI stdout 中的敏感字段。

### 4.2 `startLogin()`

启动唯一的 `redapp login --agent` 子进程，保留进程句柄并逐行解析：

- `PROMPT:<json>`：保存会话二维码路径、授权链接、授权码、有效期。
- `RESULT_JSON:<json>`：仅提取 `loggedIn`、掩码 openId、scope、有效期；立即清除原始输出引用。
- 异常退出：会话转为 `failed`。

约束：

- 同时最多一个登录会话；并发调用复用当前会话。
- 会话默认 10 分钟过期，以 CLI 返回的 `expiresInSeconds` 为准，上限 10 分钟。
- 二维码读取为短期 data URL 后只驻留内存，不写数据库。
- 会话完成、失败、取消或过期后终止残留进程并释放临时状态。

### 4.3 `cancelLogin(sessionId)`

- 仅取消当前匹配 sessionId 的会话。
- 终止等待中的 CLI 子进程。
- 调用 `redapp login --cancel --agent` 清理设备授权流程。
- 将会话标记为 `cancelled`。

### 4.4 `logout()`

执行 `redapp logout --agent`，成功后清空内存授权会话。

### 4.5 `waitForLogin(sessionId)`

供发布流程或测试等待同一会话的最终状态，不启动重复登录进程。

## 5. API 设计

所有接口沿用现有 Bearer JWT 鉴权。按用户决策，普通用户与管理员权限一致。

### 5.1 查询授权状态

```text
GET /api/redapp/auth
```

返回脱敏状态。

### 5.2 发起/复用登录

```text
POST /api/redapp/auth/login
```

返回：

```json
{
  "sessionId": "...",
  "status": "waiting_prompt | waiting_scan | done | failed",
  "qrImage": "data:image/png;base64,...",
  "authorizeUrl": "https://...",
  "userCode": "ABCD-EFGH",
  "expiresAt": 1794280000000
}
```

在 CLI 尚未输出 PROMPT 时允许 `qrImage=null`，前端继续轮询。

### 5.3 查询登录会话

```text
GET /api/redapp/auth/session/:id
```

返回会话状态和可展示的短期授权信息。token 字段在任何状态均不存在。

### 5.4 取消登录

```text
POST /api/redapp/auth/session/:id/cancel
```

### 5.5 退出授权

```text
POST /api/redapp/auth/logout
```

前端必须先进行共享影响二次确认。

## 6. 发布流程集成

现有：

```text
POST /api/publish/minitool
```

处理顺序调整为：

1. 校验标题、正文、图片。
2. 运行 CLI 版本门禁。
3. 查询 `whoami`。
4. 未登录时创建/复用授权会话，返回 HTTP 401：

```json
{
  "error": "需要连接小红书后继续",
  "code": "AUTH_REQUIRED",
  "auth": {
    "sessionId": "...",
    "status": "waiting_scan",
    "qrImage": "...",
    "authorizeUrl": "...",
    "userCode": "...",
    "expiresAt": 1794280000000
  }
}
```

5. 已登录才进行本地打包、审计、上传和 preview，避免未授权时产生无用 ZIP 与上传操作。

服务端不持久化待发布正文；原发布请求只保留在发起该操作的浏览器内存中。已派发的发布任务在进程内以规范化请求（fingerprint 幂等键）驻留至多 30 分钟用于结果查询与防重复上传，随进程结束一并消失，不落盘、不跨进程恢复。

## 7. 前端设计

### 7.1 仪表盘授权卡片

在仪表盘添加“小红书发布授权”卡片：

- 状态：已连接 / 未连接 / 等待扫码 / 已过期 / CLI 不可用。
- 账号：掩码 openId。
- 权限：scope 列表。
- 有效期：本地格式化时间。
- 按钮：连接小红书 / 重新授权 / 退出授权 / 刷新状态。
- 共享授权提示常驻显示。

### 7.2 授权弹框

展示：

- 二维码。
- 授权链接。
- 授权码。
- 剩余有效时间。
- 当前状态。
- 取消按钮。

前端每 1.5 秒轮询当前 session；弹框关闭不自动取消，只有点击取消才取消 CLI 流程。

### 7.3 自动继续发布

“扫码直达”提交时：

1. 将本次请求对象保存在当前 `NoteRewriteWorkspace` 的内存引用中。
2. 若响应为 `AUTH_REQUIRED`，打开授权弹框。
3. 授权会话变为 `done` 后，显示“授权成功，正在继续发布”。
4. 使用相同请求对象自动重发一次 `/api/publish/minitool`。
5. 成功后展示笔记预览二维码，并清除待发布内存。
6. 失败时保留表单，显示重试按钮；不循环自动重试。

页面刷新、浏览器关闭或服务重启会丢失待发布请求；这是本机短时状态的预期行为。

## 8. 状态机

```text
idle
  ├─ start → waiting_prompt
  │             ├─ PROMPT → waiting_scan
  │             ├─ RESULT ok → done
  │             ├─ timeout → expired
  │             ├─ cancel → cancelled
  │             └─ process error → failed
  ├─ existing active session → reuse same sessionId
  └─ logout → idle / loggedOut
```

终态：`done`、`failed`、`expired`、`cancelled`。

## 9. 错误处理

- `whoami` 未登录：正常返回 `loggedIn=false`。
- CLI 缺失/门禁失败：`available=false`，不尝试本地源码兜底。
- PROMPT 无二维码但有授权链接：展示链接与授权码。
- 会话找不到（服务重启）：返回 404 `session_not_found`，前端提示重新扫码。
- 二维码过期：会话终止，不复用过期链接。
- 登录成功但发布失败：不重新登录；保留笔记表单，允许手动重试。
- 上传结果 `OUTCOME_UNKNOWN`：停止自动重试并报告未知状态。

## 10. 测试策略

### 10.1 自动测试

CLI 进程注入测试替身，不读取真实凭证：

- PROMPT / RESULT_JSON 分行解析。
- token 字段不会进入 API DTO。
- 同一时间多请求只产生一个登录会话。
- 过期、取消、异常退出均清理进程。
- `whoami` 未登录映射为正常状态。
- `AUTH_REQUIRED` 后，前端控制逻辑只重放一次。
- 失败后不自动循环上传。

### 10.2 集成验证

不退出当前真实账号，先验证：

- `GET /api/redapp/auth` 正确显示当前已登录状态。
- 已登录时“扫码直达”直接成功，无额外登录。

真实登录/退出验证仅在用户明确操作时进行：

- 退出后状态变为未登录。
- 发布触发授权二维码。
- 手机扫码授权。
- 授权成功自动继续并生成小工具预览二维码。

## 11. 交付与部署

- 安装包包含 `.skills/` 和 `setup-skills.ps1`，不包含 `.skillhub-upload/`。
- 新机器首次触发发布时扫码授权。
- 更新应用不得覆盖用户凭证目录。
- 卸载器默认保留凭证；“卸载并清除授权”应先调用 `redapp logout --agent`，再按 CLI 官方流程处理。
- 本期定位为单机共享授权；云端多租户必须另做隔离架构。
