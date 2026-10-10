import sqlite3 from 'sqlite3';
import Database from 'sqlite';

const db = Database.open({ filename: process.env.DB_PATH || './data/app.sqlite' });
const dbPath = process.env.DB_PATH || './data/app.sqlite';
const fs = await import('node:fs');
const path = await import('node:path');
const base = path.dirname(dbPath);
fs.mkdirSync(base, { recursive: true });
await db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    plan TEXT DEFAULT 'trial',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    payload TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`);
export const dbClient = db;
