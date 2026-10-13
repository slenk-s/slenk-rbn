import { Router } from 'express';
import { verify } from '../auth.js';

export const router = Router();

router.get('/', verify, async (req, res) => {
  try {
    const target = String(req.query.url || '');
    if (!/^https?:\/\//.test(target)) return res.status(400).json({ error: 'invalid_url' });
    const name = String(req.query.name || 'image').replace(/[\\/:*?"<>|]/g, '_');
    const resp = await fetch(target, { headers: { 'Referer': 'https://www.xiaohongshu.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } });
    if (!resp.ok) return res.status(502).json({ error: 'upstream_error', status: resp.status });
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : contentType.includes('mp4') ? '.mp4' : '.jpg';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name + ext) + '"');
    const buf = Buffer.from(await resp.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
