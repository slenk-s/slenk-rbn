// store.sqlite.js — SQLite 后端（默认）。实现与 store.mysql.js 相同的函数契约。
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb, withRetry, transaction, parseJson, toJson } from './lib/sqlite.js';
import { writeMediaFile, readMediaFile, removeMediaFile, removeMediaFiles } from './lib/mediaFiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(__dirname, '../scripts/schema.sqlite.sql');

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function all(sql, ...params) { return withRetry(() => openDb().prepare(sql).all(...params)); }
function get(sql, ...params) { return withRetry(() => openDb().prepare(sql).get(...params)); }
function run(sql, ...params) { return withRetry(() => openDb().prepare(sql).run(...params)); }

function isDuplicateError(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message));
}

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

function typeLabel(type) {
  if (type === 'image') return 'AI生图';
  if (type === 'video') return '实况视频';
  if (type === 'rewrite') return '文案改写';
  if (type === 'publish') return '小红书发布';
  return String(type || '任务');
}

function taskName(type, payload) {
  const purpose = payload && payload.purpose;
  if (purpose === 'title') return '标题生成';
  if (purpose === 'content') return '正文生成';
  if (purpose === 'tags') return '话题标签生成';
  if (purpose === 'noteImage') return '配图生成';
  return typeLabel(type);
}

function displayTaskLabel(row) {
  const label = row.label || '';
  if (!/^(Text|Image|Video|Task)\d+$/i.test(label)) return label;
  const suffix = String(label).replace(/^[^\d]+/i, '');
  return `${taskName(row.type, row.payload)}${suffix || ''}`;
}

function mapTask(row) {
  const payload = parseJson(row.payload, null);
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username || null,
    type: row.type,
    label: displayTaskLabel({ ...row, payload }),
    status: row.status,
    payload,
    providerId: row.provider_id,
    tab: row.tab,
    result: parseJson(row.result, null),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTaskListRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username || null,
    type: row.type,
    label: displayTaskLabel({ ...row, payload: { purpose: row.purpose } }),
    status: row.status,
    tab: row.tab,
    providerId: row.provider_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
    noteId: row.note_id || null,
    noteTitle: row.note_title || null
  };
}

