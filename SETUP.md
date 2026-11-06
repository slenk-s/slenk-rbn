# 新电脑装机指南

把 Slenk Notes 搬到一台全新电脑，需要的东西如下。

## 必装（3 个）

| 软件 | 用途 | 说明 |
|---|---|---|
| **Node.js LTS**（≥ 20，推荐 22/24） | 跑 server / worker / web | 自带 npm，装它一个就够 |
| **Git** | 拉代码 | https://github.com/slenk-s/slenk-rbn |
| **Redis** | BullMQ 任务队列 | Windows 可装 Memurai 或 Redis 移植版，跑在默认 6379 即可 |

## 不用装

- **PostgreSQL** —— 数据库在 Supabase 云上（`.env` 的 `DATABASE_URL` 已指向），新机器不用装数据库
- **FFmpeg** —— worker 内置 `ffmpeg-static` 兜底，实况视频开箱可用（除非你想用自己的 FFmpeg，再配 `FFMPEG_PATH`）
- **cloudflared** —— 仅当需要 `https://236963.xyz` 公网访问；只在本机用不需要

## 需要从旧电脑拷贝的（不在 git 里）

| 文件/目录 | 必要性 | 说明 |
|---|---|---|
| `.env` | **必须** | 含 DATABASE_URL、REDIS_URL 等，git 不跟踪；`.env` 里 SUPABASE_* 三个键是遗留，server 已不读 |
| `storage/` | 可选 | 上传素材、生成的图/视频、notes-images 缓存；不拷则历史素材丢失，应用照常运行 |

## 步骤

```bash
git clone https://github.com/slenk-s/slenk-rbn.git
cd slenk-rbn
# 把旧电脑的 .env 拷到项目根目录（storage/ 可选）
npm --prefix server install
npm --prefix web install
```

启动（确保 Redis 已运行）：

```bash
npm run dev:server   # 后端 API + 静态页面，http://localhost:3001
npm run dev:queue    # 队列 worker（生图/视频任务）
npm run dev:web      # 可选：前端开发模式，http://localhost:5173
```

不用 dev:web 时先 `npm --prefix web run build`，访问 3001 即可。

## 注意

- `start-slenk-notes.bat` 硬编码了 `E:\Redis` 路径，新机器 Redis 不在该路径时不要用这个 bat，按上面命令启动。
- 首次登录：admin / 123456（云端数据库共享，账号与旧机器一致；登录后建议改密）。
