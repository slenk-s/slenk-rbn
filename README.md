# 原创笔记图工作台复刻版

## 当前实现
- 前端：React + Vite
- 后端：Express
- 功能页：仪表盘 + 5 个任务页（AI 生图 / 替换生图 / 实况视频 / 笔记改写 / 商品下载），均支持多图输入，见下文「功能页与多图任务」
- 账号：本地 JSON 或 MySQL 中的用户账号（默认本地模式；首次初始化会创建 `admin / 123456`，登录后建议修改）
- AI：类似 `cc-switch` 的可切换供应商管理，不写死 SenseNova
- 队列：Redis + BullMQ（失败自动重试，`server/src/worker.js` 的 `isRetryableError` 区分网络/超时可重试与输入/配置类不可重试）
- 文件存储：上传/视频/笔记图缓存存本地 `STORAGE_PATH`；生成媒体在 MySQL 模式入 `slenk_notes_media` BLOB（`/api/media/:id` 读回），本地模式存 `storage/local/media/` 文件
- 视频：本地 FFmpeg 算法运镜
- 数据层：默认本地 JSON（`storage/local/`，不用 MySQL）；设 `SLENK_DATA_BACKEND=mysql` 切回 MySQL。见下文「数据层」两节；本地模式下供应商/用户数据镜像到 TiDB Cloud
- HTTP：文本响应 gzip 压缩（compression 中间件）；生产经 cloudflared 隧道（`protocol: http2`，避开本机 QUIC/UDP 7844 断连波动）

## 本地依赖位置
Redis 使用 `E:\Redis`（8.10.3，`redis-windows/redis-windows` fork 的 msys2 构建），启动器自动探测：
- 启动：`start-slenk-notes.bat`（以 `--appendonly yes --appendfsync everysec` 启动，AOF 持久化到 `storage\redis`）
- 检测：`redis-cli.exe -p 6379 ping` 应返回 `PONG`
- 旧版回滚：`E:\Redis-5.0.14.bak`（旧二进制）与 `storage/redis-5.0.14.bak`（旧 AOF 数据）

FFmpeg 解析顺序（`server/src/worker.js`）：`.env` 的 `FFMPEG_PATH` → `E:/FFmpeg/ffmpeg.exe` → 项目内置 `server/node_modules/ffmpeg-static/ffmpeg.exe`：
- 本机 `.env` 指向 `E:/FFmpeg/ffmpeg.exe`；新机器没装 FFmpeg 时删掉该项（或改成内置路径）即可回退 `ffmpeg-static`
- 也可自备 FFmpeg 并改 `.env` 指向自定义路径

本机 `.env` 相关配置：
```env
REDIS_URL=redis://localhost:6379
FFMPEG_PATH=E:/FFmpeg/ffmpeg.exe
FFMPEG_FFPROBE_PATH=E:/FFmpeg/ffprobe.exe
```

## AI 供应商管理
登录后进入工作区顶部的「AI 供应商」：
- 添加 / 编辑 / 删除供应商
- 设置 Base URL、API Key、文案模型、图片模型
- 切换当前启用供应商
- 内置预设：OpenAI、OpenRouter、DeepSeek、Groq、SenseNova 开放平台、GPT-image 中转站
- 后端支持 OpenAI-compatible `/chat/completions` 和 `/images/generations`
- 生图供应商可选「生图接口」形态：
  - `OpenAI JSON 兼容`（默认）：图生图走 JSON + Data URL（SenseNova 等）。
  - `GPT-image 中转站（multipart 编辑）`：文生图走 `/images/generations` JSON；图生图走 `/images/edits` 的 multipart/form-data（单图字段 `image`，多图 `image[]`）；响应按 `b64_json` 解析；请求超时 300s，429/5xx 自动指数退避重试。模型填 `turing/gpt-image-2`、`turing/gpt-image-2.5-flare`（快）或 `turing/gpt-image-2.5-sunburst`（画质）。

## 功能页与多图任务

工作区共 6 个页面：仪表盘（无任务）和 5 个任务页。任务统一进 Redis 队列 `ai-tasks`，记录 `type`（`image` / `video` / `rewrite`）和 `tab`，结果回显到提交时的页面。所有上传入口单次最多 **9 个文件**（`multer` 的 `upload.array('file', 9)` 与前端同样限制），单文件 ≤ 25MB。

