// SQLite 连接与事务辅助。node:sqlite 是同步 API，store.sqlite.js 用 async 外壳包住，
// 保持与 MySQL 适配器一致的异步契约。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from '../paths.js';

let connection = null;

export function resolveSqlitePath() {
  // paths.sqlitePath 会把相对 SQLITE_PATH 解析到仓库根（与设置页展示一致），
  // 绝对路径或未设置时返回原值/默认值，避免相对路径下展示与实际打开位置分叉。
  return paths.sqlitePath;
}

export function openDb() {
  if (connection) return connection;
  const file = resolveSqlitePath();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  connection = db;
  return db;
}

export function closeDb() {
  if (!connection) return;
  try { connection.close(); } finally { connection = null; }
}

const BUSY_RE = /SQLITE_BUSY|database is locked/i;
const busyText = err => `${err?.code || ''} ${err?.message || ''}`;

// 严重争用时重试一次（250ms 退避）；仍忙则转成 STORAGE_BUSY，由 HTTP 层映射 503。
export function withRetry(fn) {
  try {
    return fn();
  } catch (err) {
    if (!BUSY_RE.test(busyText(err))) throw err;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    try {
      return fn();
    } catch (again) {
      if (!BUSY_RE.test(busyText(again))) throw again;
      const busy = new Error('storage busy');
      busy.code = 'STORAGE_BUSY';
      throw busy;
    }
  }
}

export function transaction(fn) {
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function toJson(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
