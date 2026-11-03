# 笔记改写按图提示词配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 笔记改写工作区「图片管理」中，每张图片点击选中后可在卡片内配置独立提示词，并以该图为参考单独重生成、经对比确认后替换原位。

**Architecture:** 全部在前端 `NoteRewriteWorkspace`（web/src/App.jsx）内实现：图片对象扩展可选 `prompt` 字段；选中态用索引、生成/预览生命周期用图片 `id`（避免拖拽/删除导致索引漂移）；重生成复用现有 `runTask` 走 `image` 任务（worker 端 `/images/edits` 图生图通道，零后端改动）；结果用复用 prompt-config-modal 样式的对比浮层确认落位。

**Tech Stack:** React（单文件 App.jsx）、原生 CSS（App.css）、既有 `/api/tasks` 轮询任务通道。

**Spec:** `docs/superpowers/specs/2026-11-03-note-image-prompt-config-design.md`

## Global Constraints

- 只改 `web/src/App.jsx` 和 `web/src/App.css`；不改任何后端文件；不新增依赖。
- UI 文案一律中文，与现有界面风格一致。
- 仓库没有前端单元测试设施（web 无 vitest/jest）。验证方式 = `npm --prefix web run build` 必须通过 + 浏览器手动验证（dev server 在 http://localhost:5173，HMR 自动生效）。不新增测试框架。
- 图片上限 9 张、封面=第 1 张、拖拽排序、「保存笔记仅存前端状态」等现有行为保持不变。
- 工具栏原有的全局「AI生成」按钮（`aiGenerateImage`）保持原样不动。
- 提交信息末尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 现有代码关键事实（实施前必读）

- `runTask({ type, payload, purpose }, message, timeoutMs = 120000)`（App.jsx:554）：POST `/api/tasks` 后每 1.5s 轮询，`done` 返回 task 对象（`task.result` 是 JSON 字符串），`failed`/超时抛错。
- `parseJsonText(raw)`（App.jsx:225）：解析 task.result。
- 图生图请求契约（worker.js `runImage`，408-461 行）：payload 带 `imageUrls` 即走 `/images/edits`；参考图可以是 `/notes-images/...`、`/uploads/...`、`/videos/...` 相对路径（worker 直接读本地缓存）或远程 URL。**所以参考图必须传 `img.cachedUrl || img.url` 原始值，不要传 `resolveImageSrc()` 拼过的绝对地址。**
- 生成结果 URL 形如 `/videos/<taskId>.png`（worker.js:371）。应用替换时必须丢弃旧 `cachedUrl`（它指向旧图）。
- 默认替换提示词常量是模块级 `PROMPTS['replace-image']`（App.jsx:40）。
- CSS 已有 `.image-thumb.selected`（App.css:2352，选中高亮），直接复用。
- 图片网格当前是 App.jsx:729 的一条超长单行 JSX；本计划将它整体替换为多行格式。
- `.image-thumb` 有 `cursor: grab`，卡片内 textarea 需显式 `cursor: text`。

---

### Task 1: 选中态 + 卡片内提示词编辑区

**Files:**
- Modify: `web/src/App.jsx`（NoteRewriteWorkspace 状态区约 544 行、图片网格 729 行、`clearNote` 676 行、`identifyLink` 692 行附近）
- Modify: `web/src/App.css`（2352 行 `.image-thumb.selected` 之后追加）

**Interfaces:**
- Produces（后续任务依赖）:
  - state: `selectedImageIndex: number | null`、`regeneratingId: string | null`、`imageReplacePreview: { id: string, url: string } | null`
  - `clearImageSelectionState(): void` — 三个 state 全部置空
  - 图片对象形状 `{ id, url, cachedUrl?, name, isVideo?, prompt? }`（`prompt` 可选，留空走默认）
  - 按钮 `disabled={regeneratingId !== null}`、`onClick={() => regenerateImage(index)}`（regenerateImage 在 Task 2 才定义；本任务先放一个 `function regenerateImage() {}` 空函数占位，Task 2 填充）

- [ ] **Step 1: 添加三个 state 与清理函数**

在 `const [notePrompts, setNotePrompts] = useState(loadNotePrompts);`（约 544 行）附近，与其他 useState 放一起：

```js
  const [selectedImageIndex, setSelectedImageIndex] = useState(null);
  const [regeneratingId, setRegeneratingId] = useState(null);
  const [imageReplacePreview, setImageReplacePreview] = useState(null);
  function clearImageSelectionState() {
    setSelectedImageIndex(null);
    setRegeneratingId(null);
    setImageReplacePreview(null);
  }
```

