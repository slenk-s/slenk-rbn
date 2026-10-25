import fs from 'node:fs';
import path from 'node:path';
import { query } from './db.js';
import { paths } from './paths.js';

const notesImagesDir = path.join(paths.dataDir, 'notes-images');

// 解析笔记后用户可能还没点保存，新缓存文件给 24h 宽限期，期间绝不删除。
const GRACE_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
// setInterval 上限是 32 位有符号毫秒（约 24.8 天），30 天会溢出被钳成 1ms，改为每天检查一次是否到期。
const CHECK_MS = 24 * 60 * 60 * 1000;

const CACHE_FILE_RE = /^[0-9a-f]{32}\.(?:jpe?g|png|webp|gif|avif|heic|heif)$/i;
const REF_RE = /\/notes-images\/([A-Za-z0-9._-]+)/g;

// 引用来源：已存笔记的 images 与任务 payload（任务结果页/参考图可能还在用缓存图）。
async function collectReferencedFilenames() {
  const refs = new Set();
  const [notes, tasks] = await Promise.all([
    query('select images from slenk_notes_notes'),
    query('select payload from slenk_notes_tasks')
  ]);
  for (const row of [...notes.rows, ...tasks.rows]) {
    const text = JSON.stringify(row);
    for (const m of text.matchAll(REF_RE)) refs.add(m[1]);
  }
  return refs;
}

export async function cleanOrphanedNotesImages({ dryRun = false, now = Date.now(), dir = notesImagesDir } = {}) {
  const result = { scanned: 0, removed: 0, kept: 0, removedNames: [] };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  const refs = await collectReferencedFilenames();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const isTmp = name.includes('.tmp-');
    // 命名不符合缓存规则的文件一律不动，避免误删人工放进目录的东西。
    if (!isTmp && !CACHE_FILE_RE.test(name)) continue;
    result.scanned++;
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < GRACE_MS || (!isTmp && refs.has(name))) {
      result.kept++;
      continue;
    }
    if (dryRun) {
      result.removed++;
      result.removedNames.push(name);
      continue;
    }
    try {
      fs.unlinkSync(filePath);
      result.removed++;
      result.removedNames.push(name);
    } catch {
      // 文件被占用等场景跳过，下轮再清。
      result.kept++;
    }
  }
  return result;
}

export function startNotesImagesJanitor() {
  let lastRun = 0;
  const run = () =>
    cleanOrphanedNotesImages().then(
      r => {
        lastRun = Date.now();
        if (r.removed) console.log(`[cache] notes-images 清理完成：删除 ${r.removed} 个孤儿文件，保留 ${r.kept} 个`);
      },
      err => console.warn('[cache] notes-images 清理失败:', err.message)
    );
  run();
  const timer = setInterval(() => {
    if (Date.now() - lastRun >= INTERVAL_MS) run();
  }, CHECK_MS);
  timer.unref();
  return timer;
}
