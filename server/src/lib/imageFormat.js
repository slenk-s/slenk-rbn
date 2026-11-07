import sharp from 'sharp';

// 图片落盘只允许 jpg / png：jpeg/png 原样保留，其他格式（webp/gif/avif 等）统一转 png。
// 返回 { buf, ext }；无法解码返回 null。
export function sniffImageFormat(buf) {
  if (!buf || buf.length < 12) return 'unknown';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1').toLowerCase();
    if (brand.startsWith('hei') || brand.startsWith('mif') || brand.startsWith('msf')) return 'heic';
    if (brand.startsWith('avi')) return 'avif';
  }
  return 'unknown';
}

export async function toStandardImage(buf) {
  const fmt = sniffImageFormat(buf);
  if (fmt === 'jpeg') return { buf, ext: '.jpg' };
  if (fmt === 'png') return { buf, ext: '.png' };
  try {
    // sharp 默认构建能解 webp/gif/avif；gif 取第一帧。解码不了（如 heic）抛错交给调用方兜底。
    const out = await sharp(buf, { failOn: 'none' }).png().toBuffer();
    return { buf: out, ext: '.png' };
  } catch {
    return null;
  }
}
