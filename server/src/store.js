import bcrypt from 'bcryptjs';
import './loadEnv.js';
import { query } from './db.js';
import { paths } from './paths.js';

export const dataDir = paths.dataDir;

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

const PROVIDER_COLUMNS = `id, name, provider_type, app_type, base_url, api_key, mode,
  text_model, image_model, notes, is_active, created_at, updated_at`;

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
    notes: row.notes,
    active: row.is_active,
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
    notes: String(input.notes || ''),
    active: Boolean(input.active)
  };
}

async function listProviders() {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers order by created_at, id`);
  return rows.map(r => withMaskedKey(mapProvider(r)));
}

async function getProviderById(id) {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = $1`, [id]);
  return rows[0] ? withMaskedKey(mapProvider(rows[0])) : null;
}

async function getProviderUnmaskedById(id) {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = $1`, [id]);
  return rows[0] ? mapProvider(rows[0]) : null;
}

async function addProvider(input) {
  const p = providerValues(input);
  const { rows } = await query(
    `insert into slenk_notes_providers
       (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, notes, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${PROVIDER_COLUMNS}`,
    [p.id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode, p.textModel, p.imageModel, p.notes, p.active]
  );
  return withMaskedKey(mapProvider(rows[0]));
}

async function updateProvider(id, input) {
  const existing = await getProviderUnmaskedById(id);
  if (!existing) return null;
  const p = providerValues({ ...existing, ...input, id }, id);
  if (!p.apiKey || p.apiKey === maskApiKey(existing.apiKey)) p.apiKey = existing.apiKey;
  const { rows } = await query(
    `update slenk_notes_providers set name=$2, provider_type=$3, app_type=$4, base_url=$5, api_key=$6,
       mode=$7, text_model=$8, image_model=$9, notes=$10, is_active=$11, updated_at = now()
     where id = $1 returning ${PROVIDER_COLUMNS}`,
    [id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode, p.textModel, p.imageModel, p.notes, p.active]
  );
  return withMaskedKey(mapProvider(rows[0]));
}

async function deleteProvider(id) {
  const { rowCount } = await query('delete from slenk_notes_providers where id = $1', [id]);
  if (rowCount) {
    await query(
      `update slenk_notes_user_settings set
         active_provider_id = case when active_provider_id = $1 then null else active_provider_id end,
         active_text_provider_id = case when active_text_provider_id = $1 then null else active_text_provider_id end,
         active_image_provider_id = case when active_image_provider_id = $1 then null else active_image_provider_id end`,
      [id]
    );
  }
  return rowCount > 0;
}

async function getActiveProvider(mode, userId) {
  const settings = await getActiveProviderIds(userId);
  const preferredId = mode === 'text' ? settings.activeTextProviderId
    : mode === 'image' ? settings.activeImageProviderId
    : settings.activeProviderId;
  if (preferredId) {
    const preferred = await getProviderUnmaskedById(preferredId);
    if (preferred) return preferred;
  }
  const byMode = await query(
    `select ${PROVIDER_COLUMNS} from slenk_notes_providers where mode = $1 order by created_at, id limit 1`,
    [mode]
  );
  if (byMode.rows[0]) return mapProvider(byMode.rows[0]);
  const fallback = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers order by created_at, id limit 1`);
  return fallback.rows[0] ? mapProvider(fallback.rows[0]) : null;
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
  getNote
};
