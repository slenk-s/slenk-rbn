import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import { updateTask, getProviderUnmaskedById, getActiveProvider } from './store.js';
import { paths } from './paths.js';
import { collectReferenceImages } from './lib/referenceImages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function resolveExisting(value) {
  if (!value) return null;
  const resolved = path.isAbsolute(value) ? value : path.resolve(root, value);
  return fs.existsSync(resolved) ? resolved : null;
}
function parseCanvasSize(value, fallbackWidth = 1280, fallbackHeight = 720) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/);
  const width = match ? Number(match[1]) : fallbackWidth;
  const height = match ? Number(match[2]) : fallbackHeight;
  return {
    width: Number.isFinite(width) && width > 0 ? width : fallbackWidth,
    height: Number.isFinite(height) && height > 0 ? height : fallbackHeight
  };
}

function parseDuration(payload) {
  const durationMode = payload.durationMode || 'fixed';
  if (durationMode === 'random') {
    return Math.max(1, Math.min(8, Math.floor(Math.random() * 8) + 1));
  }
  return Math.max(1, Math.min(30, Number(payload.duration) || 3));
}


const ffmpegPath = resolveExisting(process.env.FFMPEG_PATH) || (fs.existsSync('E:/FFmpeg/ffmpeg.exe') ? 'E:/FFmpeg/ffmpeg.exe' : null) || ffmpegStatic;
ffmpeg.setFfmpegPath(ffmpegPath);
const jobLockDuration = Number(process.env.JOB_LOCK_DURATION_MS || 30 * 60 * 1000);
const jobMaxStalledCount = Number(process.env.JOB_MAX_STALLED_COUNT || 3);
const workerStalledInterval = Number(process.env.WORKER_STALLED_INTERVAL_MS || 30 * 1000);

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: null });
const uploadDir = paths.uploadsDir;
const videoDir = paths.videosDir;
const notesImagesDir = path.join(paths.dataDir, 'notes-images');
fs.mkdirSync(videoDir, { recursive: true });

async function resolveProvider(payload, mode, userId) {
  const provider = payload.providerId
    ? (await getProviderUnmaskedById(payload.providerId)) || (await getActiveProvider(mode, userId))
    : await getActiveProvider(mode, userId);
  if (!provider) throw new Error('no active AI provider');
  return provider;
}

function providerRequest(provider, pathname, body, { formData, timeoutMs } = {}) {
  if (!provider.baseUrl) throw new Error('供应商 baseUrl 为空');
  if (!provider.apiKey) throw new Error('供应商 API Key 为空');
  const url = new URL(pathname.replace(/^\//, ''), `${provider.baseUrl.replace(/\/$/, '')}/`);
  const headers = { authorization: `Bearer ${provider.apiKey}`, accept: 'application/json' };
  let payload;
  if (formData) {
    // multipart 的 boundary 由 fetch 自动生成，手动设 content-type 反而会让服务端解析失败。
    payload = formData;
  } else {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  return fetch(url, { method: 'POST', headers, body: payload, signal });
}

// 中转站文档建议 timeout >= 300s：单次生成通常 120s，复杂 4K + high 可达 180–240s。
const IMAGE_REQUEST_TIMEOUT_MS = 300 * 1000;
// 429 限流与网关 5xx 做指数退避重试（文档建议）；其他 4xx（如 contentFilter）直接报错。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [5000, 20000, 60000];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 图像请求统一入口：超时 + 退避重试。body 为 JSON 对象，或传 parts 走 multipart。
async function imageRequest(provider, pathname, { body, parts } = {}) {
  let formData = null;
  if (parts) {
    formData = new FormData();
    for (const [key, value] of Object.entries(body || {})) {
      if (value !== undefined && value !== null) formData.set(key, String(value));
    }
    parts.forEach((part, index) => {
      const field = parts.length === 1 ? 'image' : 'image[]';
      const ext = part.mime === 'image/jpeg' ? 'jpg' : (part.mime.split('/')[1] || 'png');
      formData.append(field, new Blob([part.buf], { type: part.mime }), `ref-${index + 1}.${ext}`);
    });
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await providerRequest(provider, pathname, body, { formData, timeoutMs: IMAGE_REQUEST_TIMEOUT_MS });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`生成超时（>${IMAGE_REQUEST_TIMEOUT_MS / 1000}s），中转站可能仍在排队，请稍后重试`);
      }
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      console.warn(`[worker] image request network error, retry ${attempt + 1} in ${RETRY_DELAYS_MS[attempt]}ms:`, err.message);
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= RETRY_DELAYS_MS.length) return res;
    console.warn(`[worker] image request HTTP ${res.status}, retry ${attempt + 1} in ${RETRY_DELAYS_MS[attempt]}ms`);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
}

// 扩展名与响应头都可能与实际内容不符（例如 .png 文件里其实是 WebP 字节），
// 这里按文件头识别真实格式，避免供应商报 "data URL media type does not match the image content"。
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    if (brand.startsWith('hei') || brand.startsWith('mif') || brand.startsWith('msf')) return 'image/heic';
    if (brand.startsWith('avi')) return 'image/avif';
  }
  return '';
}

