// 把一篇笔记打包成小红书小工具 zip：模板 + note.js(烧入文案) + images/(压缩后的图片)。
// 规范来自 minitool-zip-builder Skill：index.html 在根、无内联脚本、无网络请求、包体 ≤10MiB。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { paths } from '../paths.js';
import { safeRemoteImageFetch } from './safeRemoteImage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(__dirname, '../../minitool-template');
const buildsDir = path.join(paths.dataDir, 'minitool-builds');
const notesImagesDir = path.join(paths.dataDir, 'notes-images');
const BUILD_ROOT = path.resolve(buildsDir);

export function cleanupMiniToolArtifacts(buildId) {
  if (typeof buildId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(buildId)) return;
  const dir = path.resolve(BUILD_ROOT, buildId);
  const prefix = path.resolve(BUILD_ROOT, buildId);
  if (path.dirname(dir) !== BUILD_ROOT) return;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const suffix of ['.zip', '-qr.png', '-qr.json']) fs.rmSync(prefix + suffix, { force: true });
}

// 启动清理只扫自有构建根目录的元数据（O(n) 次 lstat，跳过符号链接），
// 单次运行删除所有确实过期的条目——不为过期删除设上限，避免脏目录跨多次重启才收敛。
// maxEntries 仅作为防御性总量护栏保留（默认不设限）。由服务器启动入口显式调用，
// 模块被测试或其他代码 import 时绝不触碰真实存储。
export function janitorMiniToolArtifacts({ root = BUILD_ROOT, maxEntries = Infinity, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const candidates = [];
  for (const entry of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
    const target = path.resolve(resolvedRoot, entry.name);
    if (path.dirname(target) !== resolvedRoot) continue;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) continue;
      candidates.push({ target, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  let removed = 0;
  for (const { target, mtimeMs } of candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (removed >= maxEntries) break;
    if (now() - mtimeMs < maxAgeMs) continue;
    try { fs.rmSync(target, { recursive: true, force: true }); removed++; } catch {}
  }
  return removed;
}

const ZIP_HARD_LIMIT = 9.5 * 1024 * 1024; // 上传硬上限 10MiB，留 0.5MiB 余量
export const MINITOOL_TITLE_MAX = 20;
export const MINITOOL_CONTENT_MAX = 1000;
export function effectiveMiniToolTitle(value) {
  return [...String(value || '').trim()].slice(0, MINITOOL_TITLE_MAX).join('');
}
export const SOURCE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const SOURCE_IMAGES_TOTAL_MAX_BYTES = 100 * 1024 * 1024;
export function createSourceImageBudget(limit = SOURCE_IMAGES_TOTAL_MAX_BYTES) {
  let used = 0;
  return {
    remaining: () => limit - used,
    consume(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || used + bytes > limit) throw new Error('source_images_total_too_large');
      used += bytes;
      return used;
    }
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('publish_job_aborted');
}

function combinedFetchSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const forward = source => () => controller.abort(source.reason);
  signal.addEventListener('abort', forward(signal), { once: true });
  timeout.addEventListener('abort', forward(timeout), { once: true });
  if (signal.aborted) controller.abort(signal.reason);
  return controller.signal;
}

// 与 worker 的图片解析一致：云端 URL 下载，站内相对路径读本地。
async function readBoundedBody(response, maxBytes, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error('source_image_too_large');
  }
  if (!response.body?.getReader) throw new Error('source_image_invalid_body');
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('source_image_too_large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function readLocalBounded(filePath, maxBytes, signal) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('source_image_too_large');
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (!bytesRead) throw new Error('source_image_short_read');
      offset += bytesRead;
    }
    return buffer;
  } finally { await handle.close(); }
}

export async function readImageBuffer(value, index, signal, {
  fetchRemote = safeRemoteImageFetch,
  maxBytes = SOURCE_IMAGE_MAX_BYTES
} = {}) {
  throwIfAborted(signal);
  if (/^https?:\/\//i.test(value)) {
    const res = await fetchRemote(value, { signal: combinedFetchSignal(signal, 30000) });
    if (!res.ok) { await res.body?.cancel?.().catch(() => {}); throw new Error(`第 ${index + 1} 张图片下载失败（HTTP ${res.status}）`); }
    return readBoundedBody(res, maxBytes, signal);
  }
  const base = value.startsWith('/notes-images/') ? notesImagesDir : value.startsWith('/videos/') ? paths.videosDir : paths.uploadsDir;
  const p = path.resolve(base, path.basename(value));
  if (!p.startsWith(path.resolve(base))) throw new Error(`第 ${index + 1} 张图片不存在`);
  try { return await readLocalBounded(p, maxBytes, signal); }
  catch (error) { if (error?.code === 'ENOENT') throw new Error(`第 ${index + 1} 张图片不存在`); throw error; }
}

