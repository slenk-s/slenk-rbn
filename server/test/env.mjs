// 每个测试文件的第一条 import：创建独立临时目录并设置后端环境变量。
// ESM 按 import 顺序求值，因此本文件必须先于 store/paths 被 import。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const backend = process.env.TEST_DATA_BACKEND || 'sqlite';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slenk-test-'));

process.env.SLENK_DATA_BACKEND = backend;
process.env.TEST_DATA_BACKEND = backend;
process.env.STORAGE_PATH = dir;
process.env.SQLITE_PATH = path.join(dir, 'test.sqlite');
process.env.MEDIA_DIR = path.join(dir, 'media');

export const testDir = dir;

process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
