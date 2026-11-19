// syncTiDB.js — 供应商/用户数据与 TiDB Cloud（PostgreSQL 兼容集群）的双向同步数据函数。
//
// 仅 SQLite 后端使用。store.sqlite.js 在供应商/用户变更后调用 scheduleSyncProvidersUsers；
// index.js 在启动时用 fetchCloudProvidersUsers + merge + importSyncRows 拉取收敛。
// TIDB_PG_URL 未配置时静默跳过（离线无云）。幂等 upsert (kind,id) 主键。
// 说明：TiDB Cloud 管理 API（TIDB_API_* 密钥）只能管理集群、不能执行 SQL，
// 写数据必须用集群的 PG 连接串（TIDB_PG_URL）直连——见 README「TiDB 云端同步」一节。
import './loadEnv.js';
import pg from 'pg';

const TIDB_PG_URL = process.env.TIDB_PG_URL;
const TABLE = 'slenk_cloud_sync';

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

let syncing = false;
let queued = false;

// 全量镜像同步：providers + users → TiDB。返回统计或 { ok:false }。
export async function pushProvidersUsers(providers, users) {
  if (!TIDB_PG_URL) return { ok: false, skipped: true, reason: 'TIDB_PG_URL not set' };
  if (syncing) { queued = true; return { ok: false, queued: true }; }
  syncing = true;
  try {
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
    if (queued) { queued = false; setTimeout(() => void pushProvidersUsers(providers, users), 1000); }
  }
}

// 变更后调度（防抖）：loadRows() 取当前行，连续多次变更合并为一次同步。
let timer = null;
export function scheduleSyncProvidersUsers(delay = 1500, loadRows) {
  if (!TIDB_PG_URL || typeof loadRows !== 'function') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      const { providers, users } = await loadRows();
      await pushProvidersUsers(providers, users);
    } catch (e) {
      console.error('[tidb-sync] 调度同步失败：', e.message);
    }
  }, delay);
}

// 从 TiDB 读取云端 providers/users 行（不做任何本地读写）。
export async function fetchCloudProvidersUsers() {
  if (!TIDB_PG_URL) return { ok: false, skipped: true, reason: 'TIDB_PG_URL not set' };
  const client = new pg.Client({ connectionString: TIDB_PG_URL, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    await ensureTable(client);
    const { rows } = await client.query(`SELECT kind, data FROM ${TABLE} WHERE kind IN ('provider', 'user')`);
    return {
      ok: true,
      providers: rows.filter(r => r.kind === 'provider').map(r => r.data),
      users: rows.filter(r => r.kind === 'user').map(r => r.data)
    };
  } catch (e) {
    console.error('[tidb-sync] fetch failed:', e.message);
    return { ok: false, error: e.message };
  } finally {
    await client.end().catch(() => {});
  }
}
