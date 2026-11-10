---
name: redapp-cli
description: 使用 redapp CLI 启动小工具本地模拟器调试、查询小红书小工具、上传代码包和图片、生成手机预览、送审新版本、修改基础信息，或排查 CLI 登录与接口错误。适用于小工具操作和使用教程；上传 Skill 到 SkillHub 使用 redskillhub-upload。
---

# 小红书小工具 CLI

把用户请求转换成当前 `redapp` 命令，给出可执行步骤并依据真实回执报告结果。用户只问用法时给命令；要求执行时，在已授权范围内完成操作。

## 动态版本门禁

`redapp` 由 npm 包 `redskillhub-upload` 提供。通过创服下发的可信口令使用本 Skill 时，执行任何 `redapp` 命令前，必须先从本 Skill 目录运行版本门禁：

```bash
# Beta 测试口令
node "<SKILL_DIR>/scripts/ensure-cli.mjs" --env beta --npm-policy beta-first

# 默认口令
node "<SKILL_DIR>/scripts/ensure-cli.mjs"
```

读取 `CLI_VERSION_JSON`；只有 `status=current|installed|updated` 才继续，并以其中的 `version`、`tag`、`env` 作为本次实际运行依据。状态为 `error`、字段缺失或无法解析时立即停止，不使用本地源码或其他版本线兜底。

`--env` 选择小工具后端和凭证目录，`--npm-policy`/`--npm-tag` 选择 npm 包版本，两者互不替代。Beta 的 `beta-first` 仅在 `beta` 对应的目标正式版本高于默认正式版本时使用预发布包，正式版追平后自动回到正式版本；默认口令不传这些参数，由门禁使用正式版本和默认线上后端。后续每条 `redapp` 命令都必须携带 `--agent`；Beta 还必须显式携带 `--env beta`，默认口令不附加环境参数。

外层口令应使用当前进程专用的用户可写 npm prefix/cache，不永久修改 npm 配置。版本门禁只验证安装版本和 `redapp` 命令协议，不提前要求业务登录；需要访问接口时再按登录流程处理。

## 先确定入口、环境和来源

