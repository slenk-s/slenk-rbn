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
| `.env` | **必须** | 含 DATABASE_URL、REDIS_URL，以及生成结果云存储使用的 SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_STORAGE_BUCKET；git 不跟踪 |
| `JWT_SECRET` | 强烈建议 | `.env` 中自行设置任意随机串；不设置时服务回退到仓库内置默认值，局域网内其他设备可伪造登录令牌访问 API（含小红书共享授权管理）。只在本机使用且无对外暴露时可接受 |
| `storage/` | 可选 | 上传素材、生成的图/视频、notes-images 缓存；不拷则历史素材丢失，应用照常运行 |

## 小红书凭证（不用拷贝）

redapp 登录凭证保存在各机器的 Windows 用户目录 `~/.skillhub-upload/`，**不要**从旧电脑拷贝，也不要随安装包分发：

- 安装包 / git 仓库中不含任何小红书 token；凭证由 redapp CLI 各自保存和续期。
- 新机器首次「扫码直达」发布时会自动弹出授权二维码，用小红书 App 扫码即可，授权后原发布自动继续。
- 本机所有 Slenk 用户共享这份凭证：任何登录用户都可在「小红书授权」卡片查看状态、重新授权或退出；退出会影响本机全部用户。
- 卸载项目默认保留 `~/.skillhub-upload/`；确认不再使用时手动删除该目录。

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
start-slenk-notes.bat    # 一键启动：自动探测 Node/Redis，构建前端，启动 API+worker，打开浏览器
npm run dev:server       # 手动：后端 API + 静态页面，http://localhost:3001
npm run dev:queue        # 手动：队列 worker（生图/视频任务）
npm run dev:web          # 可选：前端开发模式，http://localhost:5173
```

停止：`stop-slenk-notes.bat`。

不用 dev:web 时先 `npm --prefix web run build`，访问 3001 即可。

## 注意

- 一键启动 `start-slenk-notes.bat`（或 `start-slenk-notes.ps1`）会自动探测 Node 与 Redis 的位置（winget 包 → PATH → 旧路径 `E:\Redis` / `F:\Node` / `D:\slenk\YLan\Redis`），无需手动改路径。
- 首次登录：admin / 123456（云端数据库共享，账号与旧机器一致；登录后建议改密）。
