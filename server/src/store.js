import fs from 'node:fs';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import './loadEnv.js';
import { query } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
dotenv.config({ path: path.resolve(root, '.env') });
const configuredStoragePath = process.env.STORAGE_PATH || path.resolve(root, 'storage');
const dataDir = path.isAbsolute(configuredStoragePath) ? configuredStoragePath : path.resolve(root, configuredStoragePath);
const dbPath = path.resolve(dataDir, 'app.json');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const DEFAULT = {
  users: [],
  tasks: [],
  providers: [],
  activeProviderId: null,
  activeTextProviderId: null,
  activeImageProviderId: null,
  notes: []
};

function read() {
  if (!fs.existsSync(dbPath)) return structuredClone(DEFAULT);
  const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  return { ...structuredClone(DEFAULT), ...data, users: data.users || [], tasks: data.tasks || [], providers: data.providers || [] };
}

function write(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin,
    createdAt: row.created_at
  };
}

async function ensureAdmin() {
  const existing = await query('select id from slenk_notes_users where username = $1', ['admin']);
  if (existing.rows.length) return;
  await query(
    `insert into slenk_notes_users (id, username, password_hash, is_admin)
     values ($1, $2, $3, true) on conflict (username) do nothing`,
    ['admin', 'admin', bcrypt.hashSync('123456', 10)]
  );
  await query('insert into slenk_notes_user_settings (user_id) values ($1) on conflict do nothing', ['admin']);
}

