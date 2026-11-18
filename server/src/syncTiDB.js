// syncTiDB.js — 把本地存储的供应商/用户数据镜像到 TiDB Cloud（PostgreSQL 兼容集群）。
//
// 仅在 SLENK_DATA_BACKEND=local 时由 store.local.js 调用（供应商/用户变更后触发）。
// 数据源：storage/local/providers.json + users.json（本地后端真相）；
// 目标：TIDB_PG_URL（postgres 库，slenk_cloud_sync 表）。幂等 upsert（kind,id）主键，
// 本地删除的行在 TiDB 同步删除，保持镜像一致。TIDB_PG_URL 未配置时静默跳过（离线无云）。
//
// 说明：TiDB Cloud 管理 API（TIDB_API_* 密钥）只能管理集群、不能执行 SQL，
// 写数据必须用集群的 PG 连接串（TIDB_PG_URL）直连——见 README「TiDB 云端同步」一节。

import './loadEnv.js';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { paths } from './paths.js';

const TIDB_PG_URL = process.env.TIDB_PG_URL;

const TABLE = 'slenk_cloud_sync';

function loadLocalTable(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.dataDir, 'local', `${name}.json`), 'utf8'));
  } catch {
    return [];
  }
}

let syncing = false;
let queued = false;

async function ensureTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       kind VARCHAR(16) NOT NULL,
       id VARCHAR(64) NOT NULL,
       data JSONB NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (kind, id)
     )`
  );
}

async function mirrorKind(client, kind, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO ${TABLE} (kind, id, data, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [kind, row.id, JSON.stringify(row)]
    );
  }
  if (rows.length) {
    await client.query(
      `DELETE FROM ${TABLE} WHERE kind = $1 AND NOT (id = ANY($2))`,
      [kind, rows.map(r => r.id)]
    );
  } else {
    await client.query(`DELETE FROM ${TABLE} WHERE kind = $1`, [kind]);
  }
}

// 全量镜像同步：providers + users → TiDB。返回统计或 { ok:false }。
export async function syncProvidersUsersToTiDB() {
  if (!TIDB_PG_URL) return { ok: false, skipped: true, reason: 'TIDB_PG_URL not set' };
  if (syncing) { queued = true; return { ok: false, queued: true }; }
  syncing = true;
  try {
    const providers = loadLocalTable('providers');
    const users = loadLocalTable('users');
    const client = new pg.Client({ connectionString: TIDB_PG_URL, connectionTimeoutMillis: 15000 });
    await client.connect();
    await ensureTable(client);
    await mirrorKind(client, 'provider', providers);
    await mirrorKind(client, 'user', users);
    await client.end();
    console.log(`[tidb-sync] 同步完成：provider ${providers.length} 条，user ${users.length} 条`);
    return { ok: true, providers: providers.length, users: users.length };
  } catch (e) {
    console.error('[tidb-sync] failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    syncing = false;
    if (queued) { queued = false; setTimeout(() => void syncProvidersUsersToTiDB(), 1000); }
  }
}

// 变更后调度（防抖）：连续多次变更合并为一次同步；TIDB_PG_URL 未配置则空转。
let timer = null;
export function scheduleSyncProvidersUsers(delay = 1500) {
  if (!TIDB_PG_URL) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void syncProvidersUsersToTiDB(); }, delay);
}
