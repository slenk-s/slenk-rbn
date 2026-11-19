# 只保留 MySQL 与 SQLite、媒体字节存文件的数据层设计

**日期：** 2026-11-19

## 背景

当前数据层有三个后端：`store.mysql.js`（业务数据进 MySQL，媒体以 `longblob` 存 `slenk_notes_media`）、`store.local.js`（业务数据存 `storage/local/*.json`，媒体存 `storage/local/media/`），由 `SLENK_DATA_BACKEND` 选择，未设置时默认 local。本地 JSON 后端是为了在没有 MySQL 的机器上跑通而加的，现在 Node 24 自带 `node:sqlite`，可以用真正的数据库替代它，同时把媒体字节从数据库里拿出来。

目标：

1. 后端只保留 `sqlite` 与 `mysql`，`sqlite` 为本机默认；删除 local JSON 后端。
2. 两个后端的媒体字节一律存文件，数据库只存元数据。
3. 现有本地 JSON 里的用户与供应商导入 SQLite；任务、笔记、媒体不导入。
4. TiDB Cloud 的供应商/用户同步继续保留，挂在 SQLite 后端上。
5. 测试默认使用 SQLite 临时库，不再依赖 MySQL。

非目标：不迁移 MySQL 已有的 14 条媒体 blob（8.7 MB），不迁移本地 42 个媒体文件与 5 篇笔记，不改任务队列、上传流程、XHS 授权目录结构，不改 TiDB 云端表结构。

## 决策摘要

- 结构采用双适配器：保留并改造 `store.mysql.js`，新写 `store.sqlite.js`，媒体读写抽成共享模块。不引入 ORM 或统一方言层。
- SQLite 使用 Node 内置 `node:sqlite`（本机 Node v24.22.2 已验证可用），不新增原生依赖。
- SQLite 文件默认 `<dataDir>/slenk.sqlite`；媒体默认 `<dataDir>/media/<id>`。
- `storage/local/` 原样保留，作为迁移来源与冷备，不删除。
- 旧数据断链是已确认的取舍：只迁 `users`、`providers`、`user_settings`，其余旧任务/笔记/媒体链接会失效。

## 总体架构

调用方（routes / worker / auth / lib）继续只 import `store.js`。`store.js` 按 `SLENK_DATA_BACKEND` 分派：

- `SLENK_DATA_BACKEND=sqlite`，或未设置 → `store.sqlite.js`
- `SLENK_DATA_BACKEND=mysql` → `store.mysql.js`
- 其它值 → 启动阶段抛错，不做兜底

两个适配器互不 import，实现同一份函数契约：

- 现有 39 个导出函数（用户、任务、供应商、笔记、媒体、XHS 账号、两个 janitor 扫描函数）
- 新增 `initStore()`、`closeStore()`、`exportSyncRows()`、`importSyncRows()`

媒体字节统一走新模块 `server/src/lib/mediaFiles.js`，两个适配器共用。`getMedia()` 仍返回带 `data: Buffer` 的对象，`routes/media.js` 与 worker 的媒体输入物化逻辑不需要改。

## 配置与路径

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `SLENK_DATA_BACKEND` | `sqlite` | 仅接受 `sqlite` / `mysql` |
| `SQLITE_PATH` | `<dataDir>/slenk.sqlite` | SQLite 数据库文件；测试指向临时文件 |
| `MEDIA_DIR` | `<dataDir>/media` | 媒体字节目录，两个后端共用 |
| `DATABASE_URL` / `storage/db.json` | 不变 | 仅 MySQL 后端使用 |

`dataDir` 继续由 `STORAGE_PATH` 决定。`server/src/paths.js` 增加 `sqlitePath`、`mediaDir` 两项，其余路径不变。`.env.example` 增加这三项及取值说明。本机现有 `.env` 若显式写了 `SLENK_DATA_BACKEND=local`，实施时一并改为 `sqlite`（该文件不入库）。

## 数据模型

### SQLite 类型映射

沿用同一套表名与列名，按 SQLite 存储类映射：

| MySQL | SQLite |
| --- | --- |
| `varchar` / `longtext` | `TEXT` |
| `tinyint(1)` 布尔 | `INTEGER`，0/1 |
| `datetime(3)` | `TEXT`，UTC ISO-8601 |
| `json` | `TEXT`，适配器写入 `JSON.stringify`、读取 `JSON.parse` |
| `bigint` | `INTEGER` |

