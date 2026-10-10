# 原创笔记图工作台复刻版（全栈）

本项目基于你提供的站点交互和截图风格，复刻出一套可继续开发的全栈应用骨架。

## 包含能力

- 前端 React + Vite 工作台 UI
- 后端 Express + SQLite 账号体系（注册/登录/JWT/bcrypt）
- 文件上传接口与本地文件存储
- AI API 代理接口（OpenAI-compatible，可切换 baseUrl/apiKey）
- 后端任务队列（BullMQ + Redis）
- 视频任务占位接口，可继续接入 FFmpeg / API 供应商

## 目录

- `web/`：前端
- `server/`：后端
- `.env.example`：环境变量模板

## 启动

### 1) 后端

```bash
cd server
npm install
npm run dev
```

### 2) 队列 worker

```bash
cd server
npm run queue
```

### 3) 前端

```bash
cd web
npm install
npm run dev
```

## 说明

- 当前账号体系是真实可用后端账号体系
- AI 图片/文本接口已接入队列与 provider 适配层
- 视频生成接口已提供任务队列链路，后续可补 FFmpeg 或第三方服务
