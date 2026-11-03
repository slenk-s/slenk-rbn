# 笔记改写：按图独立提示词配置 — 设计

日期：2026-11-03
状态：已确认（方案 A）

## 背景

笔记改写工作区的「图片管理」目前只有一个全局「AI生成」按钮（`aiGenerateImage`，web/src/App.jsx:654）：用固定模板 + 标题/正文上下文生成 1 张图并追加到列表末尾。用户无法针对某一张已有图片单独重生成/替换。

「替换生图」工作区（replace-image）已有"以参考图 + 提示词生成替换版"的成熟任务通道（`perReference`），本设计把它下沉到笔记改写的每张图片上。

## 需求（经逐条澄清确认）

1. **用途**：每张图片拥有独立提示词，用于按图重新生成/替换这一张，不影响其他图。
2. **交互**：点击缩略图选中（高亮），提示词配置在该图片卡片内展开（textarea + 「重新生成此图」按钮）。
3. **生成方式**：以当前图片为参考图 + 该图专属提示词，走图生图替换（复用 image 任务、`perReference`）。
4. **结果落位**：生成完成后弹对比浮层（原图 vs 新图），「应用」才替换原位，「取消」弃用新图。
5. **空提示词兜底**：留空时使用「替换生图」默认提示词 + 笔记标题/正文上下文；placeholder 文案说明此默认行为。

## 方案选择

- **方案 A（采用）**：图片对象内嵌 `prompt` 字段，改动集中在 web/src/App.jsx 图片管理区 + 少量 CSS。与现有「保存笔记只存前端状态」的现实一致。
- 方案 B（否决）：抽 ImageCard 组件 + 提示词随笔记落后端库。当前笔记保存仅前端状态，为此单字段引入后端持久化属过度设计；将来笔记落库时 `prompt` 随 `images` 数组自然带走。

## 详细设计

### 数据与状态（均在 NoteRewriteWorkspace 内）

- 图片对象扩展：`{ id, url, cachedUrl?, name, isVideo?, prompt? }`，`prompt` 默认 `undefined`。
- `selectedImageIndex: number | null` — 当前选中的图片索引。
- `regeneratingIndex: number | null` — 正在重生成的图片索引（卡片加载遮罩 + 按钮置灰）。
- `imageReplacePreview: { index, url } | null` — 待确认的新图。

### 交互流程

- 点击缩略图 → 设为选中（高亮描边），该卡片内展开提示词 textarea +「重新生成此图」；再次点击同一图或点击其他图则收起/切换。
- 拖拽排序、封面徽标（第 1 张）、下载/删除按钮行为不变；拖拽不触发选中切换。
- 视频卡片（`isVideo`）不提供提示词编辑与重生成入口。
- 点「重新生成此图」：
  - 最终提示词 = `img.prompt` 非空时用它；为空时 = 替换生图默认提示词 + `标题：…` / `正文：…` 上下文（与现有 aiGenerateImage 拼装风格一致）。
  - 参考图 = 该图 URL，经 `resolveImageSrc` 拼为绝对地址后放入 `imageUrls`（单元素），`perReference: true`，`count: 1`，画布沿用 `1080x1080`。
  - `runTask({ type: 'image', purpose: 'noteImage', payload }, '正在重新生成图片…', 300000)`。
- 任务成功 → 解析 result.images/image 得新图 URL → 设置 `imageReplacePreview` 弹对比浮层（复用 prompt-config-modal 样式）：
  - 「应用」：`setImages` 原位替换（保留 id/name/prompt，顺序与封面逻辑不变），关闭浮层。
  - 「取消」：弃用新图，原图不动。
- 任务失败 → `setStatus(err.message)`，图片列表不变。

### 边界与错误处理

- 同时最多一张图在生成中：`regeneratingIndex` 非空时其他「重新生成」按钮置灰。
- 替换不增加图片数量，9 张上限规则不受影响。
- 图片被删除或拖拽换位时，`selectedImageIndex` / `regeneratingIndex` / `imageReplacePreview` 一律置空（不做索引跟随，避免错位）。
- 超时沿用 300 秒；AI 未返回图片按失败处理。

### 测试（手动）

1. 选中/取消选中、切换选中，展开收起表现正确。
2. 空提示词重生成：请求体使用默认提示词 + 标题/正文上下文。
3. 自定义提示词重生成：请求体使用该图提示词。
4. 对比浮层「应用」替换原位且封面徽标仍在第 1 张；「取消」列表不变。
5. 拖拽排序不触发选中；重生成中其他按钮置灰。
6. 视频卡片无提示词入口。

## 改动文件

- `web/src/App.jsx` — 状态、选中/展开 UI、重生成函数、对比浮层。
- `web/src/App.css` — 选中高亮、卡片内编辑区、生成中遮罩、对比浮层布局。
