// migrate-providers-to-local.mjs — 把原 MySQL 库的供应商列表迁入本地 JSON 数据层，
// 并触发 TiDB 镜像同步（syncTiDB）。幂等：按 id 合并，重复运行不产生重复行。
//
// 背景：数据层默认已切到本地 JSON（SLENK_DATA_BACKEND=local），原生产供应商在 MySQL
// slenk_notes_providers 表；本脚本把那些供应商读出来写进 storage/local/providers.json，
// 再由 store.local 的变更钩子（或此处直接调用）镜像到 TiDB slenk_cloud_sync。
//
// 用法：node scripts/migrate-providers-to-local.mjs
//   - 读库走 db.js（尊重 storage/db.json / DATABASE_URL，可用 DB_CONFIG_PATH 重定向）
//   - 本地文件若不存在会新建；只读 MySQL 的供应商，不触碰本地已有的其他行。

import '../src/loadEnv.js';
import fs from 'node:fs';
import path from 'node:path';
import { query, closePool } from '../src/db.js';
import { paths } from '../src/paths.js';
import { syncProvidersUsersToTiDB } from '../src/syncTiDB.js';

const PROVIDER_COLUMNS =
  'id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, image_api, notes, is_active, created_at, updated_at';

const localDir = path.join(paths.dataDir, 'local');
const localFile = path.join(localDir, 'providers.json');

// MySQL DATETIME（Date 对象，池 timezone=Z）→ 本地 'YYYY-MM-DD HH:MM:SS.mmm' UTC 字符串。
function toLocalTs(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().replace('T', ' ').replace('Z', '');
  if (v == null) return '';
  return String(v).replace('T', ' ').replace('Z', '').slice(0, 23);
}

function loadLocal(name) {
  try { return JSON.parse(fs.readFileSync(path.join(localDir, `${name}.json`), 'utf8')); }
  catch { return []; }
}
function saveLocal(name, rows) {
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, `${name}.json`), JSON.stringify(rows, null, 2) + '\n', 'utf8');
}

let imported = 0;
let updated = 0;
try {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers order by created_at, id`);
  console.log(`MySQL 供应商：${rows.length} 条`);

  const existing = loadLocal('providers');
  const byId = new Map(existing.map(p => [p.id, p]));

  for (const r of rows) {
    const row = {
      id: String(r.id),
      name: String(r.name),
      provider_type: String(r.provider_type || 'openai-compatible'),
      app_type: String(r.app_type || 'openai'),
      base_url: String(r.base_url || '').replace(/\/$/, ''),
      api_key: String(r.api_key || ''),
      mode: String(r.mode || 'image'),
      text_model: String(r.text_model || ''),
      image_model: String(r.image_model || ''),
      image_api: r.image_api === 'form' ? 'form' : 'json',
      notes: String(r.notes || ''),
      is_active: Boolean(r.is_active),
      created_at: toLocalTs(r.created_at),
      updated_at: toLocalTs(r.updated_at)
    };
    if (byId.has(row.id)) { byId.set(row.id, row); updated++; }
    else { byId.set(row.id, row); imported++; }
  }

  const merged = [...byId.values()];
  saveLocal('providers', merged);
  console.log(`本地 providers.json：新增 ${imported} 条、更新 ${updated} 条，共 ${merged.length} 条`);

  // 直接触发一次 TiDB 镜像（变更钩子通常也会调度，这里显式做一次确保落库）。
  const sync = await syncProvidersUsersToTiDB();
  console.log('TiDB 同步：', JSON.stringify(sync));
} finally {
  await closePool().catch(() => {});
}