- 包名是 `redskillhub-upload`，同一个 npm 包提供 `redapp` 和 `redskillhub-upload` 两个命令。
- 只有用户明确要求开发或验证当前仓库源码时，才使用 `node "<REPO>/cli/redapp/index.mjs"`，下文 `redapp` 可以整体替换为此入口。创服口令或 npm Beta/正式包验收必须使用版本门禁选出的全局命令，不得回退本地源码并把结果归因于已发布包。
- 首次使用、切换入口或升级后，按 [安装与排错](references/operations.md#验证命令协议) 验证实际入口、版本、命令和计划协议；仅存在 `redapp` 命令不足以证明兼容。不要假定 npm 已发布当前源码。
- 先根据触发口令设置环境参数占位符：Beta 为 `ENV_ARGS="--env beta"`，默认口令为 `ENV_ARGS=""`。所有业务步骤保持同一组参数，并与版本门禁的 `CLI_VERSION_JSON.env` 一致；不要把占位符原样交给 shell。
- 查询、预览、送审和编辑需要 `--source`；它是后端登记的三方来源，不是客户端类型。此项目已确认的联调来源为 `thirdAgent`；不要沿用错误的 `web` 或把文档示例 `cowork` 当成通用配置。其他接入方使用其实际分配值。
- 当前仓库 beta 默认网关为 `https://edith-qinweiheng.sl.beta.xiaohongshu.com`，prod 为 `https://edith.xiaohongshu.com`。版本或部署可能改变默认值，诊断时核对 CLI 配置与 dry-run 的 `plan.apiBase`。`--api-base` 优先于 `SKILLHUB_UPLOAD_API_BASE`，后者优先于默认值；只使用用户或后端确认的地址。
- `upload` 不接受 `--source`；其上传授权内部使用的 `source=web` 与小工具三方来源不是同一个参数，不要改写它来规避校验。

## 本地开发调试

用户要求启动模拟器或本地调试时，按 [dev 使用流程](references/dev.md) 执行 `redapp dev --dir "./dist" <ENV_ARGS> --agent`。需要 Node.js 20+；首次自动安装公开包 `@skillbuilder/miniapp-simulator@0.2.0`。dev 不使用发布登录、不接受 --source 或 --api-base，不能将业务泳道参数追加到它；无需填写发布表单。保留进程并交付实际 URL，结束时关闭服务。dev 不能替代送审前手机扫码预览。

## 登录与输出

Agent 发起的每次 CLI 调用都显式添加 `--agent`，包括查询、上传、dry-run 和 confirm。业务命令也可能触发自动登录；遗漏此参数会影响二维码和结构化提示的展示。npm、node 自身的安装或版本查询不加此参数。

直接复用 Skill CLI 的登录、token 续期和环境隔离。已有同环境登录无需再扫码，真实请求会自动检查凭证。需要明确登录时：

```bash
redapp login <ENV_ARGS> --agent
redapp whoami <ENV_ARGS> --agent
```

`ENV_ARGS` 不是可直接执行的字面量：Beta 口令替换为 `--env beta`，默认口令删除该占位符，并在本次流程中保持一致。

登录出现 `PROMPT:<json>` 时，按 [跨 Agent 展示登录和预览](references/operations.md#跨-agent-展示登录和预览) 展示二维码或链接。保持当前 CLI 进程等待授权，不另起重复登录；只使用返回字段。

读取 `RESULT_JSON:<json>` 作为最终回执；`UPLOAD_PROGRESS:<number>` 只是上传进度。不要把退出码 0、HTTP 200 或上传 100% 单独当成业务成功。日常用法不需要用户复制 token。

## 按任务选命令

以下命令使用环境参数占位符；执行前按触发口令替换或删除 `ENV_ARGS`。`thirdAgent` 是当前已确认的联调来源，其他接入方使用其实际分配值。

| 用户意图 | 命令 | 结果要点 |
| --- | --- | --- |
| 查询可选类目、权限 | `redapp config --source thirdAgent <ENV_ARGS> --agent` | 使用返回的 `categories[].code`、`authorizations[].code` |
| 查询最近列表 | `redapp list --source thirdAgent <ENV_ARGS> --page-num 1 --page-size 20 --agent` | `data.apps`、`data.total`；含未发布和审核中记录，不是仅已发布列表 |
| 查看状态、驳回原因 | `redapp status --source thirdAgent <ENV_ARGS> --app-id "<APP_ID>" --agent` | 使用 list 或提交回执里的真实 appId |
| 查看历史版本 | `redapp history --source thirdAgent <ENV_ARGS> --app-id "<APP_ID>" --agent` | 历史审核状态与展示状态分别解释 |
| 上传 ZIP、图标或封面 | `redapp upload --file "<FILE>" --type pkg <ENV_ARGS> --agent --dry-run` | 先 dry-run，再确认；保留 fileId 和 md5 |
| 手机预览 | `redapp preview --source thirdAgent <ENV_ARGS> --agent --file "./preview.json" --dry-run` | 使用上传回执制作 JSON，可输出二维码 |
| 新建或送审新版本 | `redapp submit --source thirdAgent <ENV_ARGS> --agent --file "./submit.json" --dry-run` | 新建不填 appId；新版本填写 appId 与新 version |
| 修改名称、简介或图片 | `redapp edit --source thirdAgent <ENV_ARGS> --agent --file "./edit.json" --dry-run` | `appName`、`slogan`、`iconFileId` 三项必须同时传入且均为非空白字符串，未修改项携带现有值；改代码包走 submit |

用户要上传、预览、送审或编辑时，读取 [从文件到预览和送审](references/workflows.md)，使用其中的 JSON 字段与两阶段命令。不要使用旧版的 `app list`、`preview create`、`--plan`、`--protocol-ack`；当前入口不支持这些语法。

**edit 必须同时传入 `appName`、`slogan`、`iconFileId` 三项，并提供目标 `appId`。** 三项都必须是非空白字符串，任意一项缺失、为 `null`、空串 `""` 或纯空白（如 `"   "`），后端都会拒绝整个请求。只改其中一项时，其余两项必须携带有效的现有值；优先从已有资料或查询结果补齐，无法确定时先补齐资料，不能省略、传空值或猜测。执行前逐项检查，CLI dry-run 通过不能代替这项检查。

**edit 的 `coverFileId` 为可选字段，可以省略；需要修改封面时传入新的封面 fileId。** 它不属于上述三项必填字段，也不能替代其中任何一项。

## 少交互的上传引导

- 用户说“帮我上传小工具”时，直接承担文件检查、参数组装和命令执行，按 [上传引导](references/workflows.md#上传引导) 推进，不把 CLI 教程或长问卷交回给用户。
- 填写前读取 [字段限制与提示](references/form-limits.md)，在收集资料时就说明名称/简介各最多 14 个字符、图标和封面的格式/大小/比例；收到内容立即计数和检查，不能依赖 CLI dry-run 代替这些校验。只提示当前目标涉及的字段。
- 先利用当前对话、项目资料和已有操作记录补全信息；只集中询问无法确定且阻塞当前目标的内容。已知的环境、来源、素材路径和已有授权不重复询问。
- 在任何远端上传之前完成对应任务的预检；完整小工具流程先验证 config/source，已有小工具再查询状态与历史。明确只上传文件时使用文件上传预检，不额外要求业务来源。
- 每个阶段用一句话说明进展，步骤内部自动完成。只在扫码、必要信息缺失或未授权的下一步需要用户参与；不要逐条命令请求确认。
- 多步操作按 [操作记录与恢复](references/session.md) 保存进度；用户说“继续”时先核对记录和远端状态，避免重复上传、预览或送审。

## 送审前必须扫码预览

新建送审和已有小工具的新版本都必须先为本次待提交内容生成预览二维码，让用户扫码体验，并取得用户明确的“预览通过”反馈后才能执行 submit 的 confirm。先前的送审授权、二维码生成成功、用户仅说“已扫码”或等待超时都不能替代预览通过。该要求由 Skill 流程执行，CLI/API 本身没有此门禁。

使用 `preview --qr-out` 生成二维码并展示；不能内嵌图片时给出用户可打开的二维码文件及预览链接。无法生成或交付可扫描二维码、预览接口失败或用户尚未确认通过时，停在待预览阶段。具体流程见 [强制手机预览](references/workflows.md#4-送审前强制手机预览)。

## 写入执行约定

1. 确认当前任务已授权的对象、环境和动作；预览不隐含送审授权，测试不隐含修改用户已有作品。
2. 准备真实素材和参数，执行 `--dry-run`。读取 `RESULT_JSON.plan`，核对账号、网关、来源、对象和输入；向用户说明具体效果。
3. 已有清楚授权时（submit 还必须完成本次内容的扫码预览并获用户确认通过）直接用该计划的 `planHash` 执行相同命令并换成 `--confirm "<PLAN_HASH>"`。授权尚不明确时，先把这份具体计划给用户确认，不要重复索取已有授权。
4. 输入、文件内容、账号、环境或网关发生变化，重新 dry-run。计划不是幂等键；不要自动循环重试写入。
5. `OUTCOME_UNKNOWN` 时先查询远端结果。查询也失败或无法判断是否创建成功时停止重试，明确报告未知状态及需要核对的对象。

`submitted` 只表示接收送审，不表示审核通过或发布成功。无删除、下架、下载源码等命令，不要虚构能力或用其他账号、Cookie、伪造 userId 绕过接口限制。

## 报告验证范围

区分本地参数/打包检查、模拟测试与真实接口联调。当前环境的历史阻塞和判断方法见 [安装与排错](references/operations.md#接口错误与复测)，历史结果不能代替本次实测。报告命令、环境、成功数据或原始业务错误，并注明尚未验证的环节。
