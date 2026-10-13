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

async function providerRequestWithImage(provider, pathname, formData) {
  if (!provider.baseUrl) throw new Error('供应商 baseUrl 为空');
  if (!provider.apiKey) throw new Error('供应商 API Key 为空');
  const url = new URL(pathname.replace(/^\//, ''), `${provider.baseUrl.replace(/\/$/, '')}/`);
  formData.set('model', provider.imageModel);
  return fetch(url, { method: 'POST', headers: { authorization: `Bearer ${provider.apiKey}`, accept: 'application/json' }, body: formData });
}function readUploadedAsDataUrl(value) {
  if (!value) return null;
  let filePath = null;
  if (value.startsWith('/uploads/')) filePath = path.resolve(uploadDir, path.basename(value));
  else if (/^https?:\/\//i.test(value)) return value;
  else filePath = path.resolve(uploadDir, path.basename(value));
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
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
  const messages = [{ role: 'user', content: `${payload.prompt}\n\n${payload.source || ''}`.trim() }];
  const res = await providerRequest(provider, '/chat/completions', { model: payload.model || provider.textModel, messages });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('chat api error', res.status, res.url, JSON.stringify(data)); errorFromApi(data, res, 'ai_chat_error'); }
  const content = data.choices?.[0]?.message?.content || data.output?.text || data.message || data.text || '';
  return { text: normalizeTextContent(content), raw: data };
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
  const prompt = payload.prompt;
  const image = payload.image;
  const count = Math.max(1, Math.min(4, Number(payload.count) || 1));
  const body = { model: payload.model || provider.imageModel, prompt, n: 1 };
  if (image) {
    let imageData = image;
    try { imageData = JSON.parse(image); } catch {}
    if (typeof imageData === 'string') {
      const dataUrl = readUploadedAsDataUrl(imageData);
      if (dataUrl) body.image = dataUrl;
      else body.image = imageData;
    } else {
      body.image = imageData;
    }
  }
  const images = [];
  let lastData = {};
  for (let i = 0; i < count; i++) {
    const res = await providerRequest(provider, '/images/generations', body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error('image api error', res.status, res.url, JSON.stringify(data)); errorFromApi(data, res, 'ai_image_error'); }
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
  const intensity = Math.max(0, Math.min(100, Number(payload.shakeStrength) || 35));
  const frequency = Math.max(0, Math.min(100, Number(payload.shakeFrequency) || 45));
  const motionEffect = payload.motionEffect || '手持轻晃';
  const { width, height } = parseCanvasSize(payload.canvasSize);
  const totalFrames = Math.max(1, duration * 30);
  const freqDiv = Math.max(1, frequency / 3);
  const amp = intensity / 10000;
  const prog = '(on/' + totalFrames + ')';
  let zExpr, xExpr, yExpr;
  switch (motionEffect) {
    case '推进':
      zExpr = '1.0+' + amp + '*' + prog;
      xExpr = 'iw/2-(iw/zoom/2)';
      yExpr = 'ih/2-(ih/zoom/2)';
      break;
    case '拉远':
      zExpr = '1.0+' + amp + '*(1-' + prog + ')';
      xExpr = 'iw/2-(iw/zoom/2)';
      yExpr = 'ih/2-(ih/zoom/2)';
      break;
    case '平移':
      zExpr = '1.1';
      xExpr = 'iw/2-(iw/zoom/2)+' + (intensity / 200) + '*' + '(' + prog + '-0.5)*iw';
      yExpr = 'ih/2-(ih/zoom/2)';
      break;
    case '漂移':
      zExpr = '1.05';
      xExpr = 'iw/2-(iw/zoom/2)+' + (intensity / 200) + '*' + '(' + prog + '-0.5)*iw';
      yExpr = 'ih/2-(ih/zoom/2)+' + (intensity / 200) + '*' + '(' + prog + '-0.5)*ih';
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
        shakeStrength: Math.max(0, Math.min(100, Number(payload.shakeStrength) || 35)),
        shakeFrequency: Math.max(0, Math.min(100, Number(payload.shakeFrequency) || 45))
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








