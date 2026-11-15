import { Router } from 'express';
import { getMedia } from '../store.js';

// 生成媒体读回：/api/media/<id>。媒体 id 为 crypto.randomUUID()（不可猜测），
// 与旧 Supabase 公网 bucket 同等的威胁模型（拿到 URL 即可读），故不强制鉴权；
// 前端 <img>/<video> 无法携带 Bearer 头，须走公开只读路由。
// ?download=1 时以附件形式下发（Content-Disposition），供下载链接直用。
export const router = Router();

router.get('/:id', async (req, res, next) => {
  try {
    const row = await getMedia(req.params.id);
    if (!row) return res.status(404).json({ error: 'media_not_found' });
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(row.filename) + '"');
    }
    res.send(row.data);
  } catch (err) { next(err); }
});
