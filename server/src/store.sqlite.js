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

const PROVIDER_COLUMNS = `id, name, provider_type, app_type, base_url, api_key, mode,
  text_model, image_model, image_api, notes, is_active, created_at, updated_at`;

function mapProvider(row) {
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    appType: row.app_type,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    mode: row.mode,
    textModel: row.text_model,
    imageModel: row.image_model,
    imageApi: row.image_api,
    notes: row.notes,
    active: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function maskApiKey(apiKey) {
  if (!apiKey) return '';
  const s = String(apiKey);
  if (s.length <= 8) return '*'.repeat(Math.max(4, s.length));
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

function withMaskedKey(provider) {
  return provider ? { ...provider, apiKey: maskApiKey(provider.apiKey) } : null;
}

function providerValues(input = {}, id) {
  return {
    id: id || uid('prov'),
    name: String(input.name || 'Custom Provider').trim() || 'Custom Provider',
    providerType: String(input.providerType || 'openai-compatible').trim() || 'openai-compatible',
    appType: String(input.appType || 'openai').trim() || 'openai',
    baseUrl: String(input.baseUrl || '').trim().replace(/\/$/, ''),
    apiKey: String(input.apiKey || '').trim(),
    mode: String(input.mode || 'image').trim() || 'image',
    textModel: String(input.textModel || '').trim(),
    imageModel: String(input.imageModel || '').trim(),
    imageApi: input.imageApi === 'form' ? 'form' : 'json',
    notes: String(input.notes || ''),
    active: Boolean(input.active)
  };
}

export async function listProviders() {
  return all(`select ${PROVIDER_COLUMNS} from slenk_notes_providers order by created_at, id`)
    .map(r => withMaskedKey(mapProvider(r)));
}

export async function getProviderById(id) {
  const row = get(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = ?`, id);
  return row ? withMaskedKey(mapProvider(row)) : null;
}

export async function getProviderUnmaskedById(id) {
  const row = get(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = ?`, id);
  return row ? mapProvider(row) : null;
}

export async function addProvider(input) {
  const p = providerValues(input);
  run(
    `insert into slenk_notes_providers
       (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, image_api, notes, is_active)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode,
    p.textModel, p.imageModel, p.imageApi, p.notes, p.active ? 1 : 0
  );
  return getProviderById(p.id);
}

export async function updateProvider(id, input) {
  const existing = await getProviderUnmaskedById(id);
  if (!existing) return null;
  const p = providerValues({ ...existing, ...input, id }, id);
  if (!p.apiKey || p.apiKey === maskApiKey(existing.apiKey)) p.apiKey = existing.apiKey;
  run(
    `update slenk_notes_providers set name = ?, provider_type = ?, app_type = ?, base_url = ?,
       api_key = ?, mode = ?, text_model = ?, image_model = ?, image_api = ?, notes = ?,
       is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where id = ?`,
    p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode,
    p.textModel, p.imageModel, p.imageApi, p.notes, p.active ? 1 : 0, id
  );
  return getProviderById(id);
}

export async function deleteProvider(id) {
  return transaction(db => {
    const info = db.prepare('delete from slenk_notes_providers where id = ?').run(id);
    if (info.changes) {
      db.prepare(
        `update slenk_notes_user_settings set
           active_provider_id = case when active_provider_id = ? then null else active_provider_id end,
           active_text_provider_id = case when active_text_provider_id = ? then null else active_text_provider_id end,
           active_image_provider_id = case when active_image_provider_id = ? then null else active_image_provider_id end`
      ).run(id, id, id);
    }
    return info.changes > 0;
  });
}

export async function getActiveProvider(mode, userId) {
  const settings = await getActiveProviderIds(userId);
  const preferredId = mode === 'text' ? settings.activeTextProviderId
    : mode === 'image' ? settings.activeImageProviderId
    : settings.activeProviderId;
  const row = get(
    `select ${PROVIDER_COLUMNS} from slenk_notes_providers
     order by (id = ?) desc, (mode = ?) desc, created_at, id limit 1`,
    preferredId || '', mode
  );
  return row ? mapProvider(row) : null;
}
