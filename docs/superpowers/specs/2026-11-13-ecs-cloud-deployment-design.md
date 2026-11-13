# Slenk Notes 阿里云 ECS 云端部署设计

日期：2026-11-13
状态：设计规格，待用户评审

## 1. 目标

把当前「本机多进程运行」的 Slenk Notes 部署到阿里云 ECS（实例 `i-f8zcp6vvis4q14qp0z5q`，地域
cn-heyuan，Windows Server），实现：

- **随时随地远程访问**：任何设备通过 HTTPS 打开工作台。
- **多人使用**：沿用现有 users 表登录体系，多账号 XHS 隔离不在本期范围（见
  `2026-11-12-xhs-multi-account-user-isolation-design.md`）。
- **24 小时运行**：API 与 worker 作为 Windows 服务常驻，开机自启、崩溃自拉起，不依赖 RDP 会话。

## 2. 非目标

- 发布渠道上云：草稿箱（Playwright `headless: false` 常驻窗口）与扫码直达（redapp CLI）都留在
  本地机器，服务器上禁用并返回明确错误。
- 多账号用户隔离的实现（已有独立设计稿，后续单独排期）。
- ICP 备案本身的办理（用户线下流程，与本设计并行推进）。
- Docker / WSL / k8s 等容器化改造。

## 3. 总体架构（方案 A：域名非标端口 HTTPS + Windows 服务化）

```
互联网用户
   │  https://236963.xyz:8443
   ▼
阿里云安全组：仅放行 8443/TCP（3389 RDP 建议限源 IP）
   ▼
Caddy（slenk-caddy 服务，0.0.0.0:8443）
   ├─ 静态托管 web/dist（SPA 回退 index.html）
   └─ /api/* 反代 → 127.0.0.1:3001（slenk-api，Express）
                        │
                        ├─ 127.0.0.1:6379（slenk-redis，BullMQ）
                        ├─ slenk-worker（BullMQ 消费，无端口）
                        └─ Supabase Postgres / Storage（云端，不变）
```

- 域名：`236963.xyz`，Cloudflare DNS，**灰云（仅 DNS）** 直连 ECS。
- 证书：Let's Encrypt，**DNS-01** challenge（Cloudflare API Token，仅 `Zone.DNS:Edit`、单 zone
  授权），Caddy 自动签发续期。不走 80 端口，避开大陆节点对未备案域名的拦截。
- 端口边界：公网只暴露 8443；3001（API）、6379（Redis）只绑 127.0.0.1。
- 备案完成后切换：Caddyfile 端口 8443 → 443，安全组放行 443，无其他改动。

## 4. 组件设计

### 4.1 服务清单（NSSM 注册，均为自动启动）

| 服务名 | 进程 | 监听 | 说明 |
|---|---|---|---|
| `slenk-caddy` | caddy.exe（cloudflare DNS 插件定制构建） | 0.0.0.0:8443 | 入口；静态托管 + /api 反代 |
| `slenk-redis` | redis-server.exe（tporadowski Windows 移植版 5.x） | 127.0.0.1:6379 | 队列后端 |
| `slenk-api` | node server/src/index.js | 127.0.0.1:3001 | Express API |
| `slenk-worker` | node server/src/worker.js | — | 队列消费 |

- NSSM 将各服务 stdout/stderr 重定向到仓库 `logs/` 目录，与本地启动脚本排障路径一致。
- 服务 cwd 与本地启动脚本保持一致（server 进程 cwd 为 `server/`），相对路径行为不变。
- 不使用 Vite dev server；部署前 `npm --prefix web run build` 产出 `web/dist`。

### 4.2 配置（`.env` 服务器侧）

从本机复制 `.env` 后修改：

| 变量 | 值 |
|---|---|
| `TURNSTILE_HOSTNAMES` | `236963.xyz` |
| `PUBLIC_URL` | `https://236963.xyz:8443` |
| `STORAGE_PATH` / `UPLOADS_PATH` / `VIDEO_OUT_PATH` | 服务器上 `storage/` 的绝对路径 |
| `JWT_SECRET`、`DATABASE_URL`、`SUPABASE_*`、`REDIS_URL`、`TURNSTILE_SECRET` | 原样复制 |

> `PUBLIC_URL` 此前在代码中无引用；本期起被 CORS 白名单（见 4.3.3）消费。

注意：服务器与本地连同一个 Supabase 库，任务数据两端共享（既有设计如此）。部署后应只在一端
日常使用，避免双端同时跑 worker 造成的认知混乱（BullMQ 队列共享，双 worker 不会重复消费，
但发布渠道只有本地端可用）。

### 4.3 代码改动（4 处）