export async function addTask(task) {
  run(
    `insert into slenk_notes_tasks (id, user_id, type, label, status, payload, provider_id, tab, result, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id, task.userId, task.type, task.label ?? null, task.status ?? 'queued',
    toJson(task.payload), task.providerId ?? null, task.tab ?? null,
    toJson(task.result), task.error ?? null
  );
  return getTaskById(task.id);
}

export async function listTasks(userId, limit = 100) {
  return all(
    'select * from slenk_notes_tasks where user_id = ? order by created_at desc limit ?',
    userId, limit
  ).map(mapTask);
}

export async function getTask(userId, id) {
  const row = get('select * from slenk_notes_tasks where user_id = ? and id = ?', userId, id);
  return row ? mapTask(row) : null;
}

export async function countTasksByType(userId, type, tab) {
  const row = get(
    `select count(*) as n from slenk_notes_tasks
     where user_id = ? and type = ?
       and (? <> 'image' or coalesce(tab, '') = coalesce(?, ''))`,
    userId, type, type, tab ?? null
  );
  return Number(row?.n ?? 0);
}

export async function listAllTasks(limit = 200) {
  return all(
    `select t.id, t.user_id, u.username, t.type, t.label, t.status, t.tab,
            t.provider_id, t.created_at, t.updated_at, t.error, t.payload
     from slenk_notes_tasks t
     left join slenk_notes_users u on u.id = t.user_id
     order by t.created_at desc limit ?`,
    limit
  ).map(row => {
    const payload = parseJson(row.payload, {}) || {};
    return mapTaskListRow({
      ...row,
      purpose: payload.purpose,
      note_id: payload.noteId ?? null,
      note_title: payload.noteTitle ?? null
    });
  });
}

export async function getTaskById(id) {
  const row = get(
    `select t.*, u.username from slenk_notes_tasks t
     left join slenk_notes_users u on u.id = t.user_id
     where t.id = ?`,
    id
  );
  return row ? mapTask(row) : null;
}

export async function deleteTask(userId, id) {
  return run('delete from slenk_notes_tasks where user_id = ? and id = ?', userId, id).changes > 0;
}

export async function deleteTaskById(id) {
  return run('delete from slenk_notes_tasks where id = ?', id).changes > 0;
}

export async function deleteTasksByIds(ids, userId, isAdmin) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  if (isAdmin) {
    return run(`delete from slenk_notes_tasks where id in (${placeholders})`, ...ids).changes;
  }
  return run(
    `delete from slenk_notes_tasks where id in (${placeholders}) and user_id = ?`,
    ...ids, userId
  ).changes;
}

export async function updateTask(userId, id, patch, insertMeta) {
  const fields = [];
  const values = [];
  if ('status' in patch) { fields.push('status = ?'); values.push(patch.status); }
  if ('result' in patch) { fields.push('result = ?'); values.push(toJson(patch.result)); }
  if ('error' in patch) { fields.push('error = ?'); values.push(patch.error); }
  if ('label' in patch) { fields.push('label = ?'); values.push(patch.label); }
  if (!fields.length) return getTask(userId, id);
  const changed = run(
    `update slenk_notes_tasks set ${fields.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where id = ? and user_id = ?`,
    ...values, id, userId
  ).changes;
  // 迁移前入队、但库里没有对应行的旧任务：UPDATE 命中 0 行，状态会被静默丢弃。
  // worker 处理这类任务时带上 insertMeta（type/payload/providerId/tab/label，取自 job），
  // 命中 0 行就补插一行，让任务结果在 UI 任务列表可见，而不是无声消失。
  if (changed === 0 && insertMeta) {
    const cols = ['id', 'user_id', 'type', 'status', 'label'];
    const vals = [id, userId, insertMeta.type ?? 'task', patch.status ?? 'queued', patch.label ?? insertMeta.label ?? null];
    if (insertMeta.payload !== undefined) { cols.push('payload'); vals.push(toJson(insertMeta.payload)); }
    if (insertMeta.providerId !== undefined) { cols.push('provider_id'); vals.push(insertMeta.providerId); }
    if (insertMeta.tab !== undefined) { cols.push('tab'); vals.push(insertMeta.tab); }
    if ('result' in patch) { cols.push('result'); vals.push(toJson(patch.result)); }
    if ('error' in patch) { cols.push('error'); vals.push(patch.error); }
    // 重复键分支同样应用 patch（行恰好存在但值未变的极端情况）。
    const dupeCols = cols.slice(4);
    run(
      `insert into slenk_notes_tasks (${cols.join(', ')})
       values (${cols.map(() => '?').join(', ')})
       on conflict (id) do update set ${dupeCols.map(c => `${c} = excluded.${c}`).join(', ')},
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ...vals
    );
  }
  return getTask(userId, id);
}

// ---- 笔记 ----

function mapNote(row) {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    tags: parseJson(row.tags, []),
    images: parseJson(row.images, []),
    createdAt: row.created_at
  };
}

export async function saveNote(userId, note = {}) {
  const id = uid('note');
  run(
    'insert into slenk_notes_notes (id, user_id, title, content, tags, images) values (?, ?, ?, ?, ?, ?)',
    id, userId,
    String(note.title || ''), String(note.content || ''),
    toJson(Array.isArray(note.tags) ? note.tags : []),
    toJson(Array.isArray(note.images) ? note.images : [])
  );
  return getNote(id);
}

// 公开读取：/p/<id> 分享页依赖它，id 是随机串不可枚举。
export async function getNote(id) {
  const row = get('select * from slenk_notes_notes where id = ?', id);
  return row ? mapNote(row) : null;
}

// ---- XHS 账号（user_id 强制隔离） ----

