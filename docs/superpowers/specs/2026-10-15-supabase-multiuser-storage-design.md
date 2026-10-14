# Slenk Notes 多用户 + Supabase 存储设计

日期：2026-10-15
状态：待评审

## 目标

把数据层从单文件 JSON（`storage/app.json`）迁到 Supabase Postgres，并引入用户隔离，
让多个账号各自拥有独立的笔记、任务和偏好，同时不改变现有登录方式和 AI 任务流程。

## 范围

本次做：

- 建表、约束、索引，数据层改由 Postgres 承担
- 用户隔离：笔记、任务、用户偏好按 `user_id` 归属
- AI 供应商改为**全局统一配置**，由管理员维护，所有用户共用
- 迁移现有 `app.json` 数据

本次不做（避免范围膨胀）：

- 图片和视频仍存本地磁盘（`storage/uploads`、`storage/videos`），不搬 Supabase Storage
- 不做注册页、改密、找回密码；新用户由管理员添加
- 不做用量配额、限流、审计日志
- 不改 `next` 之外的认证逻辑，继续使用自签 JWT

## 决策记录

| 决策 | 选择 | 原因 |
|---|---|---|
| 认证 | 保留自签 JWT | 改动最小，`auth.js` 与前端登录流程不动 |
| 表名前缀 | `slenk_notes_` | 全小写加下划线，任何位置都无需引号 |
| 供应商归属 | 全局统一配置 | 用户指定；API Key 只由管理员维护 |
| 后端访问方式 | `pg` 直连 Supavisor | 服务端常驻进程，直连比 REST 更省开销，且能执行 DDL |
| 区域 | `aws-0-ap-southeast-1.pooler.supabase.com` | 直连仅 IPv6 不可达，此 pooler 是唯一握手成功的入口 |

## 数据模型

五张表，均在 `public` schema。

### slenk_notes_users

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | text | PK |
| `username` | text | unique, not null |
| `password_hash` | text | not null |
| `is_admin` | boolean | not null default false |
| `created_at` | timestamptz | not null default now() |

现有 `admin` 账号迁入并置 `is_admin = true`。

### slenk_notes_user_settings

| 列 | 类型 | 约束 |
|---|---|---|
| `user_id` | text | PK, references users(id) on delete cascade |
| `active_provider_id` | text | |
| `active_text_provider_id` | text | |
| `active_image_provider_id` | text | |

对应原来 `app.json` 里全局的 `activeProviderId` / `activeTextProviderId` /
`activeImageProviderId`。供应商列表是全局共享的，但"当前用哪一个"按用户独立，
这样前端已有的切换器不需要改语义。

### slenk_notes_providers

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | text | PK |
| `name` | text | not null |
| `provider_type` | text | not null default 'openai-compatible' |
| `app_type` | text | not null default 'openai' |
| `base_url` | text | not null default '' |
| `api_key` | text | not null default '' |
| `mode` | text | not null default 'image' |
| `text_model` | text | not null default '' |
| `image_model` | text | not null default '' |
| `notes` | text | not null default '' |
| `is_active` | boolean | not null default false |
| `created_at` / `updated_at` | timestamptz | not null default now() |

无 `user_id`：全局共享，仅管理员可写。

### slenk_notes_tasks

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | text | PK |
| `user_id` | text | references users(id) on delete cascade |
| `type` | text | not null |
| `label` | text | |
| `status` | text | not null default 'queued' |
| `payload` | jsonb | |
| `provider_id` | text | |
| `tab` | text | |
| `result` | jsonb | |
| `error` | text | |
| `created_at` / `updated_at` | timestamptz | not null default now() |

索引：`(user_id, created_at desc)`。

`payload` 和 `result` 由 JSON 字符串改为 `jsonb`，读写两端省掉 `JSON.stringify` /
`JSON.parse`。worker 通过 `updateTask(id, patch)` 写回，签名不变。

### slenk_notes_notes

