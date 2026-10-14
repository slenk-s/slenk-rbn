import { Router } from 'express';
import { verify } from '../auth.js';
import sharp from 'sharp';

export const router = Router();

router.get('/', async (req, res, next) => {
  if (req.query.inline === '1') return next();
  return verify(req, res, next);
}, async (req, res) => {
  try {
    const target = String(req.query.url || '');
    if (!/^https?:\/\//.test(target)) return res.status(400).json({ error: 'invalid_url' });
    const name = String(req.query.name || 'image').replace(/[\\/:*?"<>|]/g, '_');
    const resp = await fetch(target, { headers: { 'Referer': 'https://www.xiaohongshu.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } });
    if (!resp.ok) return res.status(502).json({ error: 'upstream_error', status: resp.status });
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(name);
    const ext = hasExt ? '' : (contentType.includes('mp4') ? '.mp4' : '.png');
    if (req.query.inline === '1') {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name + ext) + '"');
    }
    let buf = Buffer.from(await resp.arrayBuffer());
    if (/xhscdn\.com/.test(target) && !contentType.includes('mp4')) {
      try {
        const img = sharp(buf);
        const meta = await img.metadata();
        const w = meta.width, h = meta.height;
        const wmW = Math.round(w * 0.28);
        const wmH = Math.round(h * 0.07);
        const left = w - wmW;
        const top = h - wmH;
        const blurred = await sharp(buf).extract({ left, top, width: wmW, height: wmH }).blur(25).toBuffer();
        buf = await sharp(buf).composite([{ input: blurred, left, top }]).jpeg({ quality: 95 }).toBuffer();
      } catch (e) { /* keep original if processing fails */ }
    }
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
