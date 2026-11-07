import { Router } from 'express';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verify } from '../auth.js';
import { paths } from '../paths.js';
import { saveNote, getNote } from '../store.js';
import { enqueueTask } from './tasks.js';
import { sniffImageFormat, toStandardImage } from '../lib/imageFormat.js';

export const router = Router();

const notesImagesDir = path.join(paths.dataDir, 'notes-images');

// 单张图单个上游请求的上限（沿用原行为），以及一次解析全部图片共享的总预算。
// 总预算才是真正的护栏：串行时 9 张图最坏 9 × 2 次请求 × 20 秒，共享预算把它切成常数。
const CACHE_TIMEOUT_MS = 20000;
const CACHE_BUDGET_MS = 25000;
const CACHE_CONCURRENCY = 4;

function jpegFallbackUrl(rawUrl) {
  const base = String(rawUrl || '').split(/[?#]/)[0];
  return base + '?imageView2/2/w/1080/format/jpeg';
}

export async function cacheRemoteImage(rawUrl, referer, isFallback = false, dir = notesImagesDir, deadline = Date.now() + CACHE_TIMEOUT_MS) {
  const url = normalizeImageUrl(rawUrl);
  if (!/^https?:\/\//.test(url)) return '';
  fs.mkdirSync(dir, { recursive: true });
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  // 落盘只存 jpg/png：命中检查两个候选；webp/gif 等旧格式缓存直接清掉重下转换。
  for (const ext of ['.jpg', '.png']) {
    const candidate = path.join(dir, hash + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
      const existingFormat = sniffImageFormat(fs.readFileSync(candidate));
      if (existingFormat === 'jpeg' || existingFormat === 'png') return '/notes-images/' + hash + ext;
      fs.unlinkSync(candidate);
    }
  }

  const controller = new AbortController();
  // 用剩余预算而不是固定超时：预算耗尽时这张图立刻中止，而不是再占满一轮 20 秒。
  const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        'Referer': referer || 'https://www.xiaohongshu.com/'
      }
    });
    if (!resp.ok) return '';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return '';
    const originalFormat = sniffImageFormat(buf);
    if (originalFormat === 'heic' || originalFormat === 'unknown') {
      // 当前环境无法可靠解码这类格式，走 CDN 的 jpeg 变体；变体仍不可解码就放弃，避免死循环。
      if (isFallback) return '';
      return cacheRemoteImage(jpegFallbackUrl(url), referer, true, dir, deadline);
    }
    const std = await toStandardImage(buf);
    if (!std) {
      if (isFallback) return '';
      return cacheRemoteImage(jpegFallbackUrl(url), referer, true, dir, deadline);
    }
    const finalPath = path.join(dir, hash + std.ext);
    const tmp = finalPath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, std.buf);
    fs.renameSync(tmp, finalPath);
    return '/notes-images/' + hash + std.ext;
  } catch (err) {
    console.warn('[notes] cache image failed', url, err.message);
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

// 并发池 + 共享预算：常规情况（9 张各约 0.5 秒）从 ~5 秒降到 ~2 秒，
// 最坏情况被总预算硬切，而不是随张数线性拉长。按索引回填，输出顺序与输入一致。
export async function cacheImageUrls(urls, referer, { deadline = Date.now() + CACHE_BUDGET_MS, dir = notesImagesDir } = {}) {
  const seen = new Set();
  const jobs = [];
  for (const url of Array.isArray(urls) ? urls : []) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    jobs.push(url);
  }
  const cached = new Array(jobs.length);
  let next = 0;
  const runNext = async () => {
    for (;;) {
      const position = next;
      if (position >= jobs.length) return;
      next++;
      const url = jobs[position];
      cached[position] = { url, cachedUrl: await cacheRemoteImage(url, referer, false, dir, deadline) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CACHE_CONCURRENCY, jobs.length) }, () => runNext()));
  return cached;
}

function lanOrigin(req) {
  const port = Number(process.env.PORT || 3001);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return 'http://' + net.address + ':' + port;
    }
  }
  return (req.protocol + '://' + req.get('host'));
}