并在其后放占位函数（Task 2 填充实现）：

```js
  // Task 2 填充：按图重生成
  function regenerateImage(index) { void index; }
```

- [ ] **Step 2: 删除/清空/识别时清理选中状态**

1. 图片网格里的删除按钮（729 行长 JSX 内，Step 3 会整体替换，此处逻辑并入 Step 3 的新版删除处理器）。
2. `clearNote`（676 行）改为：

```js
  function clearNote() { setTitle(''); setContent(''); setTags([]); setImages([]); setLink(''); clearImageSelectionState(); setStatus('已清空。'); }
```

3. `identifyLink` 中 `if (items.length) setImages(items);`（692 行）改为：

```js
      if (items.length) { setImages(items); clearImageSelectionState(); }
```

- [ ] **Step 3: 整体替换图片网格 JSX（729 行那条单行）为带选中/编辑区的多行版本**

把 App.jsx:729 整行（`<div className="image-grid">{images.map(...)}...</div>`）替换为：

```jsx
            <div className="image-grid">{images.map((img, index) => (
              <figure
                key={img.id || index}
                className={'image-thumb' + (selectedImageIndex === index ? ' selected' : '')}
                draggable
                onDragStart={() => { setDragIndex(index); clearImageSelectionState(); }}
                onDragOver={e => e.preventDefault()}
                onDrop={() => { moveImage(dragIndex, index); clearImageSelectionState(); }}
                onClick={() => { if (!img.isVideo) setSelectedImageIndex(selectedImageIndex === index ? null : index); }}
              >
                {img.isVideo ? <span className="cover-badge cover-badge-video">视频</span> : (index === 0 && <span className="cover-badge">封面</span>)}
                {regeneratingId === img.id && <div className="image-regen-overlay">生成中…</div>}
                {img.isVideo ? <video src={API + '/api/download?inline=1&url=' + encodeURIComponent(img.url)} controls preload="metadata" /> : <img src={resolveImageSrc(img)} alt={img.name || '笔记图片'} />}
                <figcaption>
                  <span>{img.name || '图片 ' + (index + 1)}</span>
                  <div>
                    <button type="button" onClick={(e) => { e.stopPropagation(); downloadFile(img, img.name || ('图片 ' + (index + 1)), img.isVideo ? 'video' : 'image'); }}>下载</button>
                    <button onClick={e => { e.stopPropagation(); setImages(images.filter((_, idx) => idx !== index)); clearImageSelectionState(); }}>删除</button>
                  </div>
                </figcaption>
                {selectedImageIndex === index && !img.isVideo && (
                  <div className="image-prompt-editor" onClick={e => e.stopPropagation()}>
                    <textarea
                      value={img.prompt || ''}
                      placeholder="留空则使用默认替换提示词 + 笔记标题/正文"
                      onChange={e => setImages(prev => prev.map((item, i) => i === index ? { ...item, prompt: e.target.value } : item))}
                    />
                    <button type="button" className="btn-secondary" disabled={regeneratingId !== null} onClick={() => regenerateImage(index)}>
                      {regeneratingId === img.id ? '生成中…' : '重新生成此图'}
                    </button>
                  </div>
                )}
              </figure>
            ))}{images.length === 0 && <div className="empty-image">暂无图片</div>}</div>
```

注意：HTML5 拖拽结束后不会在源元素上触发 click，选中与拖拽天然不冲突，无需额外守卫。

- [ ] **Step 4: 追加 CSS**

在 App.css 的 `.image-thumb.selected` 规则（2352 行）之后追加：

```css
.image-regen-overlay { position: absolute; z-index: 3; inset: 0; display: grid; place-items: center; background: rgba(255, 255, 255, 0.72); color: var(--text-h); font-size: 13px; font-weight: 600; border-radius: inherit; }
.image-prompt-editor { display: grid; gap: 6px; padding: 0 8px 8px; }
.image-prompt-editor textarea { width: 100%; min-height: 64px; resize: vertical; border: 1px solid var(--border); border-radius: 10px; padding: 6px 8px; font-size: 12px; line-height: 1.5; color: var(--text-h); background: #fff; box-sizing: border-box; cursor: text; }
.image-prompt-editor textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); }
.image-prompt-editor button { justify-self: end; }
```

- [ ] **Step 5: 构建验证**

Run: `npm --prefix web run build`
Expected: 构建成功，无语法错误。

- [ ] **Step 6: 浏览器手动验证**