function mapXhsAccount(row) {
  return {
    id: row.id,
    userId: row.user_id,
    credentialDir: row.credential_dir,
    openId: row.open_id,
    nickname: row.nickname,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listXhsAccounts(userId) {
  return all('select * from slenk_notes_xhs_accounts where user_id = ? order by created_at desc', userId)
    .map(mapXhsAccount);
}

export async function getXhsAccount(userId, id) {
  const row = get('select * from slenk_notes_xhs_accounts where user_id = ? and id = ?', userId, id);
  return row ? mapXhsAccount(row) : null;
}

export async function createXhsAccountPending(userId, { id, credentialDir }) {
  run('insert into slenk_notes_xhs_accounts (id, user_id, credential_dir) values (?, ?, ?)', id, userId, credentialDir);
  return getXhsAccount(userId, id);
}

// 扫码成功回填 open_id；unique(user_id, open_id) 冲突映射为 XHS_ACCOUNT_DUPLICATE。
export async function bindXhsAccountOpenId(userId, id, { openId, nickname } = {}) {
  try {
    run(
      `update slenk_notes_xhs_accounts set open_id = ?, nickname = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       where user_id = ? and id = ?`,
      openId ?? null, nickname ?? '', userId, id
    );
    return getXhsAccount(userId, id);
  } catch (error) {
    if (isDuplicateError(error)) {
      const mapped = new Error('XHS 账号已绑定');
      mapped.code = 'XHS_ACCOUNT_DUPLICATE';
      throw mapped;
    }
    throw error;
  }
}

export async function findXhsAccountByOpenId(userId, openId) {
  const row = get('select * from slenk_notes_xhs_accounts where user_id = ? and open_id = ?', userId, openId);
  return row ? mapXhsAccount(row) : null;
}

// 返回被删行（含 credential_dir）供上层清理磁盘凭证目录；不存在或跨用户返回 null。
export async function deleteXhsAccount(userId, id) {
  const row = get('select * from slenk_notes_xhs_accounts where user_id = ? and id = ?', userId, id);
  if (!row) return null;
  run('delete from slenk_notes_xhs_accounts where user_id = ? and id = ?', userId, id);
  return mapXhsAccount(row);
}

export async function updateXhsAccountNickname(userId, id, nickname) {
  run(
    `update slenk_notes_xhs_accounts set nickname = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     where user_id = ? and id = ?`,
    nickname, userId, id
  );
  return getXhsAccount(userId, id);
}

// 管理员只读：按 user 分组返回 [{ userId, accounts }]。
export async function listAllXhsAccounts() {
  const rows = all('select * from slenk_notes_xhs_accounts order by user_id, created_at desc');
  const groups = [];
  const byUser = new Map();
  for (const row of rows) {
    const account = mapXhsAccount(row);
    if (!byUser.has(row.user_id)) {
      const group = { userId: row.user_id, accounts: [] };
      byUser.set(row.user_id, group);
      groups.push(group);
    }
    byUser.get(row.user_id).accounts.push(account);
  }
  return groups;
}

// ---- 媒体（数据库存元数据，字节在 <mediaDir>/<id>） ----

export async function insertMedia({ id, taskId, userId, filename, mimeType, data }) {
  writeMediaFile(id, data);
  try {
    run(
      'insert into slenk_notes_media (id, task_id, user_id, filename, mime_type, size_bytes) values (?, ?, ?, ?, ?, ?)',
      id, taskId ?? null, userId, filename, mimeType, data.length
    );
  } catch (err) {
    // 插行失败（FK / 唯一冲突）时删除已写的文件，不留孤儿。
    removeMediaFile(id);
    throw err;
  }
  return id;
}

export async function getMedia(id) {
  const row = get('select id, task_id, user_id, filename, mime_type, size_bytes from slenk_notes_media where id = ?', id);
  if (!row) return null;
  const data = readMediaFile(id);
  if (data == null) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    filename: row.filename,
    mimeType: row.mime_type,
    data,
    sizeBytes: Number(row.size_bytes)
  };
}

// cacheJanitor 用：全量笔记 images 与任务 payload（供孤儿缓存清理引用扫描）。
export async function getAllNotesImagesForJanitor() {
  return all('select images from slenk_notes_notes').map(r => parseJson(r.images, []));
}

export async function getAllTasksPayloadForJanitor() {
  return all('select payload from slenk_notes_tasks').map(r => parseJson(r.payload, null));
}

// 巡检脚本用：全量媒体 id，供与文件目录对比。
export async function listMediaIds() {
  return all('select id from slenk_notes_media').map(r => r.id);
}