function dataUrlFromBuffer(buf, fallbackMime) {
  const mime = sniffImageMime(buf) || fallbackMime || 'image/png';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

// 供应商对参考图的硬性限制：PNG/JPEG/WebP、≤10MB、边长落在 [256,4096]、宽高比 ≤2:1。
// 超限的图（手机长截图最常见，如 1440x3168 = 2.2:1）会被直接拒收，
// 所以在本地先规范化再提交；合规的图原样返回，不做任何重编码。
const REF_MAX_EDGE = 4096;
const REF_MIN_EDGE = 256;
const REF_MAX_RATIO = 2;
const REF_MAX_BYTES = 10 * 1024 * 1024;
const REF_FORMATS = new Set(['png', 'jpeg', 'webp']);

async function normalizeReferenceBuffer(buf) {
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  if (!meta?.width || !meta?.height) return null;
  // EXIF orientation 5-8 会让解码后的宽高互换，判定前要按实际显示方向取尺寸。
  const swapped = Number(meta.orientation) >= 5;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;
  const ratio = Math.max(width, height) / Math.min(width, height);
  const fits = REF_FORMATS.has(meta.format)
    && buf.length <= REF_MAX_BYTES
    && Math.max(width, height) <= REF_MAX_EDGE
    && Math.min(width, height) >= REF_MIN_EDGE
    && ratio <= REF_MAX_RATIO;
  if (fits) return null;

  let scale = 1;
  if (Math.max(width, height) > REF_MAX_EDGE) scale = REF_MAX_EDGE / Math.max(width, height);
  else if (Math.min(width, height) < REF_MIN_EDGE) scale = REF_MIN_EDGE / Math.min(width, height);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));

  // sharp 的 extract 作用在 resize 之后的图上，所以缩放与裁切分两步做，避免顺序歧义。
  let stage = await sharp(buf, { failOn: 'none' }).rotate().toBuffer();
  let stageWidth = width;
  let stageHeight = height;
  if (scale !== 1) {
    stage = await sharp(stage).resize(scaledWidth, scaledHeight, { fit: 'fill' }).png().toBuffer();
    stageWidth = scaledWidth;
    stageHeight = scaledHeight;
  }

  let image = sharp(stage);
  if (Math.max(stageWidth, stageHeight) / Math.min(stageWidth, stageHeight) > REF_MAX_RATIO) {
    // 居中裁到 2:1：横向过长裁宽度，纵向过长裁高度，画面保持饱满，不引入原图之外的内容。
    if (stageWidth >= stageHeight) {
      const targetWidth = Math.max(REF_MIN_EDGE, Math.round(stageHeight * REF_MAX_RATIO));
      image = image.extract({ left: Math.round((stageWidth - targetWidth) / 2), top: 0, width: targetWidth, height: stageHeight });
    } else {
      const targetHeight = Math.max(REF_MIN_EDGE, Math.round(stageWidth * REF_MAX_RATIO));
      image = image.extract({ left: 0, top: Math.round((stageHeight - targetHeight) / 2), width: stageWidth, height: targetHeight });
    }
  }

  const output = await image.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
  if (output.length > REF_MAX_BYTES) {
    return sharp(output).jpeg({ quality: 72 }).toBuffer();
  }
  return output;
}

