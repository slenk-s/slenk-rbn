import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closePool } from '../src/db.js';
import { saveNote, getNote } from '../src/store.js';
import { cacheRemoteImage, cacheImageUrls } from '../src/routes/notes.js';
import { closeQueue } from '../src/routes/tasks.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

after(() => Promise.allSettled([closePool(), closeQueue()]));

// 真实缓存目录是 storage/notes-images，测试只在临时目录里造文件。
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-cache-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cacheName(url, ext) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 32) + ext;
}

// sniffImageFormat 需要至少 12 字节（PNG 签名 8 + IHDR 长度 4），8/9 字节的纯签名会被判 unknown。
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

test('saveNote records the owner and round-trips tags and images', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const saved = await saveNote(userId, {
    title: '标题', content: '正文', tags: ['a', 'b'],
    images: [{ id: 'i1', url: '/uploads/x.png', name: 'x' }]
  });
  assert.equal(saved.userId, userId);
  const loaded = await getNote(saved.id);
  assert.equal(loaded.title, '标题');
  assert.deepEqual(loaded.tags, ['a', 'b']);
  assert.equal(loaded.images[0].url, '/uploads/x.png');
});

test('getNote stays public so share links keep working', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const saved = await saveNote(userId, { title: 'share me' });
  const loaded = await getNote(saved.id);
  assert.equal(loaded.title, 'share me');
});

test('deleting the owner removes their notes', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const saved = await saveNote(userId, { title: 'cascade' });
  await dropTestUser(userId);
  assert.equal(await getNote(saved.id), null);
});

test('cacheRemoteImage serves an intact cache hit as a local path', async (t) => {
  const dir = tempDir(t);
  const url = 'https://ci.xiaohongshu.com/1000g/ok.png';
  const name = cacheName(url, '.png');
  fs.writeFileSync(path.join(dir, name), PNG_HEAD);

  assert.equal(await cacheRemoteImage(url, undefined, false, dir), '/notes-images/' + name);
  assert.ok(fs.existsSync(path.join(dir, name)), 'an intact hit is kept');
});

test('cacheRemoteImage drops a corrupt cache file instead of returning a remote url', async (t) => {
  const dir = tempDir(t);
  const url = 'https://ci.xiaohongshu.com/1000g/broken.png';
  const name = cacheName(url, '.png');
  fs.writeFileSync(path.join(dir, name), 'not really an image');

  const cached = await cacheRemoteImage(url, undefined, false, dir);
  assert.equal(cached, '', 'corrupt cache must not be exposed as cachedUrl');
  assert.ok(!fs.existsSync(path.join(dir, name)), 'corrupt file removed so the next parse re-downloads it');
});

// 假上游：记录调用与并发峰值，并真的响应 abort，超时测试才能验证中断生效。
function makeFakeFetch({ delayFor = () => 0, ok = true } = {}) {
  const calls = [];
  let inflight = 0;
  let peak = 0;
  const fakeFetch = (url, options = {}) => new Promise((resolve, reject) => {
    calls.push(String(url));
    inflight++;
    peak = Math.max(peak, inflight);
    const timer = setTimeout(() => {
      inflight--;
      resolve({ ok, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG_HEAD });
    }, delayFor(String(url)));
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      inflight--;
      reject(new Error('aborted'));
    });
  });
  return { fetch: fakeFetch, calls, get peak() { return peak; } };
}

test('cacheImageUrls keeps input order, drops duplicates and caps concurrency', async (t) => {
  const dir = tempDir(t);
  const urls = [1, 1, 2, 2, 3, 3].map(n => 'https://ci.xiaohongshu.com/1000g/n' + n + '.png');
  const fake = makeFakeFetch({
    // 越靠后的图越慢：完成顺序和输入顺序相反，正好检验回填。
    delayFor: url => (Number(url.split('/').pop().replace('.png', '').slice(1)) - 1) * 15
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const cached = await cacheImageUrls(urls, 'https://www.xiaohongshu.com/', { dir });

  const unique = [...new Set(urls)];
  assert.equal(cached.length, 3, 'duplicate urls collapse to one entry');
  assert.deepEqual(cached.map(c => c.url), unique, 'output order matches input order');
  assert.equal(fake.calls.length, 3, 'duplicates are fetched once');
  assert.deepEqual(cached.map(c => c.cachedUrl), unique.map(url => '/notes-images/' + cacheName(url, '.png')));
  // peak 必须等请求跑完再读，否则读到的是开始前的 0。
  assert.ok(fake.peak > 1, 'images download concurrently');
  assert.ok(fake.peak <= 4, 'concurrency stays within the pool');
});

test('cacheImageUrls stops spending time once the shared budget runs out', async (t) => {
  const dir = tempDir(t);
  const slowMs = 400;
  const urls = Array.from({ length: 9 }, (_, i) => 'https://ci.xiaohongshu.com/1000g/slow' + i + '.png');
  const fake = makeFakeFetch({ delayFor: () => slowMs });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const started = Date.now();
  const cached = await cacheImageUrls(urls, 'https://www.xiaohongshu.com/', { dir, deadline: Date.now() + 50 });
  const elapsed = Date.now() - started;

  assert.deepEqual(cached.map(c => c.url), urls, 'every url still gets a slot in the result');
  assert.ok(elapsed < slowMs, 'the batch must be cut by the budget, not wait out one slow fetch (took ' + elapsed + 'ms)');
  assert.ok(cached.every(c => c.cachedUrl === ''), 'truncated downloads are not advertised as cached');
});