dev server（http://localhost:5173）HMR 自动生效。进入「笔记改写」，上传或识别任意带图笔记：
- 点击图片 → 卡片高亮描边 + 展开提示词输入框和「重新生成此图」按钮；再点一次收起；点别的图切换。
- 视频卡片点击不展开。
- 输入文字后收起再展开，内容保留（存在图片对象上）。
- 拖拽换位、删除图片后，所有展开/选中状态消失。

- [ ] **Step 7: Commit**

```bash
git add web/src/App.jsx web/src/App.css
git commit -m "Note rewrite: per-image selection with inline prompt editor

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 按图重生成任务流程

**Files:**
- Modify: `web/src/App.jsx`（Task 1 的 `regenerateImage` 占位函数）

**Interfaces:**
- Consumes: Task 1 的 `regeneratingId/setRegeneratingId`、`imageReplacePreview/setImageReplacePreview`、`runTask`、`parseJsonText`、`PROMPTS['replace-image']`、状态 `images/title/content`
- Produces: `regenerateImage(index: number): Promise<void>` — 完整实现；成功后 `imageReplacePreview = { id, url }`（url 形如 `/videos/<taskId>.png`）

- [ ] **Step 1: 填充 regenerateImage 实现**

把 Task 1 的占位函数替换为：

```js
  // 按图重生成：以该图为参考走 /images/edits。参考图传原始存储值
  // （/notes-images、/uploads 相对路径或远程 URL），worker 会直接读本地缓存；
  // 不要传 resolveImageSrc() 拼出的带域名绝对地址。
  async function regenerateImage(index) {
    const img = images[index];
    if (!img || img.isVideo || regeneratingId) return;
    const custom = String(img.prompt || '').trim();
    const fallback = [PROMPTS['replace-image'], title && ('标题：' + title), content && ('正文：' + content)].filter(Boolean).join('\n');
    const reference = img.cachedUrl || img.url;
    if (!reference) { setStatus('该图片缺少可用地址，无法作为参考图。'); return; }
    setRegeneratingId(img.id);
    try {
      const task = await runTask(
        { type: 'image', purpose: 'noteImage', payload: { prompt: custom || fallback, imageUrls: [reference], perReference: true, canvasSize: '1080x1080', count: 1 } },
        '正在重新生成图片...',
        300000
      );
      const result = parseJsonText(task.result) || {};
      const urls = Array.isArray(result.images) && result.images.length ? result.images : (result.image && typeof result.image === 'string' ? [result.image] : []);
      if (!urls.length) throw new Error('AI 没有返回图片');
      setImageReplacePreview({ id: img.id, url: urls[0] });
      setStatus('新图已生成，请确认是否替换。');
    } catch (err) {
      setStatus(err.message);
    } finally {
      setRegeneratingId(null);
    }
  }
```

- [ ] **Step 2: 构建验证**

Run: `npm --prefix web run build`
Expected: 构建成功。

- [ ] **Step 3: 浏览器手动验证（需要后端 3001 + worker 都在运行）**

选中一张图，提示词留空点「重新生成此图」：
- 该卡片出现「生成中…」遮罩，其他图的按钮置灰。
- 任务完成后出现状态提示「新图已生成，请确认是否替换。」（对比浮层是 Task 3，此时仅验证状态提示与无报错；worker 终端标签页可见 image request 日志且 `references: 1`）。
- 再验证自定义提示词：填入「换成蓝色背景」之类，确认任务正常完成。
- 故意填一个会失败的场景可不测；失败路径代码与 aiGenerateImage 同款。

- [ ] **Step 4: Commit**

```bash
git add web/src/App.jsx
git commit -m "Note rewrite: regenerate a single image from its own prompt

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 原图/新图对比浮层与替换落位

**Files:**
- Modify: `web/src/App.jsx`（新增 `applyImageReplace` 函数；在 aiDiff 浮层（约 740-754 行）之后插入新浮层 JSX）
- Modify: `web/src/App.css`（Task 1 追加的样式之后继续追加）

**Interfaces:**
- Consumes: Task 2 的 `imageReplacePreview`（`{ id, url }`）、`images`、`setImages`、`resolveImageSrc`
- Produces: `applyImageReplace(): void` — 按 `id` 找回目标索引，原位替换 `url` 并丢弃旧 `cachedUrl`，保留 `id/name/prompt`

- [ ] **Step 1: 新增 applyImageReplace**

放在 `regenerateImage` 之后：

