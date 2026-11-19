// 媒体文件巡检：对比数据库中的媒体 id 与 <mediaDir> 下的文件。
// 默认只读；--apply 时删除「数据库不存在但文件存在」的孤儿文件。忽略 *.tmp。
// 用法：node scripts/media-janitor.mjs [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMediaIds } from '../src/store.js';
import { mediaRoot } from '../src/lib/mediaFiles.js';

export async function runJanitor({ list = listMediaIds, root = mediaRoot, apply = false, log = console } = {}) {
  const dbIds = new Set(await list());
  const dir = root();
  const orphanFiles = [];
  const missingFiles = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.tmp')) continue;
      if (!dbIds.has(f)) orphanFiles.push(f);
    }
  }
  for (const id of dbIds) {
    if (!fs.existsSync(path.join(dir, id))) missingFiles.push(id);
  }
  let removed = 0;
  if (apply) {
    for (const f of orphanFiles) {
      try { fs.unlinkSync(path.join(dir, f)); removed++; }
      catch (e) { log.warn(`[media-janitor] 删除失败 ${f}:`, e.message); }
    }
  }
  return { orphanFiles, missingFiles, removed, dbCount: dbIds.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes('--apply');
  const result = await runJanitor({ apply });
  console.log(`媒体巡检：数据库 ${result.dbCount} 条；`);
  console.log(`  孤儿文件 ${result.orphanFiles.length} 个${apply ? `（已删除 ${result.removed}）` : '（--apply 删除）'}`);
  console.log(`  数据库有但文件缺失 ${result.missingFiles.length} 个`);
}