// 容器预算：图片按展示尺寸缩放压成 JPEG；包体超限时逐级降质。
async function compressForBundle(buf, maxEdge, quality) {
  return sharp(buf, { limitInputPixels: 40_000_000, sequentialRead: true, failOn: 'error' })
    .rotate() // 按 EXIF 方向转正
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality })
    .toBuffer();
}

// 文案中的 < 统一转义，防止 note.js 内容里出现 </script> 之类的注入面。
// publishContent 追加小红书原生话题标记 #xxx[话题]#（与官方 desc 格式一致），
// 让发布页把话题识别为真实话题实体；展示用 content 保持干净。
function bakeNoteJs({ title, content, tags, imageCount }) {
  const cleanTags = (Array.isArray(tags) ? tags : []).map(t => String(t).replace(/^#+/, '').trim()).filter(Boolean).slice(0, 20);
  const cleanContent = String(content || '').slice(0, MINITOOL_CONTENT_MAX);
  let publishContent = cleanContent;
  for (const t of cleanTags) {
    const piece = ` #${t}[话题]#`;
    if ((publishContent + piece).length > MINITOOL_CONTENT_MAX) break;
    publishContent += piece;
  }
  const data = {
    title: effectiveMiniToolTitle(title),
    content: cleanContent,
    publishContent,
    tags: cleanTags,
    images: Array.from({ length: imageCount }, (_, i) => `./images/${i + 1}.jpg`)
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `// 由 Slenk Notes 打包时生成，请勿手改。\nwindow.NOTE_DATA = ${json};\n`;
}

export async function buildMiniToolZip({ buildId, title, content, tags, imageUrls, signal }) {
  throwIfAborted(signal);
  const images = (imageUrls || []).filter(Boolean).slice(0, 9);
  if (!images.length) throw new Error('至少需要 1 张图片');

  const dir = path.join(buildsDir, buildId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });

  // 模板文件原样拷贝
  fs.copyFileSync(path.join(templateDir, 'index.html'), path.join(dir, 'index.html'));
  fs.copyFileSync(path.join(templateDir, 'app.js'), path.join(dir, 'app.js'));

  // 图片：逐级降质直到包体达标
  const levels = [
    { maxEdge: 1600, quality: 82 },
    { maxEdge: 1280, quality: 70 },
    { maxEdge: 1080, quality: 60 },
    { maxEdge: 960, quality: 50 }
  ];
  const raws = [];
  const sourceBudget = createSourceImageBudget();
  for (let i = 0; i < images.length; i++) {
    throwIfAborted(signal);
    const remaining = sourceBudget.remaining();
    if (remaining <= 0) throw new Error('source_images_total_too_large');
    const raw = await readImageBuffer(images[i], i, signal, { maxBytes: Math.min(SOURCE_IMAGE_MAX_BYTES, remaining) });
    sourceBudget.consume(raw.length);
    raws.push(raw);
  }

  let packed = null;
  for (const level of levels) {
    throwIfAborted(signal);
    packed = [];
    for (const raw of raws) {
      throwIfAborted(signal);
      packed.push(await compressForBundle(raw, level.maxEdge, level.quality));
    }
    const total = packed.reduce((sum, b) => sum + b.length, 0);
    if (total <= ZIP_HARD_LIMIT - 100 * 1024) break; // 模板与清单约占 100KB
  }
  for (let i = 0; i < packed.length; i++) {
    fs.writeFileSync(path.join(dir, 'images', `${i + 1}.jpg`), packed[i]);
  }

  fs.writeFileSync(path.join(dir, 'note.js'), bakeNoteJs({ title, content, tags, imageCount: images.length }));
  // 无 Worker / OffscreenCanvas / WebAssembly / 游戏引擎，按 mini-tool-manifest 规则标 false。
  fs.writeFileSync(path.join(dir, 'mini_tool.json'), JSON.stringify({ is_high_consumption_scene: false }));

  // 打包：压缩目录内容，index.html 必须在 zip 根。
  throwIfAborted(signal);
  const zipPath = path.join(buildsDir, `${buildId}.zip`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const zip = new ZipArchive({ zlib: { level: 9 } });
    const onAbort = () => {
      zip.abort();
      out.destroy(signal.reason || new Error('publish_job_aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    out.on('close', () => { cleanup(); resolve(); });
    out.on('error', error => { cleanup(); reject(error); });
    zip.on('error', error => { cleanup(); reject(error); });
    zip.pipe(out);
    zip.directory(dir, false);
    zip.finalize();
  });

  const stat = fs.statSync(zipPath);
  return { zipPath, dir, size: stat.size, imageCount: images.length };
}
