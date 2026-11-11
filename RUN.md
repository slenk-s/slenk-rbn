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