router.post('/', verify, async (req, res, next) => {
  try {
    const note = await saveNote(req.user.userId, req.body || {});
    res.status(201).json({ id: note.id, url: lanOrigin(req) + '/p/' + note.id });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const note = await getNote(req.params.id);
    if (!note) return res.status(404).json({ error: 'note_not_found' });
    res.json({ note });
  } catch (err) {
    next(err);
  }
});
router.post('/:id/rewrite', verify, async (req, res, next) => {
  try {
    const note = await getNote(req.params.id);
    if (!note) return res.status(404).json({ error: 'note_not_found' });
    res.json(await enqueueTask('rewrite', {
      ...(req.body || {}),
      prompt: String(req.body?.prompt || ''),
      source: String(req.body?.source || note.content || note.title || '')
    }, req.user.userId));
  } catch (err) {
    next(err);
  }
});

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

async function resolveLink(url) {
  let current = url.trim();
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(current, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': UA } });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).toString();
      continue;
    }
    return { finalUrl: current, resp };
  }
  return { finalUrl: current, resp: await fetch(current, { headers: { 'User-Agent': UA } }) };
}

function extractInitialState(html) {
  const markers = ['window.__INITIAL_STATE__=', '__INITIAL_STATE__='];
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx < 0) continue;
    let start = idx + marker.length;
    while (start < html.length && /\s/.test(html[start])) start++;
    if (html[start] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return html.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

function normalizeImageUrl(u) {
  if (!u) return '';
  let url = String(u).replace(/\\u002F/g, '/').replace(/&amp;/g, '&');
  if (url.startsWith('//')) url = 'https:' + url;
  return url;
}

function parseGoodsLink(url) {
  const match = String(url || '').match(/(?:www\.)?(?:mall\.)?xiaohongshu\.com\/goods-detail\/([^/?#]+)/i);
  return match ? { itemId: match[1] } : null;
}

function readGoodsTemplateData(payload) {
  let blocks = payload?.template_data;
  if (typeof blocks === 'string') {
    try { blocks = JSON.parse(blocks); } catch { return {}; }
  }
  if (!Array.isArray(blocks)) blocks = blocks ? [blocks] : [];
  return Object.assign({}, ...blocks.filter(block => block && typeof block === 'object'));
}

function readGoodsImages(images) {
  return (Array.isArray(images) ? images : [])
    .map(img => normalizeImageUrl(img?.url || img?.imageUrl || img?.thumbnail?.url))
    .filter(Boolean);
}

async function parseGoodsDetail(url) {
  const goods = parseGoodsLink(url);
  if (!goods) return null;

  const parsed = new URL(url);
  const apiUrl = new URL('https://mall.xiaohongshu.com/api/store/jpd/edith/detail/h5/toc');
  apiUrl.searchParams.set('version', '0.0.5');
  apiUrl.searchParams.set('item_id', goods.itemId);
  const xsecSource = parsed.searchParams.get('xsec_source');
  const xsecToken = parsed.searchParams.get('xsec_token');
  if (xsecSource) apiUrl.searchParams.set('xsec_source', xsecSource);
  if (xsecToken) apiUrl.searchParams.set('xsec_token', xsecToken);

  const resp = await fetch(apiUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': url
    }
  });
  const payload = await resp.json().catch(() => null);
  if (!resp.ok || !payload?.success || !payload?.data) {
    throw new Error(payload?.msg || '商品详情接口请求失败（' + resp.status + '）');
  }

  const data = readGoodsTemplateData(payload.data);
  const images = readGoodsImages(data.carouselH5?.images);
  if (!images.length) throw new Error('商品详情中没有找到图片');

  return {
    kind: 'goods',
    title: data.descriptionH5?.name || data.descriptionMain?.name || '',
    content: '',
    tags: [],
    images: await cacheImageUrls(images, url),
    videos: []
  };
}

function parseNoteDetail(state) {
  const detail = state?.noteData?.data?.noteData || state?.note?.noteDetailMap?.[Object.keys(state?.note?.noteDetailMap || {})[0]]?.note || state?.note?.note || null;
  if (!detail) return null;
  const title = detail.title || '';
  const content = detail.desc || detail.content || '';
  const tags = (detail.tagList || detail.hashTag || []).map(t => t?.name || t?.tagName || t).filter(Boolean);
  const images = (detail.imageList || detail.images || [])
    .map(img => {
      const fileId = img?.fileId || img?.file_id || '';
      // fileId 本身已是 CDN 相对路径：有的自带 notes_pre_post/ 前缀，有的不带。
      // 之前无条件补前缀会让 "纯 id" 的笔记图片 404。
      if (fileId) return 'https://ci.xiaohongshu.com/' + String(fileId).replace(/^\/+/, '');
      const infoList = img?.infoList || img?.info_list || [];
      const urls = infoList.map(i => normalizeImageUrl(i?.url || i?.imageUrl)).filter(Boolean);
      return urls[urls.length - 1] || normalizeImageUrl(img?.url || img?.imageUrl);
    })
    .filter(Boolean);
  const videos = [];
  const videoObj = detail.video;
  const stream = videoObj?.media?.stream || videoObj?.stream;
  const candidates = [];
  if (stream && typeof stream === 'object') {
    // 同一视频会下发多路流：h264 分支（streamType 259）烧录了小红书水印，
    // h265 分支（streamType 309 / 520 ...）是同一内容的无水印版本，优先取后者。
    const byCodec = codec => {
      const key = Object.keys(stream).find(k => k.toLowerCase() === codec);
      const list = key ? stream[key] : null;
      return Array.isArray(list) ? list : [];
    };
    const ordered = [...byCodec('h265'), ...byCodec('h264')];
    if (!ordered.length) {
      for (const list of Object.values(stream)) if (Array.isArray(list)) ordered.push(...list);
    }
    candidates.push(...ordered);
  }
  if (videoObj?.url) candidates.push({ url: videoObj.url });
  for (const c of candidates) {
    const u = normalizeImageUrl(c?.masterUrl || c?.url || c?.playAddr || c?.play_url);
    if (u) { videos.push(u); break; }
  }
  return { title, content, tags, images, videos };
}

router.post('/parse', verify, async (req, res) => {
  try {
    const rawInput = String(req.body?.link || '').trim();
    if (!rawInput) return res.status(400).json({ error: 'missing_link' });
    const match = rawInput.match(/https?:\/\/[^\s，。；）)\]"']+/);
    const link = match ? match[0] : rawInput;
    // xhslink 短链同时存在 .com 与 .cn 两个域名，只放行 .com 会把 .cn 分享链接直接判成 invalid_link。
    if (!/xiaohongshu\.com|xhslink\.(?:com|cn)/i.test(link)) return res.status(400).json({ error: 'invalid_link', message: '请输入小红书笔记或商品链接' });
    const { finalUrl, resp } = await resolveLink(link);
    const goodsLink = parseGoodsLink(finalUrl) || parseGoodsLink(link);
    if (goodsLink) {
      const detail = await parseGoodsDetail(finalUrl);
      return res.json(detail);
    }
    const html = await resp.text();
    const raw = extractInitialState(html);
    if (!raw) return res.status(502).json({ error: 'parse_failed', message: '未能解析页面数据，小红书页面结构可能已变化或需要登录' });
    let state;
    try { state = JSON.parse(raw.replace(/\bundefined\b/g, 'null')); } catch (e) { return res.status(502).json({ error: 'parse_failed', message: '页面数据格式异常' }); }
    const detail = parseNoteDetail(state);
    if (!detail) return res.status(404).json({ error: 'note_not_found', message: '未找到笔记内容' });
    const cachedImages = await cacheImageUrls(detail.images, finalUrl);
    res.json({ title: detail.title, content: detail.content, tags: detail.tags, images: cachedImages, videos: detail.videos });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});
