// store.sqlite.js — SQLite 后端（默认）。实现与 store.mysql.js 相同的函数契约。
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, withRetry, transaction, parseJson, toJson } from './lib/sqlite.js';
import { removeMediaFiles } from './lib/mediaFiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(__dirname, '../scripts/schema.sqlite.sql');

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function all(sql, ...params) { return withRetry(() => openDb().prepare(sql).all(...params)); }
function get(sql, ...params) { return withRetry(() => openDb().prepare(sql).get(...params)); }
function run(sql, ...params) { return withRetry(() => openDb().prepare(sql).run(...params)); }

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at
  };
}

let initialized = false;

export async function initStore() {
  if (initialized) return;
  openDb().exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  await ensureAdmin();
  initialized = true;
}

export async function closeStore() {
  closeDb();
}

let adminEnsured = false;
export async function ensureAdmin() {
  if (adminEnsured) return;
  const existing = get('select id from slenk_notes_users where username = ?', 'admin');
  if (!existing) {
    run(
      `insert into slenk_notes_users (id, username, password_hash, is_admin)
       values (?, ?, ?, 1) on conflict (username) do nothing`,
      'admin', 'admin', bcrypt.hashSync('123456', 10)
    );
  }
  const row = get('select id from slenk_notes_users where username = ?', 'admin');
  run('insert into slenk_notes_user_settings (user_id) values (?) on conflict (user_id) do nothing', row.id);
  adminEnsured = true;
}

export async function findUserByUsername(username) {
  const row = get('select * from slenk_notes_users where username = ?', username);
  return row ? mapUser(row) : null;
}

export async function findUserById(id) {
  const row = get('select * from slenk_notes_users where id = ?', id);
  return row ? mapUser(row) : null;
}

export async function createUser({ username, passwordHash, isAdmin = false }) {
  const id = uid('user');
  transaction(db => {
    db.prepare('insert into slenk_notes_users (id, username, password_hash, is_admin) values (?, ?, ?, ?)')
      .run(id, String(username).trim(), String(passwordHash), isAdmin ? 1 : 0);
    db.prepare('insert into slenk_notes_user_settings (user_id) values (?) on conflict (user_id) do nothing').run(id);
  });
  return findUserById(id);
}

export async function listUsers() {
  return all(
    `select u.id, u.username, u.is_admin, u.created_at,
       (select count(*) from slenk_notes_notes n where n.user_id = u.id) as note_count,
       (select count(*) from slenk_notes_tasks t where t.user_id = u.id) as task_count
     from slenk_notes_users u order by u.created_at`
  ).map(r => ({
    id: r.id,
    username: r.username,
    isAdmin: Boolean(r.is_admin),
    createdAt: r.created_at,
    noteCount: Number(r.note_count),
    taskCount: Number(r.task_count)
  }));
}

export async function updateUser(id, patch = {}) {
  const fields = [];
  const values = [];
  if ('passwordHash' in patch) { fields.push('password_hash = ?'); values.push(patch.passwordHash); }
  if ('isAdmin' in patch) { fields.push('is_admin = ?'); values.push(patch.isAdmin ? 1 : 0); }
  if (fields.length) run(`update slenk_notes_users set ${fields.join(', ')} where id = ?`, ...values, id);
  return findUserById(id);
}

export async function deleteUser(id) {
  const mediaIds = all('select id from slenk_notes_media where user_id = ?', id).map(r => r.id);
  const info = run('delete from slenk_notes_users where id = ?', id);
  removeMediaFiles(mediaIds);
  return info.changes > 0;
}

export async function getActiveProviderIds(userId) {
  const row = get(
    `select active_provider_id, active_text_provider_id, active_image_provider_id
     from slenk_notes_user_settings where user_id = ?`,
    userId
  ) || {};
  return {
    activeProviderId: row.active_provider_id ?? null,
    activeTextProviderId: row.active_text_provider_id ?? null,
    activeImageProviderId: row.active_image_provider_id ?? null
  };
}

export async function setActiveProvider(providerId, mode, userId) {
  const column = mode === 'text' ? 'active_text_provider_id'
    : mode === 'image' ? 'active_image_provider_id'
    : 'active_provider_id';
  run(
    `insert into slenk_notes_user_settings (user_id, ${column}) values (?, ?)
     on conflict (user_id) do update set ${column} = excluded.${column}`,
    userId, providerId
  );
}
