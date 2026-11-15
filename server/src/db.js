import './loadEnv.js';
import mysql from 'mysql2/promise';

const isTestProcess = process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);
const connectionString = isTestProcess
  ? (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required (see .env)');
}

if (isTestProcess && !process.env.TEST_DATABASE_URL) {
  console.warn('⚠️ tests are running against DATABASE_URL (shared with the app); set TEST_DATABASE_URL to use a throwaway database');
}

// MySQL DATETIME 无时区。约定：库内一律存 UTC，连接时区固定 'Z'，SQL 里时间用
// UTC_TIMESTAMP(3)（而不是 now()——它返回服务器本地时区，本机是 +8，会造成 8 小时偏移）。
// 读取时 mysql2 按 timezone='Z' 把 DATETIME 解释为 UTC 生成 Date，与写入一致。
export const pool = mysql.createPool({
  uri: connectionString,
  waitForConnections: true,
  connectionLimit: 5,
  maxIdle: 5,
  idleTimeout: 30000,
  connectTimeout: 15000,
  timezone: 'Z',            // 读写一律按 UTC
  decimalNumbers: true,     // DECIMAL / BIGINT（含 COUNT）以 JS number 返回
  supportBigNumbers: true,
  bigNumberStrings: false,
  charset: 'utf8mb4'
});

pool.on('error', err => console.error('[db] idle client error', err.message));

// 归一化为 pg 风格 { rows, rowCount, ... }，上层 query() 调用无需感知驱动差异。
// SELECT → rows 是数据行；INSERT/UPDATE/DELETE → rows 是 ResultSetHeader，改由 rowCount 表达。
export async function query(text, params = []) {
  const [rows, fields] = await pool.query(text, params);
  if (Array.isArray(rows)) {
    return { rows, rowCount: rows.length, fields };
  }
  return { rows: [], rowCount: rows.affectedRows ?? 0, insertId: rows.insertId ?? 0, fields };
}

// 事务：fn 收到 mysql2 connection（其 query() 返回 [rows, fields] mysql2 风格，
// 供脚本迁移等调用；应用层业务目前不走事务）。
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  await pool.end();
}