1. **API 绑定回环**：`server/src/index.js` 监听地址改为 `127.0.0.1`（可用 `HOST` env 控制，默认
   127.0.0.1），3001 不再可被公网直连。
2. **发布渠道开关**：新增 `XHS_PUBLISH_ENABLED`（默认 `true`，服务器上设 `false`）。为 `false`
   时草稿箱与扫码直达两个渠道在服务端直接返回 `409 { error: 'publish_disabled_on_server' }`；
   前端识别该错误并提示「请到本地机器发布」。
3. **CORS 收紧**：`cors({ origin: true })` 改为环境变量 `CORS_ORIGINS` 白名单，默认
   `PUBLIC_URL` + `http://localhost:5173`（后者保住本地 dev——浏览器经 Vite proxy 访问 API 时
   Origin 是 5173，白名单缺了它本地就打不开）。服务器上只配公网域名，等于同源部署下白捡的
   加固。
4. **前端硬编码检查**：确认 `web/` 内无 localhost 硬编码（`App.jsx` 已确认默认
   `window.location.origin`，无需设置 `VITE_API_URL`）。

### 4.4 Turnstile

- Cloudflare 面板给现有 widget 的 hostnames 添加 `236963.xyz`。
- 服务器 `.env` 的 `TURNSTILE_HOSTNAMES=236963.xyz`（不带端口，siteverify 返回的 hostname 无端口）。
- 登录校验逻辑不变（严格模式：缺 token / hostname 不匹配一律 403）。

## 5. 首次部署流程

仓库新增 `scripts/deploy/`：`Caddyfile` 模板、`deploy-server.ps1`（幂等主脚本）、
`update-server.ps1`（日常更新）、`RUNBOOK.md`（图文步骤）。

1. **控制台（手动）**：安全组放行 8443/TCP（3389 限源）；Cloudflare 建灰云 A 记录
   `236963.xyz` → 公网 IP；建单 zone `Zone.DNS:Edit` API Token；Turnstile widget 加 hostname。
2. **装依赖（脚本）**：Node LTS、Git、Redis（tporadowski）、NSSM、Caddy（cloudflare 插件版），
   已装则跳过。
3. **拉代码**：`git clone` 到 `C:\slenk-notes`（私有仓库，服务器上登录一次 GitHub）。
4. **配置**：拷贝 `.env` 按 4.2 改值，填入 Cloudflare API Token；跑
   `node server/scripts/apply-schema.mjs`（幂等自检）。
5. **构建**：server/web `npm install` → `npm --prefix web run build`。
6. **服务化**：`deploy-server.ps1` 写 Caddyfile、注册并启动 4 个 NSSM 服务。
7. **验证（真实浏览器，自动化浏览器会被 Turnstile 300030 拦截）**：
   - 手机流量打开 `https://236963.xyz:8443`，Turnstile 出现、登录成功；
   - 建任务 → worker 消费 → 结果图显示（Supabase URL，无本地 CDN 断连问题）；
   - 点击发布 → 收到「请到本地机器发布」明确提示；
   - 直连 `http://<公网IP>:3001/api/health` 应失败（仅回环）。

## 6. 运维与回滚

- **更新**：`update-server.ps1` = `git pull` → 按需 `npm install` / `web build` →
  `nssm restart slenk-api slenk-worker`。
- **日志**：`logs/` 下四个服务各自的 stdout/stderr 文件。
- **回滚**：`git checkout <旧 commit>` + 重启服务；Caddyfile 与服务定义随仓库走，服务器上不留
  手工状态。
- **备案后**：8443 → 443（Caddyfile + 安全组两处）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 非标端口规避备案属过渡姿势，理论上可被处置 | 备案并行推进，下来后切 443；期间可接受 |
| Cloudflare API Token 泄漏 | 单 zone、仅 DNS:Edit 最小权限；泄漏了也只能改这一个域名的 DNS，可随时吊销重建 |
| 有人在服务器上点发布，worker 弹不出浏览器 | `XHS_PUBLISH_ENABLED=false` 服务端直接报错，前端明确提示 |
| 本地与云端双 worker 同时跑 | 队列共享不重复消费，但建议部署后固定一端使用 |
| Windows Server 重启 | 4 个服务均为自动启动，无人值守可恢复 |

## 8. 测试计划

- 部署脚本在本机以「干跑」模式自检（不注册服务，只验证路径与依赖检测逻辑）。
- 代码改动（HOST 绑定、发布开关、CORS）配 `node --test` 单测：开关关闭时发布接口返回 409；
  CORS 拒绝非白名单来源；HOST 默认 127.0.0.1。
- 服务器上按 5.7 验证清单逐项人工验收（真实浏览器 + 手机流量网络）。
