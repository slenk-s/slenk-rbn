import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  resolveImageQuality,
  isInvalidImageRejection,
  normalizeReferenceBuffer
} from '../src/lib/imageRequestOptions.js';

// ---- resolveImageQuality ----

test('未指定时默认 medium（出图速度优先，供应商默认 high 慢约 1/4）', () => {
  assert.equal(resolveImageQuality({}), 'medium');
  assert.equal(resolveImageQuality(null), 'medium');
});

test('payload 显式 quality 生效，大小写不敏感', () => {
  assert.equal(resolveImageQuality({ quality: 'high' }), 'high');
  assert.equal(resolveImageQuality({ quality: 'LOW' }), 'low');
});

test('非法 quality 回退 medium', () => {
  assert.equal(resolveImageQuality({ quality: 'ultra' }), 'medium');
  assert.equal(resolveImageQuality({ quality: 123 }), 'medium');
});

test('环境变量可改默认，payload 仍优先', () => {
  assert.equal(resolveImageQuality({}, { SLENK_IMAGE_QUALITY: 'low' }), 'low');
  assert.equal(resolveImageQuality({ quality: 'high' }, { SLENK_IMAGE_QUALITY: 'low' }), 'high');
});

// ---- isInvalidImageRejection ----

test('400 + Invalid image file or mode 判定为参考图被拒', () => {
  assert.equal(isInvalidImageRejection(400, { error: { message: 'Invalid image file or mode' } }), true);
  assert.equal(isInvalidImageRejection(422, { error: 'Unsupported image' }), true);
});

test('其他错误不误判', () => {
  assert.equal(isInvalidImageRejection(400, { error: { message: 'Invalid API key' } }), false);
  assert.equal(isInvalidImageRejection(500, { error: { message: 'Invalid image file or mode' } }), false);
  assert.equal(isInvalidImageRejection(200, {}), false);
  assert.equal(isInvalidImageRejection(400, {}), false);
});

// ---- normalizeReferenceBuffer ----

async function makeJpeg(width, height, { orientation } = {}) {
  let img = sharp({ create: { width, height, channels: 3, background: '#336699' } }).jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}

test('合规且无 EXIF 旋转的 JPEG 原样透传，不再重编码成放大约 10 倍的 PNG', async () => {
  const jpeg = await makeJpeg(800, 600);
  const out = await normalizeReferenceBuffer(jpeg);
  assert.equal(out, jpeg, '应返回同一个 buffer（零拷贝透传）');
});

test('合规 PNG 同样透传', async () => {
  const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } }).png().toBuffer();
  const out = await normalizeReferenceBuffer(png);
  assert.equal(out, png);
});

test('带 EXIF 旋转的 JPEG 仍重编码为 PNG（不透传，避免供应商忽略 EXIF 导致图是横的）', async () => {
  const rotated = await makeJpeg(800, 600, { orientation: 6 });
  const out = await normalizeReferenceBuffer(rotated);
  assert.notEqual(out, rotated);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'png');
});

test('宽高比超过 2:1 的图仍被裁到 2:1 以内', async () => {
  const tall = await makeJpeg(256, 800);
  const out = await normalizeReferenceBuffer(tall);
  const meta = await sharp(out).metadata();
  assert.ok(meta.width / meta.height >= 0.5 && meta.height / meta.width <= 2);
});

test('坏图返回 null', async () => {
  assert.equal(await normalizeReferenceBuffer(Buffer.from('not an image')), null);
});
