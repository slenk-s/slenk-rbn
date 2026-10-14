import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { dataDir, updateTask, getProviderById, getActiveProvider } from './store.js';

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

function shouldUseStillImageLoop(payload) {
  const { width, height } = parseCanvasSize(payload.canvasSize);
  const duration = parseDuration(payload);
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && duration >= 2;
}


const ffmpegPath = resolveExisting(process.env.FFMPEG_PATH) || (fs.existsSync('E:/FFmpeg/ffmpeg.exe') ? 'E:/FFmpeg/ffmpeg.exe' : null) || ffmpegStatic;
ffmpeg.setFfmpegPath(ffmpegPath);

const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: null });
const uploadDir = process.env.UPLOADS_PATH ? (path.isAbsolute(process.env.UPLOADS_PATH) ? process.env.UPLOADS_PATH : path.resolve(root, process.env.UPLOADS_PATH)) : path.join(dataDir, 'uploads');
const videoDir = process.env.VIDEO_OUT_PATH ? (path.isAbsolute(process.env.VIDEO_OUT_PATH) ? process.env.VIDEO_OUT_PATH : path.resolve(root, process.env.VIDEO_OUT_PATH)) : path.join(dataDir, 'videos');
fs.mkdirSync(videoDir, { recursive: true });

function resolveProvider(payload, mode) {
  const provider = payload.providerId ? getProviderById(payload.providerId) || getActiveProvider(mode) : getActiveProvider(mode);
  if (!provider) throw new Error('no active AI provider');
  return provider;
}

