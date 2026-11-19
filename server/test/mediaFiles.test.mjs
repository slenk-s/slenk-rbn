import './env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mediaRoot, mediaPath, writeMediaFile, readMediaFile, removeMediaFile, removeMediaFiles } from '../src/lib/mediaFiles.js';

test('writeMediaFile 落盘后 readMediaFile 读回相同字节，且不留临时文件', () => {
  const id = 'm_' + Math.random().toString(36).slice(2);
  const data = Buffer.from('hello-media');
  assert.equal(writeMediaFile(id, data), data.length);
  assert.deepEqual(readMediaFile(id), data);
  assert.ok(fs.existsSync(mediaPath(id)));
  assert.equal(fs.readdirSync(mediaRoot()).filter(n => n.endsWith('.tmp')).length, 0);
  removeMediaFile(id);
});

test('readMediaFile 对不存在的 id 返回 null', () => {
  assert.equal(readMediaFile('missing_zz'), null);
});

test('removeMediaFile 对不存在的 id 幂等', () => {
  assert.doesNotThrow(() => removeMediaFile('missing_zz'));
});

test('removeMediaFiles 删除多个文件并忽略缺失项', () => {
  const ids = ['a_' + Math.random().toString(36).slice(2), 'b_' + Math.random().toString(36).slice(2)];
  for (const id of ids) writeMediaFile(id, Buffer.from(id));
  removeMediaFiles([...ids, 'missing_zz']);
  for (const id of ids) assert.equal(fs.existsSync(mediaPath(id)), false);
});
