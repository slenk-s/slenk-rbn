import './loadEnv.js';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { paths } from './paths.js';

const isTestProcess = process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);
const CONFIG_CHECK_TTL_MS = 1000;

// 运行时配置文件：<dataDir>/db.json。存在且合法时覆盖 DATABASE_URL。
// DB_CONFIG_PATH 仅供测试重定向到临时文件。
function configFile() {
  return process.env.DB_CONFIG_PATH || path.resolve(paths.dataDir, 'db.json');
}

// 每次重建 pool 都必须带上这些选项（与历史行为一致）。
const POOL_OPTIONS = {
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
};

// ---- 纯函数（导出供单测） ----

export function parseDbConfigFromUrl(urlString) {
  const u = new URL(urlString);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || ''),
    database: u.pathname.replace(/^\//, '') || ''
  };
}

export function configsDiffer(a, b) {
  if (!a || !b) return true;
  return a.host !== b.host || a.port !== b.port || a.user !== b.user ||
    a.password !== b.password || a.database !== b.database;
}

// ---- 配置文件读（TTL + mtime + 内容哈希） ----

let fileCache = { checkedAt: 0, mtimeMs: 0, hash: '', content: null };
const hashOf = t => createHash('sha1').update(t).digest('hex');

function readDbFileConfig() {
  const now = Date.now();
  if (now - fileCache.checkedAt < CONFIG_CHECK_TTL_MS) return fileCache.content;
  fileCache.checkedAt = now;
  let stat, raw;
  try {
    stat = fs.statSync(configFile());
    raw = fs.readFileSync(configFile(), 'utf8');
  } catch {
    fileCache = { checkedAt: now, mtimeMs: 0, hash: '', content: null };
    return null;
  }
  const hash = hashOf(raw);
  if (stat.mtimeMs === fileCache.mtimeMs && hash === fileCache.hash) return fileCache.content;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.host || !parsed.user || !parsed.database) {
      fileCache = { checkedAt: now, mtimeMs: stat.mtimeMs, hash, content: null };
      return null;
    }
    const config = {
      host: String(parsed.host),
      port: Number(parsed.port) || 3306,
      user: String(parsed.user),
      password: String(parsed.password ?? ''),
      database: String(parsed.database)
    };
    fileCache = { checkedAt: now, mtimeMs: stat.mtimeMs, hash, content: config };
    return config;
  } catch (err) {
    console.warn('[db] malformed db.json, falling back to DATABASE_URL:', err.message);
    fileCache = { checkedAt: now, mtimeMs: stat.mtimeMs, hash, content: null };
    return null;
  }
}

// 有效配置：db.json 覆盖 env；测试进程恒用 env（绝不读 db.json）。
function resolveEffectiveConfig() {
  if (isTestProcess) {
    const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required (see .env)');
    return { config: parseDbConfigFromUrl(url), source: 'env' };
  }
  const file = readDbFileConfig();
  if (file) return { config: file, source: 'file' };
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env)');
  return { config: parseDbConfigFromUrl(url), source: 'env' };
}

// route 用：有效配置（含 password，供"留空保持"；序列化时绝不带 password）+ 来源。
export function getEffectiveDb() { return resolveEffectiveConfig(); }
export function getDbConfigPath() { return configFile(); }
export function invalidateDbConfigCache() {
  fileCache = { checkedAt: 0, mtimeMs: 0, hash: '', content: null };
}

// ---- 池工厂 + 校验换池 + 并发守卫 ----

export function buildPool(config, { connectTimeout } = {}) {
  const pool = mysql.createPool({
    ...POOL_OPTIONS,
    ...(connectTimeout ? { connectTimeout } : {}),
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database
  });
  pool.on('error', err => console.error('[db] idle client error', err.message));
  return pool;
}

async function buildValidatedPool(config) {
  const pool = buildPool(config);
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
  return pool;
}

let currentPool = null;
let currentConfig = null;
let building = null;

export function getPool() {
  const { config } = resolveEffectiveConfig();
  if (currentPool && !configsDiffer(config, currentConfig)) return Promise.resolve(currentPool);
  if (building) return building; // 并发调用共享同一次构建/换池
  building = (async () => {
    const next = await buildValidatedPool(config); // SELECT 1 通过才替换
    const old = currentPool;
    currentPool = next;
    currentConfig = config;
    if (old) old.end().catch(() => {});            // 后台排空；进行中查询自会完成
    return next;
  })().finally(() => { building = null; });
  return building;
}

// 归一化为 pg 风格 { rows, rowCount, ... }，上层 query() 调用无需感知驱动差异。
// SELECT → rows 是数据行；INSERT/UPDATE/DELETE → rows 是 ResultSetHeader，改由 rowCount 表达。
export async function query(text, params = []) {
  const pool = await getPool();
  const [rows, fields] = await pool.query(text, params);
  if (Array.isArray(rows)) {
    return { rows, rowCount: rows.length, fields };
  }
  return { rows: [], rowCount: rows.affectedRows ?? 0, insertId: rows.insertId ?? 0, fields };
}

// 事务：fn 收到 mysql2 connection（其 query() 返回 [rows, fields] mysql2 风格，
// 供脚本迁移等调用；应用层业务目前不走事务）。
export async function withTransaction(fn) {
  const pool = await getPool();
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
  const p = currentPool;
  currentPool = null;
  currentConfig = null;
  if (p) await p.end();
}

// 一次性连通性检查（/db/test 用）：不落盘，成功/失败都销毁临时池。
export async function testConnection(config, { connectTimeout = 5000 } = {}) {
  const pool = buildPool(config, { connectTimeout });
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  } finally {
    await pool.end().catch(() => {});
  }
}
