# 新电脑装机指南

把 Slenk Notes 搬到一台全新电脑，需要的东西如下。

## 必装（3 个）

| 软件 | 用途 | 说明 |
|---|---|---|
| **Node.js LTS**（≥ 20，推荐 22/24） | 跑 server / worker / web | 自带 npm，装它一个就够 |
| **Git** | 拉代码 | https://github.com/slenk-s/slenk-rbn |
| **MySQL 8** | 生产数据库（业务数据 + 媒体 BLOB） | 生产库在本机 MySQL（服务 `MySQL95`，`127.0.0.1:3306`），新机器必须装并迁移数据；**不用 MySQL 时可改 `SLENK_DATA_BACKEND=local` 走本地 JSON（见下文）** |
| **Redis** | BullMQ 任务队列 | 用 `E:\Redis`（8.10.3，`redis-windows` fork）；跑在默认 6379 即可 |

## 不用装

- **PostgreSQL** —— 生产库已从 Supabase（pg）迁到本机 MySQL，不需要；`SUPABASE_*` 仅测试库用
- **FFmpeg** —— worker 内置 `ffmpeg-static` 兜底，实况视频开箱可用（除非你想用自己的 FFmpeg，再配 `FFMPEG_PATH`）
- **cloudflared** —— 仅当需要 `https://236963.xyz` 公网访问；只在本机用不需要

## 需要从旧电脑拷贝的（不在 git 里）

| 文件/目录 | 必要性 | 说明 |
|---|---|---|
| `.env` | **必须** | 含 `DATABASE_URL=mysql://...@127.0.0.1:3306/slenk_notes`、`REDIS_URL`；`SUPABASE_*` 仅测试库用。运行时连接可被 `storage/db.json` 覆盖（仪表盘可改）。git 不跟踪 |
| `JWT_SECRET` | 强烈建议 | `.env` 中自行设置任意随机串；不设置时服务回退到仓库内置默认值，局域网内其他设备可伪造登录令牌访问 API（含小红书共享授权管理）。只在本机使用且无对外暴露时可接受 |
| `storage/` | 可选 | 上传素材、生成的图/视频、notes-images 缓存；不拷则历史素材丢失，应用照常运行 |

## 小红书凭证（不用拷贝）

每个用户的每个小红书账号的登录凭证存在项目目录 `storage/auth/<userId>/<accountId>/` 下（根目录可用 `.env` / 环境变量 `SLENK_XHS_AUTH_ROOT` 覆盖），**不要**从旧电脑拷贝，也不要随安装包分发：

- git 仓库中不含任何小红书 token；凭证由 redapp CLI 各自保存和续期，用户之间、账号之间完全隔离。
- 新机器首次使用时：在「小红书授权」卡片添加账号并扫码绑定；之后「扫码直达」发布时选择目标账号即可。
- 旧的共享凭证（`~/.skillhub-upload/`）不会自动迁移；沿用新模型需在新机器上重新扫码。
- 删除绑定的账号默认会一并删除对应凭证目录（可在前端勾选仅解绑保留）。
- 卸载项目即删除 `storage/auth/`；`~/.skillhub-upload/` 默认保留，确认不再使用时手动删除。

## 步骤

```bash
git clone https://github.com/slenk-s/slenk-rbn.git
cd slenk-rbn
# 把旧电脑的 .env 拷到项目根目录（storage/ 可选）
npm --prefix server install
npm --prefix web install
```

数据库（本机 MySQL 8，生产库不在云上）——先建库、建表，再决定是否迁数据：

```bash
# 建库 + 最小权限账号（或直接用 slenk 账号）
#   CREATE DATABASE slenk_notes;
#   CREATE USER 'slenk_app'@'localhost' IDENTIFIED BY '<pass>';
#   GRANT SELECT,INSERT,UPDATE,DELETE ON slenk_notes.* TO 'slenk_app'@'localhost';
# 建表（会自检表存在与权限）
DATABASE_URL="mysql://slenk_app:<pass>@127.0.0.1:3306/slenk_notes" node server/scripts/apply-schema.mjs
# 可选：把旧机 storage/app.json 数据按 id 幂等写入
node server/scripts/migrate-app-json.mjs
```

**不想装 MySQL？** 可用本地 JSON 模式：`.env` 设置 `SLENK_DATA_BACKEND=local`，业务数据（用户/供应商/任务/笔记/媒体）直接存 `storage/local/` JSON 文件，无需建库建表；供应商与用户数据会镜像到 TiDB Cloud（需 `.env` 配 `TIDB_PG_URL`，见 README「数据层（本地 JSON）」与「TiDB 云端同步」）。此模式跳过上面所有数据库步骤。

启动（确保 Redis、MySQL 已运行；本地模式只需 Redis）：

```bash
start-slenk-notes.bat    # 一键启动：自动探测 Node/Redis，构建前端，启动 API+worker，打开浏览器
npm run dev:server       # 手动：后端 API + 静态页面，http://localhost:3001
npm run dev:queue        # 手动：队列 worker（生图/视频任务）
npm run dev:web          # 可选：前端开发模式，http://localhost:5173
```

停止：`stop-slenk-notes.bat`。

不用 dev:web 时先 `npm --prefix web run build`，访问 3001 即可。

## 注意

- 一键启动 `start-slenk-notes.bat`（或 `start-slenk-notes.ps1`）会自动探测 Node 与 Redis 的位置（`E:\Redis` 8.10.3 / `F:\Node`，及旧路径 `D:\slenk\YLan\Redis`），无需手动改路径。
- 首次登录：admin / 123456（本机 MySQL，先建表/迁数据，账号与旧机器一致；登录后建议改密）。
