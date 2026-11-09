// 探针 v4：init script 强制 attachShadow 用 open 模式，读取 shadow 内按钮结构（不点击）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const profileDir = path.resolve(__dirname, '../../storage/xhs-profile');
const testImg = 'C:/Users/Administrator/AppData/Local/Temp/pub-test.png';

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome', headless: false, viewport: { width: 1280, height: 880 }
});
await context.addInitScript(() => {
  const real = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    return real.call(this, { ...(init || {}), mode: 'open' });
  };
});
try {
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  const tab = page.locator('div.creator-tab:has-text("上传图文")').first();
  if (await tab.count()) {
    const active = await tab.evaluate(el => el.className.includes('active')).catch(() => false);
    if (!active) await tab.evaluate(el => el.click());
  }
  await page.locator('input[type="file"]').first().setInputFiles(testImg);
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => {
    const host = document.querySelector('xhs-publish-btn');
    if (!host || !host.shadowRoot) return { ok: false };
    const buttons = [...host.shadowRoot.querySelectorAll('button')].map(b => ({
      text: (b.textContent || '').trim().slice(0, 20),
      className: String(b.className).slice(0, 120),
      disabled: b.disabled,
      rect: b.getBoundingClientRect().toJSON()
    }));
    return { ok: true, shadowHTML: host.shadowRoot.innerHTML.slice(0, 1200), buttons };
  });
  console.log(JSON.stringify(info, null, 2));
} finally {
  await context.close().catch(() => {});
}
