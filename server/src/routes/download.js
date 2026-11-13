import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { verify } from '../auth.js';
import { paths } from '../paths.js';

export const router = Router();

function jpegVariantForHeic(target) {
  if (/\/format\/(heic|heif)(\/|$)/i.test(target)) {
    return target.replace(/\/format\/(heic|heif)(\/|$)/i, '/format/jpeg$2');
  }
  const [base, query = ''] = target.split('?');
  return base + '?imageView2/2/w/1080/format/jpeg' + (query ? '&' + query : '');
}

// 小红书图片 fileId 有的自带 notes_pre_post/ 前缀、有的不带，404 时互换前缀重试一次。
function safeLocalAssetPath(target) {
  const url = new URL(target);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const rel = url.pathname.replace(/^\//, '');
  const allowed = [
    ['/uploads/', paths.uploadsDir],
    ['/videos/', paths.videosDir],
    ['/notes-images/', path.join(paths.dataDir, 'notes-images')]
  ];
  const prefix = allowed.find(([p]) => rel.startsWith(p));
  if (!prefix) return null;
  const baseDir = path.resolve(prefix[1]);
  const filePath = path.resolve(baseDir, rel.slice(prefix[0].length));
  return filePath.startsWith(baseDir) ? filePath : null;
}

function contentTypeForLocalPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function altXhsImageTarget(target) {
  if (!/^https?:\/\/ci\.xiaohongshu\.com\//i.test(target)) return null;
  if (/^https?:\/\/ci\.xiaohongshu\.com\/notes_pre_post\//i.test(target)) {
    return target.replace(/(^https?:\/\/ci\.xiaohongshu\.com\/)notes_pre_post\//i, '$1');
  }
  return target.replace(/(^https?:\/\/ci\.xiaohongshu\.com\/)/i, '$1notes_pre_post/');
}

router.get('/', async (req, res, next) => {
  if (req.query.inline === '1') return next();
  return verify(req, res, next);
}, async (req, res) => {
  try {
    const target = String(req.query.url || '');
    if (!/^https?:\/\//.test(target)) return res.status(400).json({ error: 'invalid_url' });
    const name = String(req.query.name || 'image').replace(/[\\/:*?"<>|]/g, '_');
    const localPath = safeLocalAssetPath(target);
    if (localPath && fs.existsSync(localPath)) {
      const localType = contentTypeForLocalPath(localPath);
      const hasExt = /\.[a-z0-9]{2,5}$/i.test(name);
      const ext = hasExt ? '' : (localType.includes('mp4') ? '.mp4' : (localType.includes('png') ? '.png' : ''));
      if (req.query.inline === '1') {
        res.setHeader('Content-Type', localType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
      } else {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name + ext) + '"');
      }
      // 流式输出本地文件：不再整文件读进内存阻塞事件循环。
      res.setHeader('Content-Length', fs.statSync(localPath).size);
      await pipeline(fs.createReadStream(localPath), res);
      return;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000); // 25秒超时
    const fetchOptions = { signal: controller.signal, headers: { 'Referer': 'https://www.xiaohongshu.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } };
    let resp = await fetch(target, fetchOptions);
    let contentType = resp.headers.get('content-type') || 'application/octet-stream';
    if (resp.status === 404) {
      const alt = altXhsImageTarget(target);
      if (alt) {
        const altResp = await fetch(alt, fetchOptions);
        if (altResp.ok) {
          resp = altResp;
          contentType = resp.headers.get('content-type') || 'application/octet-stream';
        }
      }
    }
    if (resp.ok && /^image\/hei[cf]/i.test(contentType)) {
      const jpegResp = await fetch(jpegVariantForHeic(target), fetchOptions);
      const jpegType = jpegResp.headers.get('content-type') || '';
      if (jpegResp.ok && /^image\/jpe?g/i.test(jpegType)) {
        resp = jpegResp;
        contentType = jpegType;
      }
    }
    if (!resp.ok) return res.status(502).json({ error: 'upstream_error', status: resp.status });
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(name);
    const ext = hasExt ? '' : (contentType.includes('mp4') ? '.mp4' : '.png');
    if (req.query.inline === '1') {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name + ext) + '"');
    }
    // 流式转发上游字节：大视频不再整体缓冲进内存，首字节到达即开始下发。
    await pipeline(Readable.fromWeb(resp.body), res);
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ error: err.message });
  }
});
