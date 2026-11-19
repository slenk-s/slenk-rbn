// Apple 实况照片（Live Photo）打包：把运镜视频 MP4 + 封面图封装成 .livp。
// .livp 本质是 ZIP，包含 AssetManifest.json（描述资产）、quicktime.mov（视频）、
// IMG_0001.HEIC（封面，标准 HEVC 编码）。封面必须 HEIC 才能在 Apple 设备上
// 被识别为实况照片；若 HEIC 编码器不可用则回退 JPEG（可打包但兼容性略降）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '../..');

// 与 worker.js 保持一致：优先环境变量，其次已知本地路径，最后 ffmpeg-static 兜底。
function resolveExisting(value) {
  if (!value) return null;
  const resolved = path.isAbsolute(value) ? value : path.resolve(packageRoot, value);
  return fs.existsSync(resolved) ? resolved : null;
}
const ffmpegPath = resolveExisting(process.env.FFMPEG_PATH)
  || (fs.existsSync('E:/FFmpeg/ffmpeg.exe') ? 'E:/FFmpeg/ffmpeg.exe' : null)
  || ffmpegStatic;
ffmpeg.setFfmpegPath(ffmpegPath);

// elheif 的 ESM 入口有导入路径 bug（import './elheif-wasm' 缺 .js 后缀），
// 在 Node ESM 下无法直接加载。读取其 wasm 脚本源码并 eval 初始化全局
// __init__ELHEIF_MODULE，再通过它实例化 HEIC 编码器。
let heicInitPromise = null;
function loadElheif() {
  if (!heicInitPromise) {
    heicInitPromise = (async () => {
      const wasmPath = path.join(packageRoot, 'node_modules/elheif/pkg/elheif-wasm.js');
      if (!fs.existsSync(wasmPath)) throw new Error('elheif wasm 未安装：' + wasmPath);
      const src = fs.readFileSync(wasmPath, 'utf8');
      (0, eval)(src);
      const init = globalThis.__init__ELHEIF_MODULE;
      if (typeof init !== 'function') throw new Error('elheif wasm 初始化函数缺失');
      const mod = {};
      await new Promise((resolve, reject) => {
        mod.onRuntimeInitialized = resolve;
        try {
          init(mod);
        } catch (err) {
          reject(err);
        }
      });
      return mod;
    })();
  }
  return heicInitPromise;
}

// 编码 HEIC 封面：sharp 读图 → RGBA 原始像素 → elheif 编码 HEVC/HEIC。
// 失败返回 null，调用方回退 JPEG。
async function encodeCoverHeic(coverPath) {
  try {
    const heic = await loadElheif();
    const { data, info } = await sharp(coverPath)
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // ensureAlpha 保证输出 4 通道 RGBA（无 alpha 的图补全不透明）。
    const result = heic.jsEncodeImage(new Uint8Array(data), info.width, info.height);
    if (result.err) return null;
    return Buffer.from(result.data);
  } catch (err) {
    console.warn('[livePhoto] HEIC 编码失败，回退 JPEG：', err.message);
    return null;
  }
}

// 视频转 MOV（QuickTime 容器）：-c copy 只改封装不重编码，快速且保真。
// 用独立临时文件 + Promise 封装 ffmpeg 回调。
async function toQuicktimeMov(videoPath, outputPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions(['-c', 'copy', '-f', 'mov'])
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

// 生成 AssetManifest.json：Apple Live Photo 的资产描述。
function buildAssetManifest(coverFile, videoFile) {
  return JSON.stringify({
    assets: {
      fullSizePhoto: {
        file: coverFile,
        type: 'fullSizePhoto',
        preferred: true
      },
      video: {
        file: videoFile,
        type: 'video',
        preferred: true
      }
    },
    version: 1
  }, null, 2);
}

// 打包 LIVP：封面 HEIC（或 JPEG）、视频 MOV、manifest。
async function packLivp({ videoPath, coverBuffer, coverFile, videoFile, outPath }) {
  await new Promise((resolve, reject) => {
    const out = createWriteStream(outPath);
    const zip = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', resolve);
    out.on('error', reject);
    zip.on('error', reject);
    zip.pipe(out);
    zip.append(coverBuffer, { name: coverFile });
    zip.file(videoPath, { name: videoFile });
    zip.append(buildAssetManifest(coverFile, videoFile), { name: 'AssetManifest.json' });
    zip.finalize();
  });
}

/**
 * 生成 Apple 实况照片 .livp 文件。
 * @param {string} videoPath - 运镜视频本地文件路径（MP4）
 * @param {string} coverPath - 封面图本地文件路径（任意 sharp 可读格式）
 * @param {{ taskId?: string, index?: number, outDir?: string }} [options]
 * @returns {Promise<{ path: string, size: number, coverExt: string }>}
 */
export async function createLivePhoto(videoPath, coverPath, options = {}) {
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error('视频文件缺失，无法生成 LIVP');
  if (!coverPath || !fs.existsSync(coverPath)) throw new Error('封面图片缺失，无法生成 LIVP');

  const outDir = options.outDir || path.join(os.tmpdir(), 'slenk-livp');
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = `${options.taskId || 'live'}-${Number(options.index) + 1 || 1}`;
  const outPath = path.join(outDir, `${baseName}.livp`);
  const movPath = path.join(outDir, `${baseName}.mov`);

  // 封面优先 HEIC，失败回退 JPEG。
  const heicBuf = await encodeCoverHeic(coverPath);
  const coverFile = heicBuf ? 'IMG_0001.HEIC' : 'IMG_0001.JPG';
  const coverBuffer = heicBuf || await sharp(coverPath).rotate().jpeg({ quality: 92 }).toBuffer();

  try {
    await toQuicktimeMov(videoPath, movPath);
    await packLivp({
      videoPath: movPath,
      coverBuffer,
      coverFile,
      videoFile: 'quicktime.mov',
      outPath
    });
    return { path: outPath, size: fs.statSync(outPath).size, coverExt: heicBuf ? '.HEIC' : '.JPG' };
  } finally {
    // MOV 是中间产物，LIVP 已含其内容，清理避免临时目录堆积。
    try { fs.rmSync(movPath, { force: true }); } catch { /* 忽略 */ }
  }
}