```js
  function applyImageReplace() {
    if (!imageReplacePreview) return;
    const targetIndex = images.findIndex(item => item.id === imageReplacePreview.id);
    if (targetIndex < 0) { setImageReplacePreview(null); setStatus('原图已被删除或移动，新图已弃用。'); return; }
    setImages(prev => prev.map((item, i) => {
      if (i !== targetIndex) return item;
      // 旧 cachedUrl 指向旧图，必须丢弃；id/name/prompt 保留，顺序与封面逻辑不变。
      const { cachedUrl, ...rest } = item;
      return { ...rest, url: imageReplacePreview.url };
    }));
    setImageReplacePreview(null);
    setStatus('已替换为新图。');
  }
```

- [ ] **Step 2: 插入对比浮层 JSX**

在 aiDiff 浮层整块（`{aiDiff && (...)}`，约 739-754 行）之后、`promptConfigOpen` 浮层之前插入：

```jsx
      {imageReplacePreview && (() => {
        const targetIndex = images.findIndex(item => item.id === imageReplacePreview.id);
        if (targetIndex < 0) return null;
        const target = images[targetIndex];
        return (
          <div className="prompt-config-backdrop" onClick={() => setImageReplacePreview(null)}>
            <div className="prompt-config-modal" onClick={e => e.stopPropagation()}>
              <button type="button" className="prompt-config-close" onClick={() => setImageReplacePreview(null)}>×</button>
              <h3>替换图片确认</h3>
              <p>「{target.name || '图片 ' + (targetIndex + 1)}」将被替换为新图，原图不保留。</p>
              <div className="image-compare-grid">
                <figure><img src={resolveImageSrc(target)} alt="原图" /><figcaption>原图</figcaption></figure>
                <div className="image-compare-arrow">→</div>
                <figure><img src={resolveImageSrc({ url: imageReplacePreview.url })} alt="新图" /><figcaption>新图</figcaption></figure>
              </div>
              <div className="prompt-config-actions">
                <button type="button" className="btn-secondary" onClick={() => setImageReplacePreview(null)}>取消</button>
                <button type="button" className="btn-primary" onClick={applyImageReplace}>应用</button>
              </div>
            </div>
          </div>
        );
      })()}
```

浮层打开期间 backdrop 遮住图片网格，目标图不可能被删除/拖拽，加上按 `id` 找回索引，无索引漂移风险。

- [ ] **Step 3: 追加对比浮层 CSS**

在 Task 1 追加的样式之后：

```css
.image-compare-grid { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; margin: 12px 0; }
.image-compare-grid figure { margin: 0; display: grid; gap: 6px; text-align: center; font-size: 12px; color: var(--text); }
.image-compare-grid img { width: 100%; max-height: 320px; object-fit: contain; border: 1px solid var(--border); border-radius: 12px; background: var(--code-bg); }
.image-compare-arrow { font-size: 20px; color: var(--text); }
```

- [ ] **Step 4: 构建验证**

Run: `npm --prefix web run build`
Expected: 构建成功。

- [ ] **Step 5: 浏览器手动验证**

对一张图执行重生成：
- 完成后弹出对比浮层：左原图右新图，标题含目标图名称。
- 「应用」→ 该位置变为新图，顺序不变；若替换的是第 1 张，封面徽标仍在它上面。
- 再生成一次点「取消」→ 列表完全不变。
- 替换后的新图仍能正常显示（确认旧 cachedUrl 已丢弃、没有裂图）。

- [ ] **Step 6: Commit**

```bash
git add web/src/App.jsx web/src/App.css
git commit -m "Note rewrite: confirm-before-replace modal for regenerated images

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 端到端验收（spec 测试清单）

**Files:** 无改动；仅验证。若发现问题，回到对应 Task 修复后重新验证。

- [ ] **Step 1: 对照 spec 测试节逐条手动验收**

在 http://localhost:5173 的「笔记改写」中执行：
1. 选中/取消选中/切换选中，展开收起表现正确。
2. 空提示词重生成 → 浏览器 DevTools Network 中查看 `POST /api/tasks` 请求体，`payload.prompt` 以默认替换提示词开头并带「标题：/正文：」上下文（worker 日志不含 prompt 文本，不要从日志验证）。
3. 自定义提示词重生成 → 同样从请求体确认 `payload.prompt` 为该图提示词。
4. 「应用」替换原位且封面徽标仍在第 1 张；「取消」列表不变。
5. 拖拽排序不触发选中展开；重生成中其他图按钮置灰。
6. 视频卡片无提示词编辑入口。
7. `npm --prefix web run build` 最终通过。

- [ ] **Step 2: 若全部通过，无提交；若有修复，提交修复**

```bash
git add -A
git commit -m "Note rewrite: fix issues from per-image prompt acceptance pass

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
