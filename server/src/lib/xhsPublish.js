// 小红书创作者中心半自动发布：有头浏览器弹窗 → 自动填图/标题/正文 → 停在发布按钮前。
// 只把内容填好，绝不点击「发布」按钮；最后一步永远留给用户。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { paths } from '../paths.js';
import { sniffImageFormat } from './imageFormat.js';

const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';
const LOGIN_WAIT_MS = 5 * 60 * 1000;      // 等扫码登录最多 5 分钟
const TITLE_MAX = 20;                      // 小红书标题上限
const CONTENT_MAX = 1000;

const profileDir = path.join(paths.dataDir, 'xhs-profile');
const tmpDir = path.join(paths.dataDir, 'xhs-tmp');
const notesImagesDir = path.join(paths.dataDir, 'notes-images');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function humanDelay(min = 300, max = 800) { return sleep(min + Math.random() * (max - min)); }

// 把任务里的图片地址（云端 URL / 站内相对路径）统一解析成本地文件路径，set_input_files 只认本地文件。
async function localizeImage(value, index, taskId) {
  if (!value) return null;
  let buf = null;
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`第 ${index + 1} 张图片下载失败（HTTP ${res.status}）`);
    buf = Buffer.from(await res.arrayBuffer());
  } else if (value.startsWith('/notes-images/')) {
    const p = path.resolve(notesImagesDir, path.basename(value));
    if (!fs.existsSync(p)) throw new Error(`第 ${index + 1} 张图片本地缓存不存在：${value}`);
    buf = fs.readFileSync(p);
  } else {
    const p = path.resolve(paths.uploadsDir, path.basename(value));
    if (!fs.existsSync(p)) throw new Error(`第 ${index + 1} 张图片不存在：${value}`);
    buf = fs.readFileSync(p);
  }
  const fmt = sniffImageFormat(buf);
  if (fmt !== 'jpeg' && fmt !== 'png') throw new Error(`第 ${index + 1} 张图片不是 jpg/png，无法上传`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `${taskId}-${index + 1}.${fmt === 'jpeg' ? 'jpg' : 'png'}`);
  fs.writeFileSync(file, buf);
  return file;
}

async function firstExisting(page, selectors, timeout = 4000) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch { /* 试下一个候选选择器 */ }
  }
  return null;
}

// 登录态用 cookie 判断：登录成功后小红书会写 web_session。
// 发布页 DOM 在未登录时也有 input[type=file]（藏在登录弹层后面），DOM/URL 判断都不可靠。
async function hasSessionCookie(context) {
  const cookies = await context.cookies('https://creator.xiaohongshu.com').catch(() => []);
  return cookies.some(c => c.name === 'web_session' || c.name === 'customer-sso-sid');
}

async function ensureLoggedIn(page, context, onStatus) {
  await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  if (await hasSessionCookie(context)) return;
  await onStatus('waiting_login', '请在弹出的浏览器窗口中扫码登录小红书');
  const deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    if (await hasSessionCookie(context)) {
      // 登录成功，重新进一次发布页确保表单就绪。
      await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30000 });
      return;
    }
    await sleep(2000);
  }
  throw new Error('等待扫码登录超时（5 分钟），请重新提交发布任务');
}

async function fillPublishForm(page, { title, content }, localFiles) {
  // 创作者中心默认是「上传视频」页签，图文笔记要先切到「上传图文」。
  // 已是 active 状态就别点（实测重复点击会被自身子元素拦截指针事件直到超时）；
  // 需要点时 force 绕过视口/拦截检查，这只是个页签切换。
  const imageTab = await firstExisting(page, [
    'div.creator-tab:has-text("上传图文")',
    'div[class*="tab"]:has-text("上传图文")',
    'span:has-text("上传图文")'
  ]);
  if (imageTab) {
    const active = await imageTab.evaluate(el => el.className.includes('active')).catch(() => false);
    // DOM click 不受视口/遮挡限制，Vue 组件一样能收到事件。
    if (!active) { await imageTab.evaluate(el => el.click()); await humanDelay(); }
  }

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  await fileInput.setInputFiles(localFiles);

  // 等所有缩略图渲染出来（数量与本地文件一致），说明上传完成。
  await page.waitForFunction(
    count => document.querySelectorAll('.img-preview-area img, [class*="preview"] img, [class*="prism-image"]').length >= count,
    localFiles.length,
    { timeout: 60000 }
  ).catch(() => { /* 选择器漂移时兜底再等一会 */ });
  await sleep(1500);

  if (title) {
    const titleInput = await firstExisting(page, [
      'input[placeholder*="填写标题"]',
      'input[placeholder*="标题"]',
      'div.titleInput input',
      'input.d-text'
    ]);
    if (titleInput) {
      await titleInput.click();
      await humanDelay(200, 400);
      await titleInput.pressSequentially(title, { delay: 40 + Math.random() * 60 });
    }
  }
  if (content) {
    const editor = await firstExisting(page, [
      'div.ql-editor[contenteditable="true"]',
      '[contenteditable="true"]',
      'div.ql-editor'
    ]);
    if (editor) {
      await editor.click();
      await humanDelay(200, 400);
      await editor.pressSequentially(content, { delay: 15 + Math.random() * 25 });
    }
  }
}

