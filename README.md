# 原创笔记图工作台复刻版

## 当前实现
- 前端：React + Vite
- 后端：Express
- 账号：固定 `admin / 123456`
- AI：类似 `cc-switch` 的可切换供应商管理，不写死 SenseNova
- 队列：Redis + BullMQ
- 文件存储：本地自定义路径 `STORAGE_PATH`
- 视频：本地 FFmpeg 算法运镜
- 数据层：Supabase Postgres（见下文「数据层」一节）

## 本地依赖位置
Redis 已安装到：`E:\Redis`
- 启动：`E:\Redis\redis-server.exe redis.windows.conf`
- 检测：`E:\Redis\redis-cli.exe ping`

FFmpeg 已安装到：`E:\FFmpeg`
- `E:\FFmpeg\ffmpeg.exe`
- `E:\FFmpeg\ffprobe.exe`

项目 `.env` 已配置：
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
- 内置预设：OpenAI、OpenRouter、DeepSeek、Groq、SenseNova 开放平台
- 后端支持 OpenAI-compatible `/chat/completions` 和 `/images/generations`

## 数据层（Supabase Postgres）

业务数据（用户、用户设置、AI 供应商、任务、笔记）全部存放在 Supabase Postgres，服务运行期间不再读写 `storage/app.json`。

首次部署时，在仓库根目录按顺序执行：

```powershell
node server/scripts/apply-schema.mjs
node server/scripts/migrate-app-json.mjs
```

- `apply-schema.mjs` 创建五张 `slenk_notes_*` 表并自检 RLS 与权限；`migrate-app-json.mjs` 把 `storage/app.json` 的既有数据按 id 幂等写入，可重复执行。
- 五张表都开启了 RLS 且没有任何 policy，`anon` / `authenticated` / `PUBLIC` 的权限已全部收回：这些表不在 Supabase Data API 的暴露面上，只有后端通过 `DATABASE_URL` 直连才能访问。
- `storage/app.json` 与迁移前生成的备份 `storage/app.json.bak` 都原样保留，作为回滚路径：回滚到迁移前的代码并把 `.bak` 还原为 `app.json` 即可；数据库里的表可以留在原地，不影响回滚后的运行。
- 启动后端前必须在 `.env` 中配好 `DATABASE_URL`（Supavisor pooler 直连串，密码需 URL 编码）。缺失时后端会在启动阶段直接报错退出，不会静默回退到 JSON 文件。
- 数据库连接固定做 TLS 校验，CA 使用仓库内的 `server/certs/prod-ca-2021.crt`。Supabase 轮换根证书时必须把该文件替换为新证书，否则连接会在建立阶段直接失败（不会降级为不校验）。

## 运行
1. 启动 Redis：`E:\Redis\redis-server.exe redis.windows.conf`
2. 启动后端：`npm --prefix server run dev`（先在 `.env` 配好 `DATABASE_URL`，见「数据层」一节）
3. 启动队列 worker：`npm --prefix server run queue`
4. 启动前端：`npm --prefix web run dev`
5. 在网页中添加 AI 供应商并填入 API Key

```powershell
E:\Redis\redis-server.exe redis.windows.conf

npm --prefix server run dev
npm --prefix server run queue
npm --prefix web run dev
```

## 本地存储
当前配置目录：
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage`
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/uploads`
- `C:/Users/Administrator/Desktop/Pro/Slenk Notes/storage/videos`

视频生成通过本地 FFmpeg 处理，默认优先使用 `E:/FFmpeg/ffmpeg.exe`；如果不存在，则回退到项目内置 `ffmpeg-static`。
## 一键启动

在项目目录双击或运行：

```powershell
start-slenk-notes.bat
```

脚本会自动打开 4 个窗口：

- `Slenk Notes - Redis`
- `Slenk Notes - Server`
- `Slenk Notes - Queue Worker`
- `Slenk Notes - Web`

前端启动后访问：

```text
http://localhost:5173
```

如果端口已经被占用，先运行：

```powershell
stop-slenk-notes.bat
```

然后重新启动。