| 列 | 类型 | 约束 |
|---|---|---|
| `id` | text | PK |
| `user_id` | text | references users(id) on delete cascade |
| `title` | text | not null default '' |
| `content` | text | not null default '' |
| `tags` | text[] | not null default '{}' |
| `images` | jsonb | not null default '[]' |
| `created_at` | timestamptz | not null default now() |

索引：`(user_id, created_at desc)`。

## 安全模型

后端通过 `postgres` 角色直连（表 owner，天然绕过 RLS），是唯一的访问路径。
因此访问模型是"仅服务端可达"，RLS 在这里承担纵深防御：

- 五张表全部 `enable row level security`
- **不创建任何 policy**：`anon` / `authenticated` 经 Data API 一律无行可读
- 不向 `anon` / `authenticated` 授予任何 `GRANT`，表不暴露给 Data API
- 不使用 `SECURITY DEFINER` 函数，不引入绕过 RLS 的路径

由此即使 `sb_secret_*` 泄露或被误用，数据边界依然存在；而 `sb_publishable_*`
在浏览器侧完全用不到——前端始终只与自家后端通信。

`api_key` 明文存储于 `slenk_notes_providers`，与现状一致；因该表不对 Data API 暴露，
风险面仅限于数据库本身。

## 存储层改造

`server/src/store.js` 由 fs 全量读写改为 pg 连接池查询：

- 导出函数全部变为 `async`，内部用参数化查询（不拼接 SQL）
- `listTasks` / `getTask` / `deleteTask` / `saveNote` / `getNote` 增加 `userId` 约束
- `listProviders` / `addProvider` / `updateProvider` / `deleteProvider`
  保持全局语义，函数签名不变
- 管理员校验放在路由层（`routes/providers.js` 的写接口），依据 JWT 里的 `userId`
  回查 `slenk_notes_users.is_admin`；store 层不持有请求上下文，不做该判断
- `setActiveProvider(id, mode, userId)` 写入 `user_settings`，属每用户偏好，无需管理员权限
- `getActiveProvider(mode, userId)` 先读 `user_settings`，再回落到全局默认；
  worker 从 job 数据里取 `userId`（`tasks.js` 入队时已带上）
- 列名 snake_case 与 JS 的 camelCase 之间做一层显式映射

受影响的调用文件共 6 个，都需补 `await`：
`worker.js`、`index.js`、`routes/auth.js`、`routes/notes.js`、`routes/providers.js`、
`routes/tasks.js`。

连接配置走 `.env`：

```
SUPABASE_URL=https://vamojyhymwsqovbmpugj.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
DATABASE_URL=postgresql://postgres.vamojyhymwsqovbmpugj:<password>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```

`.env` 已被 gitignore，密钥不会进入版本库，也不会进入 `web/` 打包产物。
连接串里的密码以 `%40` 转义 `@`，实际值只存在于 `.env`，本文件不记录。

## 数据迁移

一次性把 `storage/app.json` 导入新表：1 个用户、2 个 provider、13 条笔记、0 个任务。
原文件保留不删，作为回滚备份。迁移脚本放在 `server/scripts/`，随代码提交以便复查和重跑，
脚本本身幂等（按主键 upsert）。

## 验证

1. 连接层：脚本查询 `current_user`、`current_database()` 确认落到正确的项目
2. 结构层：确认五张表的 RLS 处于启用状态
3. 隔离层：两个测试用户各自插入笔记，交叉查询必须读不到对方数据
4. 暴露面：用 `sb_publishable_*` 经 REST 请求这五张表，必须全部被拒
5. 回归层：登录、任务列表、笔记保存、供应商切换四条主流程照常工作
6. 端到端：公网 `https://236963.xyz` 登录并完成一次任务

## 已知限制

- `express.static('/uploads')` 当前无鉴权，任何拿到 URL 的人都能读取上传素材。
  文件名是 nanoid 不可枚举，且素材多数本就要公开发布，故本次不改。若将来要收紧，
  需要改成签名 URL 或经后端代理，会牵动前端图片加载方式，属于独立改动。
- `api_key` 明文存库，未做加密。
- 单一 Supavisor 入口，session 模式连接数有限，连接池上限设为 5。