时间默认值用 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`，形如 `2026-11-19T10:23:45.123Z`，与 mysql2 返回的 Date 经 JSON 序列化后的格式一致。

约束照搬：主键、`unique(username)`、`unique(credential_dir)`、`unique(user_id, open_id)`、外键 `ON DELETE CASCADE` / `SET NULL`。SQLite 唯一索引同样允许多个 NULL，待绑定账号语义不变。`(user_id, created_at desc)` 索引保留。

新增内部表：

```sql
create table if not exists slenk_notes_meta (
  key text primary key,
  value text not null
);
```

用于记录一次性导入标记等运维状态，不对外暴露。

### 媒体元数据

`slenk_notes_media` 保留 `id, task_id, user_id, filename, mime_type, size_bytes, created_at`，不存路径（路径由 id 推导）。MySQL 与 SQLite 的媒体表结构一致。`created_at` 默认值按各自方言处理。

### DDL 文件

新增 `server/scripts/schema.sqlite.sql`，与 `schema.mysql.sql` 并列。SQLite 适配器在 `initStore()` 中读取并执行（`DatabaseSync.exec` 支持多语句），全部使用 `create table if not exists` / `create index if not exists`，可重复执行。

## 媒体文件层

新增 `server/src/lib/mediaFiles.js`：

- `mediaPath(id)`：`<mediaDir>/<id>`
- `writeMediaFile(id, buffer)`：先写 `<id>.<pid>.<rand>.tmp`，`rename` 为正式文件，返回文件大小
- `readMediaFile(id)`：读取 Buffer；文件不存在返回 `null`
- `removeMediaFile(id)`：`unlink`，不存在视为成功
- `removeMediaFiles(ids)`：批量删除

写入顺序固定为「临时文件 → rename → 插入元数据行」；插行失败时删除正式文件。读取顺序为「查元数据行 → 读文件」：

- 有行无文件：返回 `null`（接口 404），记一条警告
- 有文件无行：不对外提供，视为孤儿

删除用户：先查出该用户全部媒体 id，删除用户（外键级联清行），再逐个删除文件。外键级联不碰文件系统，两个适配器都必须显式做这一步。

新增巡检脚本 `server/scripts/media-janitor.mjs`：默认只列出「有行无文件」与「有文件无行」，加 `--delete` 才删除孤儿文件。扫描时忽略 `*.tmp`（正在写入的临时文件）。不做开机自动清理。

## MySQL 侧改造

- `server/scripts/schema.mysql.sql` 删除 `slenk_notes_media.data` 列。
- `insertMedia` / `getMedia` 改为调用 `mediaFiles`；`getMedia` 先查元数据行、再读文件。
- 删除用户的媒体文件清理逻辑与 SQLite 相同。
- 新增一次性迁移脚本 `server/scripts/migrate-media-files.mjs`：
  1. 检查 `information_schema.columns`，`data` 列存在才执行 `alter table slenk_notes_media drop column data`；
  2. 删除存量媒体行（未迁移的旧 blob，保留行只会得到 404）；
  3. 可重复执行。
- 该脚本在部署/升级时手动执行一次。不执行时新插入会因 `data not null` 失败，SETUP 中标注为必跑步骤。

## 启动流程与一次性导入

`store.sqlite.js` 首次被调用时打开单例连接：解析 `SQLITE_PATH`、创建父目录、执行 schema、设置：

- `PRAGMA journal_mode=WAL`
- `PRAGMA busy_timeout=5000`
- `PRAGMA foreign_keys=ON`

server 在 `listen` 前 `await initStore()`，worker 在创建消费者前同样调用。`initStore()` 依次执行：

1. 建表（幂等）
2. `importLocalOnce()`
3. `ensureAdmin()`

失败直接抛出，进程以退出码 1 结束，不等到第一个请求才报错。

### importLocalOnce

条件（三个同时满足）：

- `slenk_notes_meta` 中没有 `local_import_v1`
- SQLite 的 `slenk_notes_users` 为空
- `storage/local/users.json` 存在

在 `BEGIN IMMEDIATE` 事务内重新检查条件，然后导入：

- `users.json` → `slenk_notes_users`
- `providers.json` → `slenk_notes_providers`
- `user_settings.json` → `slenk_notes_user_settings`

最后写入 `local_import_v1 = <ISO 时间>`。标记保证以后即使用户删光也不会二次导入。导入前把 JSON 中的 `YYYY-MM-DD HH:MM:SS.mmm` 时间戳规范化为 `YYYY-MM-DDTHH:MM:SS.mmmZ`，与 MySQL 后端输出一致。

源文件只读。`tasks`、`notes`、`xhs_accounts`、`media.json` 及其媒体文件不导入。

### ensureAdmin

与现有行为一致：无 `admin` 用户时创建（密码 `123456`，管理员），并创建对应 `user_settings` 行。SQLite 下用 `insert ... on conflict (username) do nothing`，随后查询 id，避免 server/worker 同时启动时插重。

## TiDB 同步

断开循环依赖：

- `server/src/syncTiDB.js` 不再直接读写 `storage/local/*.json`。
- 导出 `pushProvidersUsers(providers, users)`：沿用现有幂等镜像逻辑（`kind,id` 主键 upsert，按 id 集合删除云端多余行）。
- 导出 `fetchCloudProvidersUsers()`：读取云端 `kind in ('provider','user')` 的 `data` 行。
- `scheduleSyncProvidersUsers(delay, loadRows)` 只做防抖：到期后调用 `loadRows()` 取最新行再推送。SQLite 适配器传入 `() => exportSyncRows()`。

store 契约新增：

- `exportSyncRows()` → `{ providers, users }`，返回原始 snake_case 行，TiDB 云端数据格式不变
- `importSyncRows({ providers, users })` → 按 id upsert 与新增，不删除本地行

SQLite 适配器在 providers / users 写入成功后调用 `scheduleSyncProvidersUsers()`，触发时取 `exportSyncRows()` 推送。

启动拉取从 `index.js` 编排，条件由「非 mysql」改为「等于 sqlite」：

1. `const { providers, users } = await exportSyncRows()`
2. `fetchCloudProvidersUsers()`
3. `mergeProviders` / `mergeUsers`
4. 有变化则 `importSyncRows(merged)` 并 `pushProvidersUsers(merged)`

保持现有语义：供应商按 `updated_at` 新者胜，用户冲突保本地，云端删除不向下传播。

## 错误处理

- SQLite 打开失败（路径不可写、文件损坏）：启动阶段抛错并退出。
- `SQLITE_BUSY`：适配器等待 250ms 重试一次；仍失败抛 `code='STORAGE_BUSY'`，全局错误中间件映射为 `503 { error: 'storage_busy' }`。
- `SQLITE_CORRUPT` / `SQLITE_NOTADB`：不自动重建、不覆盖原文件，直接失败并提示检查 `SQLITE_PATH`。
- 媒体写入任一步失败都清理临时/正式文件，不留「有行无文件」或半截文件。
- 删除用户的媒体文件失败：记录警告，不阻断删除用户；孤儿文件由巡检脚本兜底。
- TiDB 同步失败：保持现有行为，只记日志，不影响本地读写；下一次变更或启动时重试。

## 测试

- 新增 `server/test/env.mjs`，作为每个测试文件的第一条 import：创建临时目录，设置 `SLENK_DATA_BACKEND=sqlite`、`SQLITE_PATH=<tmp>/test.sqlite`、`MEDIA_DIR=<tmp>/media`，进程退出时递归删除。
- `server/test/helpers.mjs` 的 `createTestUser` 改用 store 的 `createUser` / `deleteUser`，不再直接查 `db.js`。
- 以下测试文件改连接清理为 `closeStore()`，其余用例保持：`cacheJanitor`、`media`、`notes`、`providers`、`tasks`、`users`。
- `server/test/db.test.mjs` 是真实 MySQL 连接测试，仅当 `TEST_DATA_BACKEND=mysql` 时运行，否则整体跳过；`package.json` 增加 `test:mysql` 脚本显式启用。
- `server/test/db-config.test.mjs` 是纯函数测试，不改，继续运行。
- 同一组 store 测试通过环境变量即可切到 MySQL 执行，作为两个适配器的契约测试，不复制用例。
- 新增测试：媒体文件层（写读删、行缺失、文件缺失、删除用户清理文件）、SQLite 导入（只导三张表、标记幂等、时间戳规范化）、后端选择（非法值抛错）。
- web 测试不变（`node --test "test/*.test.mjs"`）。

## 前端与文档

- `server/src/routes/settings.js`：`isLocalBackend` 改为 `backend === 'sqlite'`；`GET /api/settings/db` 在 SQLite 下返回 `{ storage: 'sqlite', path, mediaDir }`；写接口返回 `400 { error: 'sqlite_storage' }`（原 `local_storage` 更名）。
- `web/src/App.jsx`：
  - 设置页 SQLite 分支显示「SQLite」徽标、数据库文件路径与媒体目录；说明切换 MySQL 需改 `SLENK_DATA_BACKEND` 并重启。
  - 仪表盘存储徽标 `Local` → `SQLite`。
  - 上传成功文案「已保存到本地存储路径」→「已保存到素材目录」。
- `README.md` / `SETUP.md` / `AGENTS.md` / `.env.example`：
  - 默认 SQLite，两个后端的配置与启动方式；
  - 媒体目录说明；
  - MySQL 升级必跑 `migrate-media-files.mjs`；
  - TiDB 同步只跟 SQLite；
  - 删除 local JSON 后端的描述，保留「`storage/local/` 为旧数据备份」的说明。

## 改动清单

| 文件 | 动作 |
| --- | --- |
| `server/src/store.js` | 改为 sqlite/mysql 分派，非法值抛错，新增 4 个导出 |
| `server/src/store.sqlite.js` | 新增，实现完整契约 |
| `server/src/store.local.js` | 删除 |
| `server/src/store.mysql.js` | 媒体读写改文件，用户删除清理媒体文件，新增契约函数 |
| `server/src/lib/mediaFiles.js` | 新增 |
| `server/src/paths.js` | 增加 `sqlitePath` / `mediaDir` |
| `server/scripts/schema.sqlite.sql` | 新增 |
| `server/scripts/schema.mysql.sql` | 删除 `data` 列 |
| `server/scripts/migrate-media-files.mjs` | 新增 |
| `server/scripts/media-janitor.mjs` | 新增 |
| `server/src/syncTiDB.js` | 改为纯数据函数，去掉 JSON 读写 |
| `server/src/index.js` | `initStore()` 后监听；TiDB 拉取条件改 sqlite |
| `server/src/worker.js` | 启动前 `initStore()` |
| `server/src/routes/settings.js` | SQLite 分支与错误码 |
| `web/src/App.jsx` | 设置页、仪表盘徽标、上传文案 |
| `server/test/env.mjs` / `helpers.mjs` | 测试环境与建用户方式 |
| `server/test/*.test.mjs` | 6 个改连接清理，1 个 MySQL 专属加跳过 |
| `README.md` / `SETUP.md` / `AGENTS.md` / `.env.example` | 文档更新 |

## 风险与取舍

- **旧数据断链**：只迁 users/providers，旧任务、笔记、媒体链接失效。已确认接受。
- **SQLite 单写者**：server 与 worker 并发写靠 WAL + `busy_timeout` + 一次重试；极端持续写会返回 503，前端可重试。任务量级下可接受。
- **两份 schema 漂移**：用同一组 store 契约测试跑两个后端约束行为；MySQL 测试为显式 opt-in，默认 CI 只覆盖 SQLite。
- **媒体文件与数据库不一致**：写入顺序与清理逻辑收敛在 `mediaFiles`，巡检脚本兜底；不做自动删除。
- **删除用户不可逆**：会删除媒体文件；这是现有语义（数据库级联删行）的延伸，文档中明确。
- **Windows 文件锁**：`getMedia` 一次性 `readFileSync` 到 Buffer，返回后句柄已关闭，删除文件不会与正在发送的响应冲突。

## 验收标准

1. 没有 MySQL、没有预置数据时，`npm test`（server）与 web 测试全绿。
2. 本机以 SQLite 启动 server + worker：
   - 首次启动导入 users/providers，`admin / 123456` 可登录；
   - 生图任务完成，`/api/media/<id>` 从 `<dataDir>/media/` 读回，字节一致；
   - 删除用户后其媒体文件被清理。
3. `SLENK_DATA_BACKEND=mysql` + `migrate-media-files.mjs` 后，同样的手工链路可用。
4. TiDB 未配置时同步静默跳过；配置后启动拉取与变更推送行为与现状一致。
5. 设置页与仪表盘显示 SQLite 信息，不再出现 `local` 模式文案。
