// 任务输入素材地址解析（纯函数，便于单测）。
//
// worker 收到的图片/视频地址有三类：
// - 本站相对路径：/uploads/<file>、/notes-images/<hash>.jpg、/videos/<file>
// - 本站媒体接口：/api/media/<id>（AI 生成结果，字节存在媒体表，不在 uploads 目录）
// - 外部 http(s) 地址（小红书图床、云端存储）
//
// 历史坑：/api/media/<id> 曾被当成 /uploads/<id> 去找，必失败——实况视频从笔记改写
// 传入「按图重生成」替换后的图片时，ffmpeg 报 No such file or directory。

const MEDIA_PATH_RE = /^(?:https?:\/\/[^/]+)?\/api\/media\/([^/?#]+)(?:[?#].*)?$/i;

// 从 /api/media/<id>（相对或绝对 http 地址）中取出媒体 id；其它地址返回 null。
export function parseMediaId(value) {
  const raw = String(value ?? '').trim();
  const match = raw.match(MEDIA_PATH_RE);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm'
};

// 落临时文件用的扩展名：优先用 MIME，其次沿用原始文件名，取不到就留空（ffmpeg 按内容识别）。
export function mediaExtension(mimeType, filename) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const ext = String(filename || '').match(/(\.[A-Za-z0-9]{2,5})$/);
  return ext ? ext[1].toLowerCase() : '';
}
