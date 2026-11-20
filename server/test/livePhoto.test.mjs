import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import ffmpegStatic from 'ffmpeg-static';
import { createLivePhoto } from '../src/lib/livePhoto.js';

// 用 ffmpeg 生成最小测试视频（1 秒纯色 H.264），返回路径；测试结束清理。
function makeTestVideo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'test.mp4');
  const res = spawnSync(ffmpegStatic, [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, '测试视频生成失败：' + (res.stderr || '').slice(-200));
  return { dir, video: out };
}

// 用 sharp 生成测试封面图。
async function makeTestCover(dir) {
  const cover = path.join(dir, 'cover.png');
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 80, b: 80 } } })
    .png()
    .toFile(cover);
  return cover;
}

// 用 tar（Windows 自带 bsdtar 支持 zip）解包 LIVP，返回目录。
function unzipLivp(t, livpPath) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'livp-unzip-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  const res = spawnSync('tar', ['-xf', livpPath, '-C', dest], { encoding: 'utf8' });
  assert.equal(res.status, 0, 'LIVP 解包失败：' + (res.stderr || '').slice(-200));
  return dest;
}

test('createLivePhoto 生成结构完整的 LIVP（含 HEIC 封面）', async (t) => {
  const { dir, video } = makeTestVideo(t);
  const cover = await makeTestCover(dir);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livp-out-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));

  const result = await createLivePhoto(video, cover, { taskId: 'task_a', index: 0, outDir });
  assert.equal(fs.existsSync(result.path), true, 'LIVP 文件应存在');
  assert.ok(result.size > 0, 'LIVP 应有内容');
  assert.equal(result.coverExt, '.HEIC', '默认应生成 HEIC 封面');

  // ZIP 魔数。
  const buf = fs.readFileSync(result.path);
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'LIVP 应为 ZIP 格式');

  // 解包验证结构。
  const extracted = unzipLivp(t, result.path);
  const files = fs.readdirSync(extracted).sort();
  assert.deepEqual(files, ['AssetManifest.json', 'IMG_0001.HEIC', 'quicktime.mov']);

  // AssetManifest 结构。
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'AssetManifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(Object.keys(manifest.assets).sort(), ['fullSizePhoto', 'video']);
  assert.equal(manifest.assets.fullSizePhoto.file, 'IMG_0001.HEIC');
  assert.equal(manifest.assets.fullSizePhoto.type, 'fullSizePhoto');
  assert.equal(manifest.assets.video.file, 'quicktime.mov');
  assert.equal(manifest.assets.video.type, 'video');

  // HEIC 能被 sharp 解码（验证标准 HEIC 有效）。
  const heic = fs.readFileSync(path.join(extracted, 'IMG_0001.HEIC'));
  assert.equal(heic.subarray(4, 12).toString('hex'), '6674797068656963', 'HEIC 文件签名应为 ftypheic');
  const meta = await sharp(heic).metadata();
  assert.equal(meta.format, 'heif');
  assert.equal(meta.width, 64);
  assert.equal(meta.height, 64);

  // MOV 是 QuickTime 容器。
  const mov = fs.readFileSync(path.join(extracted, 'quicktime.mov'));
  assert.equal(mov.subarray(4, 8).toString('latin1'), 'ftyp');
});

test('createLivePhoto 对缺失视频或封面抛错', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livp-err-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cover = await makeTestCover(dir);
  await assert.rejects(() => createLivePhoto(path.join(dir, 'missing.mp4'), cover, { outDir: dir }), /视频文件缺失/u);
  await assert.rejects(() => createLivePhoto(path.join(dir, 'missing.mp4'), path.join(dir, 'missing.png'), { outDir: dir }), /视频文件缺失/u);
});
