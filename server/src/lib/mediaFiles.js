// 媒体字节的唯一落盘入口。数据库只保存元数据，文件路径由 id 推导。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { paths } from '../paths.js';

export function mediaRoot() {
  return process.env.MEDIA_DIR || paths.mediaDir;
}

export function mediaPath(id) {
  return path.join(mediaRoot(), id);
}

// 先写临时文件再 rename，避免并发读取看到半截文件。
export function writeMediaFile(id, data) {
  fs.mkdirSync(mediaRoot(), { recursive: true });
  const target = mediaPath(id);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    return data.length;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function readMediaFile(id) {
  try {
    return fs.readFileSync(mediaPath(id));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

export function removeMediaFile(id) {
  try {
    fs.unlinkSync(mediaPath(id));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export function removeMediaFiles(ids = []) {
  for (const id of ids) {
    try { removeMediaFile(id); }
    catch (err) { console.warn(`[media] 删除文件失败 ${id}:`, err.message); }
  }
}