| 页面 | 任务类型 | 多图行为 |
| --- | --- | --- |
| AI 生图 | `image` | 多参考图生成，可选「合成一张」或「按参考图一一对应」，每图输出 1–4 张 |
| 替换生图 | `image` | 多参考图替换，默认按参考图一一对应，结果标注「对应参考图 N」 |
| 实况视频 | `video` | 每张输入图各出一条 MP4，顺序与输入一致 |
| 笔记改写 | `rewrite` / `image` | 多图配文 + 逐张重新生成配图 |
| 商品下载 | — | 解析笔记/商品链接，多图缓存与逐张下载 |

### 生图：两种参考图模式

- **按参考图一一对应**（`perReference: true`，默认）：每张参考图单独请求一次 `/images/edits`，总输出 = 参考图数 × 每图张数（`count`）。结果字段 `imageReferences: [1,2,3,…]` 记录每张输出对应的参考图号，页面标注「对应参考图 N」。参考图上限 **9 张**（`server/src/lib/referenceImages.js` 的 `MAX_PER_REFERENCE_IMAGES`）。
- **合成一张**（取消勾选，`perReference: false`）：所有参考图放进同一次请求（OpenAI JSON 模式为多个 Data URL；GPT-image 中转站为 multipart `image[]`），总输出 = `count`。服务端最多接收 **2 张**参考图（`MAX_REFERENCE_IMAGES`），超出的部分会被截断，只在 worker 日志（`logs/worker.err.log`）打印「参考图超过 2 张上限…」，前端目前不做提示。

其他约定：
- 每图输出数量 `count` 为 1–4（默认 1）；画布 `auto` 跟随参考图原始比例，固定画布（如 `1080x1440`）严格按画布出图。
- 出图质量 `quality`：`medium`（页面显示「快速出图」，默认）或 `high`（「高清出图」）。
- 同一任务内的生图请求并发由 `IMAGE_REQUEST_CONCURRENCY` 控制（默认 2，上限 4）。

### 实况视频：多图多片

- 一张输入图生成一段视频，结果 `videos` / `localVideos` 按输入顺序一一对应（`localVideoPath` 是第一条的本地路径），页面按「视频 1 / 视频 2 / …」展示，可逐条预览、下载。
- 时长 1–8 秒（前端当前以固定时长提交）；运镜效果、强度、频率在页面选项区调整。
- FFmpeg 并发由 `VIDEO_CONCURRENCY` 控制（1–4，默认 2；FFmpeg 吃 CPU，过高反而互相争抢）。

### 笔记改写：多图配文与逐张配图

- 图片管理最多 9 张，第一张为封面，可拖动排序；发布时最多带 9 张图。
- **文本生成（标题/正文/标签）不会把参考图发给模型**（`server/src/worker.js` 里 `referenceImages = [] // 文本生成不传参考图`），只用文字素材；图片仅用于预览和配图生成，这样可避免多图把请求体撑大。
- 「重新生成配图」按图逐张提交 `purpose: 'noteImage'` 的 `image` 任务（每张 1 个参考图、`perReference: true`、`count: 1`），前端并行上限默认 2，可在图片管理旁调整为 1–9。

### 商品下载：链接解析与多图下载

- 粘贴小红书笔记链接或商品链接，`POST /api/notes/parse` 解析标题、正文、标签和图片；商品链接走商品详情接口取商品图。
- 解析出的图片缓存到 `storage/notes-images/`（缩到宽 1080 的 JPEG；并发 4、总预算 25s，个别图失败不阻塞整体解析），页面显示「商品图片 1/2/3…」。
- 单图下载走 `GET /api/download?url=…`，只接受绝对 `http(s)` URL（前端会自动把相对路径拼成 `API + path`）；HEIC 图自动回退取 JPEG 变体。

## 数据层（本机 MySQL，`SLENK_DATA_BACKEND=mysql`）

