# 登录 Turnstile 失败修复设计

**日期：** 2026-11-13

## 问题

登录页的 Turnstile 控件显示验证成功，但提交登录请求后，后端返回 `403 { error: "forbidden" }`，前端统一显示“人机验证失败，请重试”。

已确认：

- 前端将 `window.turnstile.getResponse(widgetId)` 返回值写入 `cf-turnstile-response`。
- 后端配置的 `TURNSTILE_SECRET` 能通过 Cloudflare Siteverify 的 secret 探针；探针只返回预期的 `invalid-input-response`。
- `localhost` 和 `127.0.0.1` 已在本地 `TURNSTILE_HOSTNAMES` 白名单。
- Vite 的 `/api` 代理指向同一后端。

当前阻碍是后端把 Siteverify 的所有失败原因（Cloudflare error codes、action 不匹配、hostname 不匹配、网络错误）统一吞掉，无法根据证据区分根因。

## 方案

保留严格的服务端校验，并将 Turnstile 校验提取为独立、可测试的模块：

1. 校验 token、secret 和 hostname 配置。
2. 调用 Cloudflare Siteverify。
3. 要求 `success === true`、`action === "login"`、hostname 在部署白名单内。
4. 返回结构化的内部结果；路由对客户端仍只返回通用 `forbidden`。
5. 服务端仅记录脱敏诊断：失败类别、Cloudflare error codes、返回的 action/hostname；绝不记录 token 或 secret。

拿到真实失败原因后只修对应点：

- 若是 action/hostname 配置不匹配，修正部署配置或精确匹配逻辑。
- 前端由成功回调保存 token，确保提交的是控件刚签发的 token，而不是在提交时再次查询可能已变化的控件状态。
- 若是 Cloudflare 返回 widget/secret 不匹配，则保留代码并明确指出需要修正的 widget 配置，不通过放宽校验绕过。

## 两阶段登录交互

未登录用户使用两个独立 URL 状态，但不整页刷新：

1. `/` 是人机验证页，只渲染 Turnstile 控件，不显示用户名和密码。
2. Turnstile 成功回调收到 fresh token 后，使用 History API 切换到 `/login` 并渲染账号密码表单；token 只保存在当前 React 内存中，不写入 URL、localStorage 或 sessionStorage。
3. `/login` 只有在当前内存中存在 fresh token 时才可显示。刷新 `/login` 或直接访问 `/login` 时没有 token，自动替换回 `/`。
4. 最终登录请求携带该 token，由后端 Siteverify 兑换一次。密码错误、验证失败、token 过期或控件报错时，清空 token、重置控件并返回 `/`，用户必须重新验证。
5. 登录成功后保持现有保存 JWT 并进入工作台的行为。

这样既满足“验证后跳转进入登录界面”，又避免把单次 Turnstile token 暴露到持久化浏览器存储，也避免在跳转前提前兑换导致最终登录时重放失败。

## 组件边界

- `server/src/lib/turnstile.js`：Siteverify 调用、结果分类和严格校验，无 Express 依赖。
- `server/src/routes/auth.js`：读取请求、调用验证器、记录脱敏原因、维持现有客户端错误契约。
- `web/src/lib/turnstileLogin.js`：管理 fresh token 和验证页/登录页状态转换，保持为可独立测试的纯逻辑。
- `web/src/App.jsx`：渲染 `/` 验证页和 `/login` 登录页，连接 Turnstile 回调、History API 与现有登录请求。

## 错误处理与安全

- 网络异常、非 2xx、非 JSON、缺失配置均 fail closed。
- 客户端始终收到 `403 forbidden`，不暴露安全策略。
- 日志不包含 token、secret、完整请求体。
- 不移除 action 或 hostname 校验，不在浏览器调用 Siteverify。

## 测试

先写失败测试并确认红灯，再实现最小修复：

- 有效 Siteverify 结果通过。
- Cloudflare error codes 被正确分类且脱敏。
- action 不匹配拒绝。
- hostname 不匹配拒绝。
- 网络/响应异常拒绝。
- 如需改前端，验证成功后进入 `/login`，且最终提交使用 callback 取得的最新 token。
- 直接访问或刷新 `/login` 时自动回到 `/` 验证页。
- 密码错误、验证失败、过期或控件错误后清空旧 token，并要求重新验证。

最后运行服务端测试、前端构建，并在本地浏览器中完成一次真实验证与登录；由于自动化浏览器可能被 Turnstile 300030 拦截，若出现该 Cloudflare 限制，会以服务端脱敏诊断和可执行的单元/集成测试作为证据，并明确标注真实浏览器验证状态。
