import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaId, mediaExtension } from '../src/lib/mediaInput.js';

test('parseMediaId 识别相对路径的媒体地址', () => {
  assert.equal(parseMediaId('/api/media/3abb47a6-502b-4fc1-9a5c-2ce98f1fe623'), '3abb47a6-502b-4fc1-9a5c-2ce98f1fe623');
});

test('parseMediaId 识别绝对 http(s) 地址并忽略查询串', () => {
  assert.equal(parseMediaId('https://236963.xyz/api/media/abc-123?download=1'), 'abc-123');
  assert.equal(parseMediaId('http://localhost:3001/api/media/abc-123'), 'abc-123');
});

test('parseMediaId 对非媒体地址返回 null', () => {
  assert.equal(parseMediaId('/uploads/foo.jpg'), null);
  assert.equal(parseMediaId('/notes-images/hash.jpg'), null);
  assert.equal(parseMediaId('https://sns-img.xhscdn.com/a.jpg'), null);
  assert.equal(parseMediaId(''), null);
  assert.equal(parseMediaId(null), null);
});

test('mediaExtension 优先用 MIME，其次文件名', () => {
  assert.equal(mediaExtension('image/jpeg', 'x.bin'), '.jpg');
  assert.equal(mediaExtension('image/png; charset=binary', ''), '.png');
  assert.equal(mediaExtension('video/mp4', ''), '.mp4');
  assert.equal(mediaExtension('', 'photo.webp'), '.webp');
  assert.equal(mediaExtension(null, null), '');
});
