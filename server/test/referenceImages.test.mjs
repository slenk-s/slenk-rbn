import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectReferenceImages,
  MAX_PER_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGES
} from '../src/lib/referenceImages.js';

test('按参考图一一对应生成时不截断参考图', () => {
  const urls = ['a.png', 'b.png', 'c.png', 'd.png'];
  assert.deepEqual(collectReferenceImages({ imageUrls: urls }), urls);
});

test('一一对应模式只在前端上传上限处截断', () => {
  const urls = Array.from({ length: MAX_PER_REFERENCE_IMAGES + 3 }, (_, i) => `img${i}`);
  assert.deepEqual(collectReferenceImages({ imageUrls: urls }), urls.slice(0, MAX_PER_REFERENCE_IMAGES));
});

test('合成一张时按较小的上限收紧', () => {
  const urls = ['a.png', 'b.png', 'c.png', 'd.png'];
  assert.deepEqual(collectReferenceImages({ imageUrls: urls, perReference: false }), urls.slice(0, MAX_REFERENCE_IMAGES));
});

test('截断时打日志，不静默丢图', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    collectReferenceImages({ imageUrls: ['a.png', 'b.png', 'c.png'], perReference: false });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /只取前 \d+ 张/);
    collectReferenceImages({ imageUrls: ['a.png', 'b.png'] });
    assert.equal(warnings.length, 1, '未截断时不打日志');
  } finally {
    console.warn = originalWarn;
  }
});

test('单张 image 字段与空值都能处理', () => {
  assert.deepEqual(collectReferenceImages({ image: 'one.png' }), ['one.png']);
  assert.deepEqual(collectReferenceImages({ imageUrls: ['ok.png', '', null] }), ['ok.png']);
  assert.deepEqual(collectReferenceImages({}), []);
  assert.deepEqual(collectReferenceImages(null), []);
});
