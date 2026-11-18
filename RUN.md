# 运行速查

## 推荐：一键启动

```powershell
.\start-slenk-notes.bat
```

启动器会：

1. 自动探测 Node.js（PATH → `F:\Node` 回退）
2. 自动探测 Redis server/cli（WinGet → PATH → `E:\Redis` / `D:\slenk\YLan\Redis`）
3. 检查 `.env`
4. 安装缺失依赖并构建 Web
5. 验证 Redis `PING` 返回 `PONG`
6. 后台启动或复用 API（3001）与 Worker
7. 打开 `http://localhost:3001/`

日志位于 `logs/server*.log`、`logs/worker*.log`。

## 手动开发

```powershell
npm run dev:server
npm run dev:queue
npm run dev:web
```

- API/生产构建：`http://localhost:3001/`
- Vite 开发模式（HMR）：`http://localhost:5173/`
- Redis：`redis-cli.exe -p 6379 PING` 应返回 `PONG`

## 多图任务自检（可选）

登录后每个功能页上传 2–3 张图提交一次，确认任务落在正确页面、结果张数符合预期：

| 页面 | 操作 | 预期 |
| --- | --- | --- |
| AI 生图 | 3 张参考图 + 输出数量 2，取消「按参考图一一对应」 | 1 个任务、2 张结果（合成模式最多取前 2 张参考图） |
| 替换生图 | 3 张参考图 + 勾选「按参考图一一对应」 | 1 个任务、3 张结果，标注「对应参考图 1/2/3」 |
| 实况视频 | 3 张素材 + 时长 3 秒 | 1 个任务、3 段视频，逐条可播放 |
| 笔记改写 | 3 张图生成标题，再逐张「重新生成配图」 | 文字任务不受图片数量影响；配图按并行上限逐张完成 |
| 商品下载 | 粘贴笔记或商品链接 | 解析出多张图并显示「商品图片 1/2/3…」，单图可下载 |

排查：

- 任务一直 `queued`：worker 没起（`npm run dev:queue`）或 Redis 不通，先 `redis-cli.exe -p 6379 ping` 确认 `PONG`。
- 合成模式图变少：参考图超过 2 张会被截断（只写 `logs/worker.err.log`，任务不报错）；需要逐张对应时勾选「按参考图一一对应」（上限 9 张）。
- 视频失败：看 `logs/worker.err.log` 里的 FFmpeg 路径和退出码；本机 `.env` 指向 `E:/FFmpeg/ffmpeg.exe`，新机器没装时删掉该行改用内置 `ffmpeg-static`。

## 停止

```powershell
.\stop-slenk-notes.bat
```

停止器只会停止命令行中包含**当前仓库绝对路径**的 API/Worker 进程；如果 3001 被其他程序占用，只告警，不会误杀。Redis 默认为共享基础设施，不会被关闭；确需一并停止时运行：

```powershell
.\stop-slenk-notes.ps1 -StopRedis
```

## 内置 Skill

新克隆后运行一次：

```powershell
.\setup-skills.ps1
```

脚本会把 `.skills/redapp-cli` 和 `.skills/minitool-zip-builder` 以 junction 暴露到 `.claude/skills` 与 `.codex/skills`。真实目录不会被自动删除；遇到冲突时脚本会停止并要求先备份。
