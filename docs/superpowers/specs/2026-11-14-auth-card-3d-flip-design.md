# 3D 翻转认证卡片设计

**日期：** 2026-11-14

## 目标

将未登录界面改为居中的 3D 双面玻璃卡片：正面完成真实 Cloudflare Turnstile，成功后短暂停留并沿中心垂直轴向左翻转 180°，背面显示用户名与密码登录表单。

## 安全边界

- 翻转只能由当前 generation 的真实 Turnstile 成功回调触发；点击自定义外观不能代替验证。
- Turnstile token 继续只保存在 React 内存中，不写入 URL、localStorage、sessionStorage 或 cookie。
- 服务端 Siteverify、`action === "login"`、hostname allowlist、单次 token、脱敏诊断与通用 `403 forbidden` 契约保持不变。
- 旧 widget generation 的 success/error/expired 回调不得改变新状态。
- 浏览器返回、过期、控件错误、登录失败、超时或请求中止都会清 token 和凭据，并回到可重新验证的正面。

## 视觉结构

页面保留现有紫蓝渐变背景，中间放置一个透视场景：

- 场景负责 `perspective`，不参与翻转。
- 内部卡片负责 `transform-style: preserve-3d` 和 Y 轴旋转。
- 正反两面绝对重叠，尺寸一致，使用柔和玻璃质感：高透明白色渐变、轻微模糊、内高光、细边框与深层阴影。
- 两面均渲染相同的顶部品牌信息：S 图标、`Slenk Notes`、`原创笔记图工作台`。
- 两面设置 `backface-visibility: hidden`；背面初始为 `rotateY(180deg)`。

### 正面

- 顶部：共享品牌信息。
- 中部：真实 Cloudflare Turnstile widget 或其加载/错误/重试状态。
- 底部：成功反馈框，绿色勾选图标与“验证成功”文案。
- 成功框只在当前 Turnstile generation 验证成功后出现。

### 背面

- 顶部：与正面完全相同的品牌信息。
- 中部：用户名输入框、密码输入框。
- 底部：`进入工作台` 提交按钮与登录错误信息。

## 状态与动画

认证 UI 使用这些阶段：

1. `challenge`：正面朝向用户，展示 Turnstile。
2. `success-feedback`：正面显示“✓ 验证成功”，保持约 450ms。
3. `flipping-to-login`：内部卡片在约 700ms 内执行 `rotateY(-180deg)`，形成向左翻转。
4. `login`：背面朝向用户，登录表单可交互。
5. `flipping-to-challenge`：失效时反向返回 0°，结束后重新渲染当前 generation 的 Turnstile。

Turnstile 成功后立即把 SPA 地址切到 `/login`，但背面表单要等翻转完成才可聚焦和提交。动画完成后自动聚焦用户名。

直接访问或刷新 `/login` 时没有内存 token，立即替换到 `/` 并显示正面，不先渲染登录表单。浏览器 Back 从 `/login` 离开时同步中止登录请求、清 token/凭据/提交状态，并开始翻回正面；不额外写浏览器历史。

## 可访问性与降级

- 非当前面设置不可聚焦并从辅助技术的活动内容中隐藏；不能仅依赖视觉背面隐藏。
- 卡片翻转期间禁用背面提交，防止动画中误触。
- 使用 `aria-live` 宣告验证成功与错误，但不重复朗读两份共享标题。
- `prefers-reduced-motion: reduce` 时取消 3D 过渡，直接切换正反面；保留约 450ms 成功反馈和所有状态约束。
- 键盘焦点不会进入背面不可见字段；返回正面后焦点回到可恢复验证区域或重试按钮。
- 小屏幕保持单卡片宽度，避免 3D 旋转造成横向滚动。

## 组件边界

- `web/src/lib/turnstileLogin.js`：继续管理 challenge/login generation、token 和请求生命周期，并增加纯状态阶段/翻转时序逻辑。
- `web/src/App.jsx`：将现有分离页面整合为一个双面卡片，连接 Turnstile 回调、History API、动画阶段、焦点和现有登录请求。
- `web/src/App.css`：负责透视、双面玻璃外观、左翻动画、非当前面交互隔离、响应式与 reduced-motion。
- 服务端文件不因本视觉功能修改。

## 错误恢复

- Turnstile 加载、render、error、expired：推进 challenge generation，清除 token，翻回正面并提供重试。
- 登录 `forbidden`、凭据错误、网络/响应体超时或 JWT 持久化失败：清除 token、用户名和密码，翻回正面，重新创建 widget。
- 迟到的旧 widget 回调或旧登录请求完成结果继续由 generation 检查忽略。
- 动画事件没有触发时以受控 timer 作为完成兜底，避免界面永久锁在 flipping 阶段。

## 测试与验收

### 自动化

- 状态机：`challenge → success-feedback → flipping-to-login → login`。
- 成功反馈保持 450ms、左翻持续约 700ms；reduced-motion 直接切换。
- 旧 generation 回调不能触发翻转或反转新状态。
- Back、过期、控件错误和全部登录失败路径清理凭据并返回正面。
- 翻转期间不能重复提交；背面未激活时字段不可交互。
- 动画完成事件和兜底 timer 只能提交一次阶段变更。

### 浏览器

- 初始仅正面可见；真实验证成功后出现“✓ 验证成功”。
- 卡片围绕中心垂直轴向左翻转 180°，没有镜像文字或卡片尺寸跳动。
- 翻转后只显示背面表单并自动聚焦用户名。
- 失败与 Back 可平滑返回正面并重新验证。
- 桌面、移动端、reduced-motion 下均无横向溢出，控制台和网络无新增错误。
- 自动化浏览器若被 Cloudflare `300030` 拦截，使用可控 callback 测试和真实浏览器人工验收分别记录，不宣称自动化真实挑战成功。