async function findUserByUsername(username) {
  const { rows } = await query('select * from slenk_notes_users where username = $1', [username]);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function findUserById(id) {
  const { rows } = await query('select * from slenk_notes_users where id = $1', [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function createUser({ username, passwordHash, isAdmin = false }) {
  const id = uid('user');
  const { rows } = await query(
    `insert into slenk_notes_users (id, username, password_hash, is_admin)
     values ($1, $2, $3, $4) returning *`,
    [id, String(username).trim(), String(passwordHash), Boolean(isAdmin)]
  );
  await query('insert into slenk_notes_user_settings (user_id) values ($1) on conflict do nothing', [id]);
  return mapUser(rows[0]);
}

async function listUsers() {
  const { rows } = await query('select id, username, is_admin, created_at from slenk_notes_users order by created_at');
  return rows.map(r => ({ id: r.id, username: r.username, isAdmin: r.is_admin, createdAt: r.created_at }));
}

function mapTask(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    label: row.label || '',
    status: row.status,
    payload: row.payload,
    providerId: row.provider_id,
    tab: row.tab,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function addTask(task) {
  const { rows } = await query(
    `insert into slenk_notes_tasks (id, user_id, type, label, status, payload, provider_id, tab, result, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [
      task.id, task.userId, task.type, task.label ?? null, task.status ?? 'queued',
      task.payload ?? null, task.providerId ?? null, task.tab ?? null,
      task.result ?? null, task.error ?? null
    ]
  );
  return mapTask(rows[0]);
}

async function listTasks(userId, limit = 100) {
  const { rows } = await query(
    'select * from slenk_notes_tasks where user_id = $1 order by created_at desc limit $2',
    [userId, limit]
  );
  return rows.map(mapTask);
}

async function getTask(userId, id) {
  const { rows } = await query('select * from slenk_notes_tasks where user_id = $1 and id = $2', [userId, id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

async function getTaskById(id) {
  const { rows } = await query('select * from slenk_notes_tasks where id = $1', [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

async function updateTask(id, patch) {
  const fields = [];
  const values = [];
  const push = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
  if ('status' in patch) push('status', patch.status);
  if ('result' in patch) push('result', patch.result);
  if ('error' in patch) push('error', patch.error);
  if ('label' in patch) push('label', patch.label);
  if (!fields.length) return getTaskById(id);
  values.push(id);
  const { rows } = await query(
    `update slenk_notes_tasks set ${fields.join(', ')}, updated_at = now()
     where id = $${values.length} returning *`,
    values
  );
  return rows[0] ? mapTask(rows[0]) : null;
}

async function deleteTask(userId, id) {
  const { rowCount } = await query('delete from slenk_notes_tasks where user_id = $1 and id = $2', [userId, id]);
  return rowCount > 0;
}

function maskApiKey(apiKey) {
  if (!apiKey) return '';
  const s = String(apiKey);
  if (s.length <= 8) return '*'.repeat(Math.max(4, s.length));
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

function listProviders() {
  const data = read();
  return data.providers.map(p => ({ ...p, apiKey: maskApiKey(p.apiKey) }));
}

function getProviderById(id) {
  const data = read();
  return data.providers.find(p => p.id === id) || null;
}

function getProviderUnmaskedById(id) {
  const data = read();
  return data.providers.find(p => p.id === id) || null;
}

function getActiveProvider(mode) {
  const data = read();
  if (mode === 'text' && data.activeTextProviderId) {
    const found = data.providers.find(p => p.id === data.activeTextProviderId);
    if (found) return found;
  }
  if (mode === 'image' && data.activeImageProviderId) {
    const found = data.providers.find(p => p.id === data.activeImageProviderId);
    if (found) return found;
  }
  if (mode === 'text') {
    const textFallback = data.providers.find(p => (p.mode || (p.imageModel ? 'image' : 'text')) === 'text');
    if (textFallback) return textFallback;
  }
  if (mode === 'image') {
    const imageFallback = data.providers.find(p => (p.mode || (p.imageModel ? 'image' : 'text')) === 'image');
    if (imageFallback) return imageFallback;
  }
  return data.providers.find(p => p.id === data.activeProviderId) || data.providers[0] || null;
}

function normalizeProvider(input = {}, id) {
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
    notes: String(input.notes || ''),
    active: Boolean(input.active),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function addProvider(input) {
  const data = read();
  const provider = normalizeProvider(input);
  data.providers.push(provider);
  if (data.providers.length === 1 || input.active) data.activeProviderId = provider.id;
  write(data);
  return listProviders().find(p => p.id === provider.id);
}

function updateProvider(id, input) {
  const data = read();
  const target = data.providers.find(p => p.id === id);
  if (!target) return null;
  const next = normalizeProvider({ ...target, ...input, id }, id);
  if (!next.apiKey && target.apiKey) next.apiKey = target.apiKey;
  Object.assign(target, next);
  if (input.active) data.activeProviderId = id;
  write(data);
  return listProviders().find(p => p.id === id);
}

function deleteProvider(id) {
  const data = read();
  const before = data.providers.length;
  data.providers = data.providers.filter(p => p.id !== id);
  if (data.activeProviderId === id) data.activeProviderId = data.providers[0]?.id || null;
  if (data.activeTextProviderId === id) data.activeTextProviderId = null;
  if (data.activeImageProviderId === id) data.activeImageProviderId = null;
  write(data);
  return data.providers.length < before;
}

async function setActiveProvider(providerId, mode, userId) {
  const column = mode === 'text' ? 'active_text_provider_id'
    : mode === 'image' ? 'active_image_provider_id'
    : 'active_provider_id';
  await query(
    `insert into slenk_notes_user_settings (user_id, ${column}) values ($1, $2)
     on conflict (user_id) do update set ${column} = excluded.${column}`,
    [userId, providerId]
  );
}

async function getActiveProviderIds(userId) {
  const { rows } = await query(
    `select active_provider_id, active_text_provider_id, active_image_provider_id
     from slenk_notes_user_settings where user_id = $1`,
    [userId]
  );
  const row = rows[0] || {};
  return {
    activeProviderId: row.active_provider_id ?? null,
    activeTextProviderId: row.active_text_provider_id ?? null,
    activeImageProviderId: row.active_image_provider_id ?? null
  };
}

function mapNote(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    tags: row.tags || [],
    images: row.images || [],
    createdAt: row.created_at
  };
}

async function saveNote(userId, note = {}) {
  const { rows } = await query(
    `insert into slenk_notes_notes (id, user_id, title, content, tags, images)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [
      uid('note'), userId,
      String(note.title || ''), String(note.content || ''),
      Array.isArray(note.tags) ? note.tags : [],
      JSON.stringify(Array.isArray(note.images) ? note.images : [])
    ]
  );
  return mapNote(rows[0]);
}

// 公开读取：/p/<id> 分享页依赖它，id 是随机串不可枚举。
async function getNote(id) {
  const { rows } = await query('select * from slenk_notes_notes where id = $1', [id]);
  return rows[0] ? mapNote(rows[0]) : null;
}

export {
  ensureAdmin,
  findUserByUsername,
  findUserById,
  createUser,
  listUsers,
  addTask,
  listTasks,
  getTask,
  getTaskById,
  updateTask,
  deleteTask,
  listProviders,
  getProviderById,
  getProviderUnmaskedById,
  getActiveProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  setActiveProvider,
  getActiveProviderIds,
  saveNote,
  getNote,
  dataDir
};