function providerRequest(provider, pathname, body) {
  if (!provider.baseUrl) throw new Error('供应商 baseUrl 为空');
  if (!provider.apiKey) throw new Error('供应商 API Key 为空');
  const url = new URL(pathname.replace(/^\//, ''), `${provider.baseUrl.replace(/\/$/, '')}/`);
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}`, accept: 'application/json' }, body: JSON.stringify(body) });
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
}

// 参考图必须以公网 URL 或完整 Data URL 的形式提交，裸 base64 与本地路径都不被接受。
async function readImageAsDataUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^data:image\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) {
    // 小红书图床有防盗链，必须带 Referer/UA 才能取到原图（与分析链接时同一套头）。
    const res = await fetch(raw, {
      headers: {
        Referer: 'https://www.xiaohongshu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
    if (!res.ok) throw new Error(`参考图下载失败（HTTP ${res.status}）`);
    const type = res.headers.get('content-type') || '';
    const mime = /jpe?g/i.test(type) ? 'image/jpeg' : /webp/i.test(type) ? 'image/webp' : 'image/png';
    const buf = Buffer.from(await res.arrayBuffer());
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  }
  const filePath = path.resolve(uploadDir, path.basename(raw));
  if (fs.existsSync(filePath)) {
    return 'data:' + mimeFromPath(filePath) + ';base64,' + fs.readFileSync(filePath).toString('base64');
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw)) return 'data:image/png;base64,' + raw.replace(/\s/g, '');
  return null;
}

// 生图接口要求宽高为 32 的倍数、在 [512,4096] 内、宽高比不超过 3:1；空值交给服务端自动判断。
function normalizeImageSize(value) {
  const match = String(value || '').trim().match(/^(\d+)x(\d+)$/);
  if (!match) return 'auto';
  const snap = n => Math.max(512, Math.min(4096, Math.round(Number(n) / 32) * 32));
  let width = snap(match[1]);
  let height = snap(match[2]);
  if (width / height > 3) width = snap(height * 3);
  if (height / width > 3) height = snap(width * 3);
  return `${width}x${height}`;
}

function collectReferenceImages(payload) {
  const list = payload.imageUrls?.length ? payload.imageUrls : (payload.image ? [payload.image] : []);
  return (Array.isArray(list) ? list : [list]).filter(Boolean).slice(0, 5);
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
  const referenceImages = await loadReferenceDataUrls(payload);
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
  fs.writeFileSync(out, buffer);
  return `/videos/${path.basename(out)}`;
}

async function runImage(payload, provider, id) {
  const prompt = payload.prompt || '';
  const count = Math.max(1, Math.min(4, Number(payload.count) || 1));
  // 尺寸交给模型的必须是合法值（32 的倍数 / 比例 ≤3:1），画布选项才真正生效。
  const size = normalizeImageSize(payload.canvasSize);
  const model = payload.model || provider.imageModel;
  const referenceImages = await loadReferenceDataUrls(payload);
  // 有参考图必须走 /images/edits：/images/generations 的 image 字段会被服务端静默忽略。
  const pathname = referenceImages.length ? '/images/edits' : '/images/generations';
  const images = [];
  let lastData = {};
  console.log('[worker] image request', JSON.stringify({ path: pathname, model, size, references: referenceImages.length, count }));
  for (let i = 0; i < count; i++) {
    const body = { model, prompt, n: 1, size, watermark: false };
    if (referenceImages.length) body.images = referenceImages.map(image_url => ({ image_url }));
    const res = await providerRequest(provider, pathname, body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('image api error', pathname, res.status, res.url, JSON.stringify(data)); errorFromApi(data, res, 'ai_image_error'); }
    lastData = data;
    const url = await extractImageAsset(data, id, i);
    if (url) images.push(url);
  }
  if (!images.length) return { image: lastData, raw: lastData };
  return { images, image: images[0], raw: lastData };
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
  const freqDiv = Math.max(1, frequency / 3);
  // 抖动强度 0 表示不抖动，此时保持 1.0 倍稳定画面。
  const amp = intensity === 0 ? 0 : 0.02 + intensity / 10000;
  const prog = '(on/' + totalFrames + ')';
  let zExpr, xExpr, yExpr;
  switch (motionEffect) {
    case '缓慢推近':
      zExpr = '1.0+0.06*' + prog;
      xExpr = 'iw/2-(iw/zoom/2)';
      yExpr = 'ih/2-(ih/zoom/2)';
      break;
    case '缓慢拉远':
      zExpr = '1.06-0.06*' + prog;
      xExpr = 'iw/2-(iw/zoom/2)';
      yExpr = 'ih/2-(ih/zoom/2)';
      break;
    case '轻微环绕':
      zExpr = '1.05';
      xExpr = 'iw/2-(iw/zoom/2)+0.01*(' + prog + '-0.5)*iw';
      yExpr = 'ih/2-(ih/zoom/2)+0.01*(' + prog + '-0.5)*ih';
      break;
    default:
      zExpr = 'if(eq(on,0),1.0,1.0+' + amp + '*(1+sin(on/' + freqDiv + ')))';
      xExpr = 'iw/2-(iw/zoom/2)';
      yExpr = 'ih/2-(ih/zoom/2)';
      break;
  }
  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${width}x${height}':fps=30`;
}

function makeVideo(payload, id) {
  return new Promise((resolve, reject) => {
    const input = resolveUploadUrl(payload.mediaUrls?.[0]);
    if (!input) return reject(new Error('图片素材缺失，请先上传实况视频图片。'));
    if (input.startsWith(uploadDir) && !fs.existsSync(input)) return reject(new Error('input_file_missing'));
    const output = path.join(videoDir, id + '.mp4');
    const duration = parseDuration(payload);
    const filter = buildVideoFilter(payload, duration);
    ffmpeg(input)
      .inputOptions(shouldUseStillImageLoop(payload) ? ['-loop', '1'] : [])
      .outputOptions(['-t', String(duration), '-vf', filter, '-pix_fmt', 'yuv420p', '-c:v', 'libx264'])
      .on('end', () => resolve(output))
      .on('error', reject)
      .save(output);
  });
}

new Worker('ai-tasks', async (job) => {
  const { id, payload } = job.data;
  try {
    if (job.name === 'rewrite') {
      const provider = resolveProvider(payload, 'text');
      const result = await runChat(payload, provider);
      updateTask(id, { status: 'done', result: JSON.stringify({ ...result, providerId: provider.id, providerName: provider.name }) });
      return result;
    }
    if (job.name === 'image') {
      const provider = resolveProvider(payload, 'image');
      const result = await runImage(payload, provider, id);
      const resultForStore = {
        ...result,
        raw: { created: result.raw?.created, usage: result.raw?.usage, data: result.raw?.data?.map(item => ({ has_url: !!item?.url, has_b64: !!item?.b64_json })) },
        providerId: provider.id,
        providerName: provider.name
      };
      updateTask(id, { status: 'done', result: JSON.stringify(resultForStore) });
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
      updateTask(id, {
        status: 'done',
        result: JSON.stringify({
          video: `/videos/${path.basename(out)}`,
          localVideoPath: out,
          prompt: payload.prompt || '',
          options,
          raw: { ffmpeg: 'done', mediaUrls: payload.mediaUrls || [] }
        })
      });
      return { video: `/videos/${path.basename(out)}`, localVideoPath: out, prompt: payload.prompt || '', options };
    }
    throw new Error('unknown_job');
  } catch (err) {
    updateTask(id, { status: 'failed', error: JSON.stringify({ error: err.message, code: err.code || 'worker_error' }) });
    throw err;
  }
}, { connection: redis, concurrency: Number(process.env.QUEUE_CONCURRENCY || 2) });