// 参考图规范化后包一层：data URL 模式包成 Data URL，multipart 模式直接拿 buffer。
async function referencePart(buf, fallbackMime) {
  const normalized = await normalizeReferenceBuffer(buf).catch(err => {
    console.warn('[worker] reference normalize skipped:', err.message);
    return null;
  });
  if (!normalized) return { buf, mime: sniffImageMime(buf) || fallbackMime || 'image/png' };
  console.log('[worker] reference normalized', JSON.stringify({ bytesIn: buf.length, bytesOut: normalized.length }));
  return { buf: normalized, mime: 'image/jpeg' };
}

async function referenceDataUrl(buf, fallbackMime) {
  const part = await referencePart(buf, fallbackMime);
  return dataUrlFromBuffer(part.buf, part.mime);
}

// 读取参考图原始字节：data URL / 本地缓存 / 公网 URL / 裸 base64 四种来源统一成 { buf, fallbackMime }。
async function readImageSource(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) {
    const match = raw.match(/^data:([^;,]*);base64,(.*)$/is);
    if (!match) return null;
    return { buf: Buffer.from(match[2].replace(/\s/g, ''), 'base64'), fallbackMime: match[1] };
  }
  if (/^\/(?:notes-images|uploads|videos)\//i.test(raw)) {
    // 智能识别已把远端图片缓存到本地；这里直接读缓存，不再回源，也避免前端走代理预览。
    const safeName = path.basename(raw);
    const localPath = path.resolve(raw.startsWith('/notes-images/') ? notesImagesDir : raw.startsWith('/uploads/') ? uploadDir : videoDir, safeName);
    if (fs.existsSync(localPath)) return { buf: fs.readFileSync(localPath), fallbackMime: mimeFromPath(localPath) };
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    // 小红书图床有防盗链，必须带 Referer/UA 才能取到原图（与分析链接时同一套头）。
    const res = await fetch(raw, {
      headers: {
        Referer: 'https://www.xiaohongshu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
    if (!res.ok) throw new Error(`参考图下载失败（HTTP ${res.status}）`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    return { buf: Buffer.from(await res.arrayBuffer()), fallbackMime: /^image\//i.test(type) ? type : '' };
  }
  const filePath = path.resolve(uploadDir, path.basename(raw));
  if (fs.existsSync(filePath)) {
    return { buf: fs.readFileSync(filePath), fallbackMime: mimeFromPath(filePath) };
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw)) return { buf: Buffer.from(raw.replace(/\s/g, ''), 'base64'), fallbackMime: '' };
  return null;
}

// 参考图必须以公网 URL 或完整 Data URL 的形式提交，裸 base64 与本地路径都不被接受。
async function readImageAsDataUrl(value) {
  const src = await readImageSource(value);
  if (!src) return null;
  return referenceDataUrl(src.buf, src.fallbackMime);
}

// GPT-image 中转站的 /images/edits 要 multipart 文件，不是 Data URL。
async function readImagePart(value) {
  const src = await readImageSource(value);
  if (!src) return null;
  return referencePart(src.buf, src.fallbackMime);
}

// 生图尺寸取各供应商约束的交集：32 的倍数（自然是 16 的倍数）、宽高比 ≤3:1、
// 长边 ≤3840（GPT-image 中转站上限）、总像素 655,360~8,294,400；空值交给服务端自动判断。
const SIZE_MIN_PIXELS = 655360;
const SIZE_MAX_PIXELS = 8294400;
function normalizeImageSize(value) {
  const match = String(value || '').trim().match(/^(\d+)x(\d+)$/);
  if (!match) return 'auto';
  const snap = n => Math.max(512, Math.min(3840, Math.round(Number(n) / 32) * 32));
  let width = snap(match[1]);
  let height = snap(match[2]);
  if (width / height > 3) width = snap(height * 3);
  if (height / width > 3) height = snap(width * 3);
  const pixels = width * height;
  if (pixels > SIZE_MAX_PIXELS) {
    // 等比缩到上限内（向下取整保证不越界）。
    const k = Math.sqrt(SIZE_MAX_PIXELS / pixels);
    width = Math.max(512, Math.floor(width * k / 32) * 32);
    height = Math.max(512, Math.floor(height * k / 32) * 32);
  } else if (pixels < SIZE_MIN_PIXELS) {
    // 等比放到下限以上（向上取整保证达标），例如 512x512 → 832x832。
    const k = Math.sqrt(SIZE_MIN_PIXELS / pixels);
    width = Math.min(3840, Math.ceil(width * k / 32) * 32);
    height = Math.min(3840, Math.ceil(height * k / 32) * 32);
  }
  return `${width}x${height}`;
}

// 生图/文本都要先把参考图转成 Data URL，读不到时宁可报错也不要静默丢掉参考图。
async function loadReferenceDataUrls(payload) {
  const refs = collectReferenceImages(payload);
  if (!refs.length) return [];
  const urls = [];
  for (const ref of refs) {
    const dataUrl = await readImageAsDataUrl(ref);
    if (dataUrl) urls.push(dataUrl);
  }
  if (!urls.length) throw new Error('参考图读取失败，无法提交给模型，请重新上传。');
  return urls;
}

// form 模式（GPT-image 中转站）的参考图：multipart 文件而不是 Data URL。
async function loadReferenceParts(payload) {
  const refs = collectReferenceImages(payload);
  if (!refs.length) return [];
  const parts = [];
  for (const ref of refs) {
    const part = await readImagePart(ref);
    if (part) parts.push(part);
  }
  if (!parts.length) throw new Error('参考图读取失败，无法提交给模型，请重新上传。');
  return parts;
}

function errorFromApi(data, response, fallback) {
  const message = data.error?.message || data.message || data.error || data.msg || `${fallback}（HTTP ${response.status}）`;
  throw Object.assign(new Error(message), { code: fallback, status: response.status, data });
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => item?.text || '').join('\n');
  return content || '';
}

async function runChat(payload, provider) {
  const text = `${payload.prompt || ''}\n\n${payload.source || ''}`.trim();
  const referenceImages = []; // 文本生成不传参考图，避免请求体过大
  // 带参考图时走内容块数组，纯文本任务保持字符串，兼容只吃字符串的供应商。
  const content = referenceImages.length
    ? [{ type: 'text', text }, ...referenceImages.map(url => ({ type: 'image_url', image_url: { url } }))]
    : text;
  const messages = [{ role: 'user', content }];
  console.log('[worker] chat request', JSON.stringify({ model: payload.model || provider.textModel, images: referenceImages.length, promptChars: text.length }));
  const res = await providerRequest(provider, '/chat/completions', { model: payload.model || provider.textModel, messages });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('chat api error', res.status, res.url, JSON.stringify(data)); errorFromApi(data, res, 'ai_chat_error'); }
  const reply = data.choices?.[0]?.message?.content || data.output?.text || data.message || data.text || '';
  return { text: normalizeTextContent(reply), raw: data };
}

async function extractImageAsset(data, id, index) {
  const imageField = data.data?.[0]?.url || data.data?.[0]?.b64_json || data.images?.[0] || data.url || data.output?.image || data.b64_json;
  if (!imageField) return null;
  let buffer;
  if (/^data:image\//.test(imageField)) buffer = Buffer.from(imageField.split(',')[1], 'base64');
  else if (/^https?:\/\//i.test(imageField)) {
    const res = await fetch(imageField);
    if (!res.ok) throw new Error(`图片下载失败（HTTP ${res.status}）`);
    buffer = Buffer.from(await res.arrayBuffer());
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(imageField)) buffer = Buffer.from(imageField, 'base64');
  else throw new Error('AI 图片返回格式无法识别');
  const suffix = index > 0 ? '-p' + index : '';
  const out = path.join(videoDir, `${id}${suffix}.png`);
  // 重新编码剥掉 EXIF/XMP/ICC/文本块：部分上游会在图里写生成工具标记，带着发布容易被平台当成 AI 图。
  let clean = buffer;
  try { clean = await sharp(buffer).png().toBuffer(); } catch { /* 解码失败就按原样保存 */ }
  fs.writeFileSync(out, clean);
  return `/videos/${path.basename(out)}`;
}

// 「按参考图一一对应生成」：/images/edits 的 n 只支持 1，多图输入时第 1 张是主编辑图、其余只作参考，
// 一次请求拿不到「图1→结果1、图2→结果2」，所以每张参考图要单独发一次编辑请求。
const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function toRefIndex(token) {
  const text = String(token || '').trim();
  if (/^[0-9]+$/.test(text)) return Number(text);
  return CN_DIGITS[text] || 0;
}

// 把「将图1…／将图2…」这种按图编号写的提示词拆成每图一份：命中编号的行只发给对应的参考图，
// 没写编号的行当作全局要求附加到每一份；完全没写编号时退回完整提示词，行为不变。
function splitPromptByReference(prompt, refCount) {
  const lines = String(prompt || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const perRef = Array.from({ length: refCount }, () => []);
  const shared = [];
  let hadTarget = false;
  for (const line of lines) {
    const targets = new Set();
    for (const match of line.matchAll(/(?:参考图|图片|图|第)\s*([0-9]+|[一二三四五六七八九十])\s*/g)) {
      const n = toRefIndex(match[1]);
      if (n >= 1 && n <= refCount) targets.add(n);
    }
    if (targets.size) {
      hadTarget = true;
      targets.forEach(n => perRef[n - 1].push(line));
    } else {
      shared.push(line);
    }
  }
  if (!hadTarget) return Array.from({ length: refCount }, () => String(prompt || '').trim());
  return perRef.map(parts => [...shared, ...parts].join('\n').trim());
}

async function runImage(payload, provider, id) {
  const prompt = payload.prompt || '';
  const count = Math.max(1, Math.min(4, Number(payload.count) || 1));
  // 尺寸交给模型的必须是合法值（32 的倍数 / 比例 ≤3:1），画布选项才真正生效。
  const size = normalizeImageSize(payload.canvasSize);
  const model = payload.model || provider.imageModel;
  // form 模式（GPT-image 中转站）：编辑接口只收 multipart 文件，响应始终是 b64_json。
  const useFormApi = provider.imageApi === 'form';
  const referenceImages = useFormApi ? [] : await loadReferenceDataUrls(payload);
  const referenceParts = useFormApi ? await loadReferenceParts(payload) : [];
  const referenceCount = useFormApi ? referenceParts.length : referenceImages.length;
  // 有参考图必须走 /images/edits：/images/generations 的 image 字段会被服务端静默忽略。
  const pathname = referenceCount ? '/images/edits' : '/images/generations';
  // 每张参考图单独一次编辑请求，count 是每张参考图的张数，最终张数 = 参考图数 x count。
  const perReference = pathname === '/images/edits' && referenceCount > 1 && payload.perReference !== false;
  const requests = perReference ? referenceCount * count : count;
  const splitPrompts = perReference ? splitPromptByReference(prompt, referenceCount) : null;
  const referenceIndexes = [];
  const images = [];
  let lastData = {};
  console.log('[worker] image request', JSON.stringify({ path: pathname, model, size, api: useFormApi ? 'form' : 'json', references: referenceCount, perReference, requests }));
  for (let i = 0; i < requests; i++) {
    const refIndex = perReference ? (i % referenceCount) : -1;
    const body = { model, prompt: splitPrompts ? splitPrompts[refIndex] : prompt, n: 1, size };
    let res;
    if (useFormApi) {
      const partsForThis = refIndex >= 0 ? [referenceParts[refIndex]] : referenceParts;
      // 中转站文档只列出 model/prompt/n/size 等字段，watermark 这类 SenseNova 扩展不带。
      res = await imageRequest(provider, pathname, { body, parts: partsForThis.length ? partsForThis : null });
    } else {
      const refsForThis = refIndex >= 0 ? [referenceImages[refIndex]] : referenceImages;
      body.watermark = false;
      if (refsForThis.length) body.images = refsForThis.map(image_url => ({ image_url }));
      res = await imageRequest(provider, pathname, { body });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('image api error', pathname, res.status, res.url, JSON.stringify(data)); errorFromApi(data, res, 'ai_image_error'); }
    lastData = data;
    const url = await extractImageAsset(data, id, i);
    if (url) {
      images.push(url);
      referenceIndexes.push(refIndex >= 0 ? refIndex + 1 : images.length);
    }
  }
  if (!images.length) return { image: lastData, raw: lastData };
  const result = { images, image: images[0], raw: lastData };
  if (perReference) {
    result.perReference = true;
    result.referenceCount = referenceCount;
    result.imageReferences = referenceIndexes;
    result.splitPrompts = splitPrompts;
  }
  return result;
}

function resolveUploadUrl(value) {
  if (!value) return '';
  if (value.startsWith('/uploads/')) return path.resolve(uploadDir, path.basename(value));
  if (/^https?:\/\//i.test(value)) return value;
  return path.resolve(uploadDir, path.basename(value));
}

function buildVideoFilter(payload, duration) {
  const intensityRaw = Number(payload.shakeStrength);
  const frequencyRaw = Number(payload.shakeFrequency);
  const intensity = Math.max(0, Math.min(100, Number.isFinite(intensityRaw) ? intensityRaw : 35));
  const frequency = Math.max(0, Math.min(100, Number.isFinite(frequencyRaw) ? frequencyRaw : 45));
  const motionEffect = payload.motionEffect || '手持轻晃';
  const { width, height } = parseCanvasSize(payload.canvasSize);
  const totalFrames = Math.max(1, duration * 30);
  // 强度是所有模式的统一幅度缩放，0 表示完全静止。
  const ampScale = intensity / 50;
  // 频率滑杆控制手持模式高频微抖的速率（整段视频里的抖动周期数）。
  const jitterCycles = 4 + frequency / 5;
  const p = '(on/' + totalFrames + ')';
  // smoothstep 缓动：起步和收尾都柔和，避免线性运动的机械感。
  const ease = '(' + p + '*' + p + '*(3-2*' + p + '))';
  let zExpr, xExpr, yExpr, rotExpr = null;
  switch (motionEffect) {
    case '缓慢推近': {
      const range = (0.06 + 0.08 * intensity / 100) * (intensity === 0 ? 0 : 1);
      zExpr = '1+' + range.toFixed(4) + '*' + ease;
      xExpr = 'iw/2-(iw/zoom/2)';
      yExpr = 'ih/2-(ih/zoom/2)';
      break;
    }
    case '缓慢拉远': {
      const range = (0.06 + 0.08 * intensity / 100) * (intensity === 0 ? 0 : 1);
      zExpr = '1+' + range.toFixed(4) + '-' + range.toFixed(4) + '*' + ease;
      xExpr = 'iw/2-(iw/zoom/2)';
      yExpr = 'ih/2-(ih/zoom/2)';
      break;
    }
    case '轻微环绕': {
      // 真正的圆周运镜：整圈回到起点，天然无缝循环。
      const r = 0.012 * ampScale;
      zExpr = '1.06';
      xExpr = 'iw/2-(iw/zoom/2)+' + r.toFixed(5) + '*iw*sin(2*PI*' + p + ')';
      yExpr = 'ih/2-(ih/zoom/2)-' + r.toFixed(5) + '*ih*cos(2*PI*' + p + ')';
      break;
    }
    default: {
      // 手持轻晃：低频呼吸/漂移 + 高频微抖 + 微小旋转，多组不可通约的正弦叠加避免机械感。
      if (ampScale === 0) {
        zExpr = '1.0';
        xExpr = 'iw/2-(iw/zoom/2)';
        yExpr = 'ih/2-(ih/zoom/2)';
        break;
      }
      const breathe = 0.015 * ampScale;
      const microZ = 0.004 * ampScale;
      const driftX = 0.006 * ampScale;
      const driftY = 0.005 * ampScale;
      const microX = 0.002 * ampScale;
      const microY = 0.0018 * ampScale;
      // zoom 基准 1.08：给旋转和平移留出裁剪余量，保证不露黑边。
      zExpr = '1.08+' + breathe.toFixed(5) + '*sin(2*PI*' + p + '*2)+' + microZ.toFixed(5) + '*sin(2*PI*' + p + '*' + jitterCycles.toFixed(2) + '+1.3)';
      xExpr = 'iw/2-(iw/zoom/2)+' + driftX.toFixed(5) + '*iw*sin(2*PI*' + p + '*1.5)+' + microX.toFixed(5) + '*iw*sin(2*PI*' + p + '*' + (jitterCycles * 1.37).toFixed(2) + '+2.1)';
      yExpr = 'ih/2-(ih/zoom/2)+' + driftY.toFixed(5) + '*ih*sin(2*PI*' + p + '*1.7+0.9)+' + microY.toFixed(5) + '*ih*sin(2*PI*' + p + '*' + (jitterCycles * 1.73).toFixed(2) + '+4.2)';
      // rotate 的 a 用弧度、时间基准是 t（秒），输入已固定 30fps，t 与 on/30 一致。
      const rotDeg = 0.4 * ampScale;
      rotExpr = (rotDeg * Math.PI / 180).toFixed(6) + '*sin(2*PI*t/' + duration + '*2.7)';
      break;
    }
  }
  // 先把原图放大 2 倍再进 zoompan：亚像素位移有更细的采样网格，消除一顿一顿的抖动。
  const parts = ['scale=iw*2:ih*2:flags=lanczos'];
  if (rotExpr) parts.push(`rotate=a='${rotExpr}':c=black`);
  parts.push(`zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${width}x${height}:fps=30`);
  return parts.join(',');
}

function makeVideo(payload, id) {
  return new Promise((resolve, reject) => {
    const input = resolveUploadUrl(payload.mediaUrls?.[0]);
    if (!input) return reject(new Error('图片素材缺失，请先上传实况视频图片。'));
    if (input.startsWith(uploadDir) && !fs.existsSync(input)) return reject(new Error('input_file_missing'));
    const output = path.join(videoDir, id + '.mp4');
    const duration = parseDuration(payload);
    const filter = buildVideoFilter(payload, duration);
    const startedAt = Date.now();
    // 上传组件只接受图片，恒为静帧输入：始终循环并锁定 30fps，
    // 让 rotate 滤镜的时间基准 t 与输出的 30fps 严格一致（on = t*30）。
    const inputOptions = ['-loop', '1', '-framerate', '30'];
    const outputOptions = ['-t', String(duration), '-vf', filter, '-pix_fmt', 'yuv420p', '-c:v', 'libx264'];
    console.log('[worker] ffmpeg start', JSON.stringify({
      jobId: id,
      input,
      output,
      ffmpegPath,
      duration,
      canvasSize: payload.canvasSize,
      inputOptions,
      outputOptions
    }));
    const ffmpegRun = ffmpeg(input)
      .inputOptions(inputOptions)
      .outputOptions(outputOptions);
    ffmpegRun
      .on('start', command => console.log('[worker] ffmpeg process start', JSON.stringify({ jobId: id, command })))
      .on('stdout', data => console.log('[worker] ffmpeg stdout', JSON.stringify({ jobId: id, line: String(data).trim() })))
      .on('stderr', data => console.log('[worker] ffmpeg stderr', JSON.stringify({ jobId: id, line: String(data).trim() })))
      .on('end', () => {
        console.log('[worker] ffmpeg end', JSON.stringify({ jobId: id, output, durationMs: Date.now() - startedAt }));
        resolve(output);
      })
      .on('error', err => {
        console.error('[worker] ffmpeg error', JSON.stringify({ jobId: id, durationMs: Date.now() - startedAt, message: err?.message, code: err?.code, signal: err?.signal }));
        reject(err);
      });
    ffmpegRun.save(output);
  });
}

new Worker('ai-tasks', async (job) => {
  const { id, payload, userId } = job.data;
  try {
    if (job.name === 'rewrite') {
      const provider = await resolveProvider(payload, 'text', userId);
      const result = await runChat(payload, provider);
      await updateTask(userId, id, { status: 'done', result: { ...result, providerId: provider.id, providerName: provider.name } });
      return result;
    }
    if (job.name === 'image') {
      const provider = await resolveProvider(payload, 'image', userId);
      const result = await runImage(payload, provider, id);
      const resultForStore = {
        ...result,
        raw: { created: result.raw?.created, usage: result.raw?.usage, data: result.raw?.data?.map(item => ({ has_url: !!item?.url, has_b64: !!item?.b64_json })) },
        providerId: provider.id,
        providerName: provider.name
      };
      await updateTask(userId, id, { status: 'done', result: resultForStore });
      return result;
    }
    if (job.name === 'video') {
      const out = await makeVideo(payload, id);
      const duration = parseDuration(payload);
      const options = {
        canvasSize: payload.canvasSize,
        duration,
        durationMode: payload.durationMode || 'fixed',
        motionEffect: payload.motionEffect || '手持轻晃',
        shakeStrength: Math.max(0, Math.min(100, Number.isFinite(Number(payload.shakeStrength)) ? Number(payload.shakeStrength) : 0)),
        shakeFrequency: Math.max(0, Math.min(100, Number.isFinite(Number(payload.shakeFrequency)) ? Number(payload.shakeFrequency) : 0))
      };
      const videoResult = {
        video: `/videos/${path.basename(out)}`,
        localVideoPath: out,
        prompt: payload.prompt || '',
        options,
        raw: { ffmpeg: 'done', mediaUrls: payload.mediaUrls || [] }
      };
      console.log('[worker] video updateTask before', JSON.stringify({ jobId: id, status: 'done', videoResult }));
      await updateTask(userId, id, { status: 'done', result: videoResult });
      console.log('[worker] video updateTask after', JSON.stringify({ jobId: id, status: 'done', videoResult }));
      return videoResult;
    }
    throw new Error('unknown_job');
  } catch (err) {
    await updateTask(userId, id, { status: 'failed', error: JSON.stringify({ error: err.message, code: err.code || 'worker_error' }) });
    throw err;
  }
}, {
    connection: redis,
    concurrency: Number(process.env.QUEUE_CONCURRENCY || 2),
    lockDuration: jobLockDuration,
    lockRenewTime: jobLockDuration,
    stalledInterval: workerStalledInterval,
    maxStalledCount: jobMaxStalledCount
  });








