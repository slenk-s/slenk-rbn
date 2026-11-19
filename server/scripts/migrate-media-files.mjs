// 一次性迁移：slenk_notes_media.data (LONGBLOB) → <mediaDir>/<id> 文件。
// 用法：node scripts/migrate-media-files.mjs [--drop-column]
//   --drop-column：迁移成功后再删除 data 列。既有库切换 store.mysql 前必跑。
import { query, closePool } from '../src/db.js';
import { writeMediaFile } from '../src/lib/mediaFiles.js';

const dropColumn = process.argv.includes('--drop-column');

try {
  const { rows: cols } = await query(
    `select column_name from information_schema.columns
     where table_schema = database() and table_name = 'slenk_notes_media' and column_name = 'data'`
  );
  if (!cols.length) {
    console.log('media.data 列不存在，视为已迁移。');
    process.exit(0);
  }
  const { rows } = await query('select id, data from slenk_notes_media');
  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    try {
      writeMediaFile(row.id, Buffer.from(row.data));
      ok++;
    } catch (e) {
      fail++;
      console.error(`写入失败 ${row.id}:`, e.message);
    }
  }
  console.log(`迁移完成：${ok} 成功，${fail} 失败。`);
  if (dropColumn) {
    await query('alter table slenk_notes_media drop column data');
    console.log('已删除 data 列。');
  } else {
    console.log('未删除 data 列；确认无误后加 --drop-column 删除。');
  }
  process.exitCode = fail ? 1 : 0;
} finally {
  await closePool();
}