本机 MySQL 8（服务 `MySQL95`，`127.0.0.1:3306`）是**可选的**数据后端：设 `SLENK_DATA_BACKEND=mysql`（默认未设置时为本地 JSON，见下一节）后启用。业务数据（用户、用户设置、AI 供应商、任务、笔记）全部存放在 MySQL，生成媒体（图/视频）存 `slenk_notes_media` 表（LONGBLOB）。

- **连接**：`.env` 的 `DATABASE_URL=mysql://<user>:<pass>@127.0.0.1:3306/slenk_notes`（mysql2 驱动，`server/src/db.js`）。**运行时连接可被 `storage/db.json` 覆盖**（gitignored，仪表盘「数据库连接」可改，保存后 server/worker 下次查询自动重连）；App 运行时账号为最小权限（仅 SELECT/INSERT/UPDATE/DELETE on `slenk_notes.*`），`slenk`（ALL PRIVILEGES）留给迁移/测试。
- **首次建表**：`node server/scripts/apply-schema.mjs`（创建 `slenk_notes_*` 表并自检）；`migrate-app-json.mjs` 可把旧 `storage/app.json` 数据按 id 幂等写入。
- **旧数据迁移**：`mysqldump`（含媒体 BLOB，用 `--single-transaction --quick`）→ 新机 `mysql` 导入。
- **测试**：`TEST_DATABASE_URL` 指向一次性测试库（未设置回退到 `DATABASE_URL` 并打印警告）；跑测试前 `npm --prefix server run test:db`。
- **历史**：生产库已从 Supabase（pg）迁到本机 MySQL（2026-11-15），`SUPABASE_*` 仅测试库用；`storage/app.json` + `app.json.bak` 保留作回滚路径。

## 数据层（本地 JSON，默认模式）

业务数据默认完全不依赖 MySQL，直接存本地 JSON 文件。`server/src/store.js` 按 `SLENK_DATA_BACKEND` 选择后端：未设置或 `=local` → `store.local.js`；`=mysql` → `store.mysql.js`（两者导出接口一致，路由/worker/认证零改动）。本地模式无需 MySQL、无需建表。

- **数据位置**：每张「表」一个文件，`storage/local/<table>.json`（`users.json` / `user_settings.json` / `providers.json` / `tasks.json` / `notes.json` / `xhs_accounts.json`）；媒体不再入 BLOB，而是 `storage/local/media/<id>` 文件 + `storage/local/media.json` 元数据。
- **一致性**：`store.local.js` 不做内存缓存，每次读写都重读文件（file-as-truth），保证 server 与 worker 跨进程一致。
- **时间戳**：与 MySQL `UTC_TIMESTAMP(3)` 对齐，格式 `YYYY-MM-DD HH:MM:SS.mmm`（UTC）。
- **接口降级**：`GET /api/settings/db` 在本地模式返回 `{storage:'local', source:'local'}`，仪表盘「数据库连接」卡显示本地模式说明；`POST /db`、`POST /db/test`、`DELETE /db` 返回 `400 local_storage`（MySQL 连接管理不适用）。
- **默认账号**：首次启动自动创建 `admin / 123456`（与 MySQL 模式一致，登录后建议修改）。

## TiDB 云端同步（本地模式）

本地模式下，**供应商与用户数据**会镜像到 TiDB Cloud（PostgreSQL 兼容集群），供仪表盘功能页云端读取；其余业务数据（任务/笔记/媒体）仅本地，不同步。

- **连接**：`.env` 的 `TIDB_PG_URL=postgresql://<user>:<pass>@<host>.gateway01.us-east-1.prod.aws.pg.tidbcloud.com:5432/postgres`（集群直连串，非管理 API）。
- **目标表**：`slenk_cloud_sync`（`kind` / `id` / `data JSONB` / `updated_at`，主键 `(kind,id)`），启动时 `CREATE TABLE IF NOT EXISTS` 自建。
- **机制**：`server/src/syncTiDB.js` —— 供应商/用户每次增删改后防抖 1.5s 触发一次全量镜像（幂等 upsert + 删除本地已删的行，保持镜像一致）；`TIDB_PG_URL` 未配置则静默跳过（离线无云）。
- **注意**：TiDB Cloud 管理 API（`TIDB_API_*` 密钥）只能管理集群、不能执行 SQL；写数据必须用 `TIDB_PG_URL` 直连。`TIDB_API_*` 用于列出集群/取连接串，不用于数据读写。

