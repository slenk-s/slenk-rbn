import sharp from 'sharp';

// 生图请求的可调选项与参考图规范化，抽成纯逻辑便于单测（worker 只做接线）。

// ---- 出图质量/速度 ----

const IMAGE_QUALITIES = new Set(['low', 'medium', 'high']);

// 供应商（GPT-image 中转站）默认 quality=high；实测同图 medium 比 high 快约 1/4，
// 所以默认 medium，payload.quality 或 SLENK_IMAGE_QUALITY 可覆盖（payload 优先）。
export function resolveImageQuality(payload, env = process.env) {
  const raw = String(payload?.quality || env?.SLENK_IMAGE_QUALITY || process.env.SLENK_IMAGE_QUALITY || 'medium').toLowerCase();
  return IMAGE_QUALITIES.has(raw) ? raw : 'medium';
}

// ---- 参考图被供应商拒收的识别 ----

// 中转站（Azure 通道）偶发以 400 「Invalid image file or mode」拒收 jpeg 参考图；
// 只有这类错误才值得把透传的原图重编码成 PNG 重试，其他错误重发无意义。
export function isInvalidImageRejection(status, data) {
  if (status !== 400 && status !== 422) return false;
  const msg = String(data?.error?.message || data?.error || data?.message || '');
  return /invalid image|image file|image mode|unsupported image|decode/i.test(msg);
}

// ---- 参考图规范化 ----

// 供应商对参考图的硬性限制：PNG/JPEG/WebP、≤10MB、边长落在 [256,4096]、宽高比 ≤2:1。
// 超限的图（手机长截图最常见，如 1440x3168 = 2.2:1）会被直接拒收，
// 所以在本地先规范化再提交；合规的图原样返回，不做任何重编码。
const REF_MAX_EDGE = 4096;
const REF_MIN_EDGE = 256;
const REF_MAX_RATIO = 2;
const REF_MAX_BYTES = 10 * 1024 * 1024;
const REF_FORMATS = new Set(['png', 'jpeg', 'webp']);

// 合规（格式/尺寸/比例达标、无 EXIF 旋转）的原图直接透传同一个 buffer：
// jpeg 重编码成 png 体积会放大约 10 倍（实测 211KB→2MB），经代理上传多花数秒。
// 带 EXIF 旋转的图不透传——供应商普遍忽略 EXIF，横竖会错。
// 透传后若被供应商以「Invalid image」拒收，由调用方（worker）回退重编码重试。
export async function normalizeReferenceBuffer(buf) {
  const meta = await sharp(buf, { failOn: 'none' }).metadata().catch(() => null);
  if (!meta?.width || !meta?.height) return null;
  // EXIF orientation 5-8 会让解码后的宽高互换，判定前要按实际显示方向取尺寸。
  const swapped = Number(meta.orientation) >= 5;
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;
  const ratio = Math.max(width, height) / Math.min(width, height);
  const needsResize = Math.max(width, height) > REF_MAX_EDGE || Math.min(width, height) < REF_MIN_EDGE;
  const needsCrop = ratio > REF_MAX_RATIO;
  const hasRotation = Number(meta.orientation) > 1;
  if (!needsResize && !needsCrop && !hasRotation && REF_FORMATS.has(meta.format) && buf.length <= REF_MAX_BYTES) {
    return buf;
  }

  let scale = 1;
  if (Math.max(width, height) > REF_MAX_EDGE) scale = REF_MAX_EDGE / Math.max(width, height);
  else if (Math.min(width, height) < REF_MIN_EDGE) scale = REF_MIN_EDGE / Math.min(width, height);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));

  // sharp 的 extract 作用在 resize 之后的图上，所以缩放与裁切分两步做，避免顺序歧义。
  let stage = await sharp(buf, { failOn: 'none' }).rotate().toBuffer();
  let stageWidth = width;
  let stageHeight = height;
  if (scale !== 1) {
    stage = await sharp(stage).resize(scaledWidth, scaledHeight, { fit: 'fill' }).png().toBuffer();
    stageWidth = scaledWidth;
    stageHeight = scaledHeight;
  }

  let image = sharp(stage);
  if (Math.max(stageWidth, stageHeight) / Math.min(stageWidth, stageHeight) > REF_MAX_RATIO) {
    // 居中裁到 2:1：横向过长裁宽度，纵向过长裁高度，画面保持饱满，不引入原图之外的内容。
    if (stageWidth >= stageHeight) {
      const targetWidth = Math.max(REF_MIN_EDGE, Math.round(stageHeight * REF_MAX_RATIO));
      image = image.extract({ left: Math.round((stageWidth - targetWidth) / 2), top: 0, width: targetWidth, height: stageHeight });
    } else {
      const targetHeight = Math.max(REF_MIN_EDGE, Math.round(stageWidth * REF_MAX_RATIO));
      image = image.extract({ left: 0, top: Math.round((stageHeight - targetHeight) / 2), width: stageWidth, height: targetHeight });
    }
  }

  const output = await image.png().toBuffer();
  // PNG 对超大图可能超 10MB：兜底压回 jpeg。
  if (output.length > REF_MAX_BYTES) {
    return sharp(output).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
  }
  return output;
}
