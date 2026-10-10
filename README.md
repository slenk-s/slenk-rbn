# 原创笔记图工作台复刻版

## 当前实现
- 前端：React + Vite
- 后端：Express
- 账号：固定 admin / 123456
- AI：SenseNova API
- 队列：Redis + BullMQ
- 文件存储：本地自定义路径 `STORAGE_PATH`
- 视频：本地 FFmpeg 算法运镜
- 本地数据库：JSON 文件存储，无需额外数据库安装

## 运行
1. 准备 Redis
2. 在 `.env` 填入 `SENSENOVA_API_KEY`
3. 启动后端
4. 启动队列 worker
5. 启动前端

## 快速启动
```bash
# 后端
npm --prefix server install
npm --prefix server run dev

# 队列
npm --prefix server run queue

# 前端
npm --prefix web install
npm --prefix web run dev
```

## 说明
- 固定账号已写入后端初始化逻辑，不需要注册/支付
- 图片/文案/视频任务都会进入队列
- 本地存储目录默认在 `./storage`
- 视频生成通过本地 FFmpeg 处理，需确保系统已安装 ffmpeg