## 运行

1. 一键启动：双击 `start-slenk-notes.bat`（或运行 `start-slenk-notes.ps1`）
   - 自动探测 Node / Redis（`E:\Redis` 8.10.3 → PATH → 旧路径 `D:\slenk\YLan\Redis`）
   - 自动安装缺失依赖、构建前端、启动 Redis + API(3001) + 队列 worker，最后打开浏览器
2. 停止：双击 `stop-slenk-notes.bat`（只停止本仓库启动的 API/worker；Redis 默认保留，需一并停止时用 `-StopRedis`）
3. 手动启动（可选）：`npm --prefix server run dev`（需先在 `.env` 配好 `DATABASE_URL`，见「数据层」一节）
4. 首次登录：`admin / 123456`
5. 在网页中添加 AI 供应商并填入 API Key（工作区顶部「AI 供应商」）

## 本地存储
当前配置目录（`STORAGE_PATH` 可整体覆盖）：
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage`
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/uploads`
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/videos`
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/notes-images`（笔记图缓存）
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/redis`（Redis AOF 持久化目录）
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/auth`（每用户每小红书账号一个凭证子目录，可用 `SLENK_XHS_AUTH_ROOT` 覆盖）
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/local`（`SLENK_DATA_BACKEND=local` 时的 JSON 表文件与媒体文件）

视频生成通过本地 FFmpeg 处理，解析顺序见上文「本地依赖位置」。

## 内置 Skill（小红书小工具）

项目在 `.skills/` 内置两个小红书小工具 Skill，通过 `setup-skills.ps1` 创建
目录联接（junction），让 Codex（`.codex/skills/`）和 Claude Code
（`.claude/skills/`）都能发现：

- `redapp-cli` — 管理/CLI：本地调试、查询、上传、预览、送审、编辑小工具
- `minitool-zip-builder` — 开发规范：把 H5 打包成合规离线 `.zip` 并校验

新机器克隆后先运行一次：

```powershell
.\setup-skills.ps1
```

详见 `AGENTS.md`。

## 小红书授权（每用户多账号，互相隔离）

每个 Slenk 用户可绑定**多个**小红书账号，用户之间完全隔离：各自只能看到、使用和删除自己的账号；不同用户可以各自绑定同一个小红书账号（分别扫码、互不影响）。

- **添加账号**：在「小红书授权」卡片点击添加，系统先创建一条「待扫码」记录并自动弹出授权二维码；用小红书 App 扫码后 openId 自动匹配回填到该记录（无需手动填账号）。若扫出的 openId 已属于该用户的另一个账号，本次待绑定记录与新目录会被自动清理。
- **凭证目录**：每个账号一个独立目录，默认 `storage/auth/<userId>/<accountId>/`，可用环境变量 `SLENK_XHS_AUTH_ROOT` 覆盖根目录（安装包场景）。凭证不进 git，不随项目分发。
- **按账号发布**：发布时在「扫码直达」里选择目标账号（只有已绑定账号可选，待扫码的不出现在选择器）；whoami / 上传 / 预览都按所选账号的凭证目录执行。
- **删除账号**：默认同时删除磁盘上的凭证文件；勾选「同时删除凭证文件」可取消以仅解绑、保留凭证。删除操作只影响自己的账号。
- **管理员只读**：管理员可在后端查询全量账号（脱敏：掩码 openId、目录尾段），只读，无任何管理操作接口；非管理员返回 403。
- **凭证安全**：access/refresh token 的续期完全由 CLI 负责，前端只显示脱敏状态（掩码 openId、授权范围、到期时间、目录尾段提示），任何 API 响应都不会包含 token、完整 openId 或凭证绝对路径。
- **旧共享凭证**：本机旧的单份共享凭证（`~/.skillhub-upload/`）**不会自动迁移**到新模型，也不受影响；继续使用需在新模型下重新扫码绑定各账号。
- **卸载**：删除项目目录会一并删除 `storage/auth/` 下的凭证；`~/.skillhub-upload/` 默认保留（避免误伤其他使用同一 CLI 的工具），需要彻底清除时手动删除该目录。