// 填完内容后点「暂存离开」存进草稿箱：任务立刻结束、窗口关闭，不占用后续任务的队列。
// 用户之后在小红书 App / 创作者中心的草稿箱里随时发布。
async function saveAsDraft(page) {
  // 按钮在 shadow DOM（已被 init script 强制 open）里：白底那颗是暂存离开，红色是发布。
  await page.waitForSelector('xhs-publish-btn[is-save-draft="true"]', { state: 'attached', timeout: 10000 });
  await sleep(800);
  const clicked = await page.evaluate(() => {
    const host = document.querySelector('xhs-publish-btn');
    const buttons = [...(host?.shadowRoot?.querySelectorAll('button') || [])];
    const btn = buttons.find(b => (b.textContent || '').includes('暂存'))
      || host?.shadowRoot?.querySelector('button.ce-btn.white');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  if (!clicked) throw new Error('没找到「暂存离开」按钮，页面结构可能变了');
  await sleep(1500);
  // 部分情况下会弹二次确认框。
  const confirmBtn = await firstExisting(page, [
    'div[role="dialog"] button:has-text("暂存")',
    '[class*="modal"] button:has-text("暂存")',
    'div[role="dialog"] button:has-text("确认")'
  ], 3000);
  if (confirmBtn) { await confirmBtn.evaluate(el => el.click()); await sleep(1000); }
  // 存草稿成功后会离开发布页或出现成功提示；30 秒内没观察到就按「未确认」如实上报。
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      if (!page.url().includes('/publish/publish')) return 'draft_saved';
      const tip = await page.locator('text=/已暂存|暂存成功|草稿箱/').count().catch(() => 0);
      if (tip > 0) return 'draft_saved';
    } catch {
      return 'draft_saved'; // 页面销毁等价于已离开发布页
    }
    await sleep(1000);
  }
  return 'unconfirmed';
}

// 浏览器单例：任务结束后窗口保持打开，下次发布直接复用，跳过启动和登录等待。
// worker 是常驻进程，模块级变量即可持有；用户手动关窗时 close 事件把单例清掉。
let sharedContext = null;

async function getSharedContext() {
  if (sharedContext) {
    try {
      sharedContext.pages(); // 活性探测：窗口被用户关掉时这里会抛 Target closed
      return { context: sharedContext, fresh: false };
    } catch {
      sharedContext = null;
    }
  }
  fs.mkdirSync(profileDir, { recursive: true });
  // persistent context：Cookie 自动落盘在 xhs-profile，扫码一次长期免登录。
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 880 },
    args: ['--disable-blink-features=AutomationControlled']
  });
  // 「暂存离开/发布」按钮在 xhs-publish-btn 的 closed shadow DOM 里，常规手段都够不到；
  // 在页面脚本执行前把 attachShadow 强制改成 open，之后 host.shadowRoot 就能正常访问。
  await context.addInitScript(() => {
    const real = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      return real.call(this, { ...(init || {}), mode: 'open' });
    };
  });
  context.on('close', () => { sharedContext = null; });
  sharedContext = context;
  return { context, fresh: true };
}

export async function publishNoteToXhs(payload, { onStatus = async () => {} } = {}) {
  const taskId = payload.taskId || String(Date.now());
  const title = String(payload.title || '').trim().slice(0, TITLE_MAX);
  const content = String(payload.content || '').trim().slice(0, CONTENT_MAX);
  const imageUrls = (Array.isArray(payload.images) ? payload.images : []).filter(Boolean).slice(0, 9);
  if (!imageUrls.length) throw new Error('发布需要至少 1 张图片');
  if (!title && !content) throw new Error('标题和正文至少填一项');

  const localFiles = [];
  try {
    for (let i = 0; i < imageUrls.length; i++) {
      localFiles.push(await localizeImage(imageUrls[i], i, taskId));
    }

    const { context, fresh } = await getSharedContext();
    await onStatus('filling', fresh ? '正在打开浏览器…' : '复用已打开的浏览器窗口…');
    // 复用现存页签（可能停在草稿箱/笔记管理页），没有就开新页。
    const page = context.pages().find(p => !p.isClosed()) || await context.newPage();
    try {
      await ensureLoggedIn(page, context, onStatus);
      await onStatus('filling', '已登录，正在填入笔记内容…');
      await fillPublishForm(page, { title, content }, localFiles);
      await onStatus('waiting_confirm', '内容已填好，正在存入草稿箱…');
      const outcome = await saveAsDraft(page);
      return {
        outcome,
        title,
        titleTruncated: String(payload.title || '').trim().length > TITLE_MAX,
        contentLength: content.length,
        imageCount: localFiles.length
      };
    } catch (err) {
      // 失败时把当前页面截图落盘，错误信息里带上路径，方便排查选择器漂移。
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const shot = path.join(tmpDir, `error-${taskId}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        err.message += `（页面截图：${shot}）`;
      } catch { /* 截图失败就算了 */ }
      throw err;
    }
    // 注意：这里不关浏览器。窗口常驻留给下次任务复用；worker 进程退出时浏览器随之回收。
  } finally {
    // 临时图片用完即清。
    for (const f of localFiles) fs.rmSync(f, { force: true });
  }
}
