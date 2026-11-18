import bcrypt from 'bcryptjs';
import './loadEnv.js';
import { query } from './db.js';

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// mysql2 的 json 列：写入必须传 JSON 字符串（JS 对象/数组会报错或误展开成多值），
// 读取时 mysql2 自动把 json 列解析回 JS 对象/数组。这里统一序列化。
function toJson(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value; // 已是 JSON 字符串
  return JSON.stringify(value);
}

// 唯一约束冲突：MySQL 用 errno 1062 / code 'ER_DUP_ENTRY'（PG 是 '23505'）。
function isDuplicateError(err) {
  return err?.errno === 1062 || err?.code === 'ER_DUP_ENTRY';
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: Boolean(row.is_admin),   // MySQL tinyint(1) 返回 0/1，转回布尔
    createdAt: row.created_at
  };
}

// 幂等自检：admin 用户存在与否一旦确认过就不再每次登录都查库（远程库往返成本高）。
let adminEnsured = false;
async function ensureAdmin() {
  if (adminEnsured) return;
  const existing = await query('select id from slenk_notes_users where username = ?', ['admin']);
  if (existing.rows.length) { adminEnsured = true; return; }
  await query(
    `insert into slenk_notes_users (id, username, password_hash, is_admin)
     values (?, ?, ?, true) on duplicate key update username = username`,
    ['admin', 'admin', bcrypt.hashSync('123456', 10)]
  );
  await query('insert into slenk_notes_user_settings (user_id) values (?) on duplicate key update user_id = user_id', ['admin']);
  adminEnsured = true;
}

async function findUserByUsername(username) {
  const { rows } = await query('select * from slenk_notes_users where username = ?', [username]);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function findUserById(id) {
  const { rows } = await query('select * from slenk_notes_users where id = ?', [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function createUser({ username, passwordHash, isAdmin = false }) {
  const id = uid('user');
  await query(
    `insert into slenk_notes_users (id, username, password_hash, is_admin)
     values (?, ?, ?, ?)`,
    [id, String(username).trim(), String(passwordHash), Boolean(isAdmin)]
  );
  await query('insert into slenk_notes_user_settings (user_id) values (?) on duplicate key update user_id = user_id', [id]);
  const { rows } = await query('select * from slenk_notes_users where id = ?', [id]);
  return mapUser(rows[0]);
}

async function listUsers() {
  const { rows } = await query(
    'select u.id, u.username, u.is_admin, u.created_at, (select count(*) from slenk_notes_notes n where n.user_id = u.id) as note_count, (select count(*) from slenk_notes_tasks t where t.user_id = u.id) as task_count from slenk_notes_users u order by u.created_at'
  );
  return rows.map(r => ({ id: r.id, username: r.username, isAdmin: Boolean(r.is_admin), createdAt: r.created_at, noteCount: Number(r.note_count), taskCount: Number(r.task_count) }));
}

async function updateUser(id, patch = {}) {
  const fields = [];
  const values = [];
  const push = (column, value) => { values.push(value); fields.push(`${column} = ?`); };
  if ('passwordHash' in patch) push('password_hash', patch.passwordHash);
  if ('isAdmin' in patch) push('is_admin', Boolean(patch.isAdmin));
  if (!fields.length) return findUserById(id);
  values.push(id);
  await query(`update slenk_notes_users set ${fields.join(', ')} where id = ?`, values);
  const { rows } = await query('select * from slenk_notes_users where id = ?', [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function deleteUser(id) {
  const { rowCount } = await query('delete from slenk_notes_users where id = ?', [id]);
  return rowCount > 0;
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
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username || null,
    type: row.type,
    label: displayTaskLabel(row),
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
  await query(
    `insert into slenk_notes_tasks (id, user_id, type, label, status, payload, provider_id, tab, result, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id, task.userId, task.type, task.label ?? null, task.status ?? 'queued',
      toJson(task.payload), task.providerId ?? null, task.tab ?? null,
      toJson(task.result), task.error ?? null
    ]
  );
  const { rows } = await query('select * from slenk_notes_tasks where id = ?', [task.id]);
  return mapTask(rows[0]);
}

async function listTasks(userId, limit = 100) {
  const { rows } = await query(
    'select * from slenk_notes_tasks where user_id = ? order by created_at desc limit ?',
    [userId, limit]
  );
  return rows.map(mapTask);
}

async function getTask(userId, id) {
  const { rows } = await query('select * from slenk_notes_tasks where user_id = ? and id = ?', [userId, id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

// 任务编号计数：image 类型按来源页签区分（替换生图与 AI 生图共用 type=image）。
async function countTasksByType(userId, type, tab) {
  const { rows } = await query(
    `select count(*) as n from slenk_notes_tasks
     where user_id = ? and type = ?
       and (? <> 'image' or coalesce(tab, '') = coalesce(?, ''))`,
    [userId, type, type, tab ?? null]
  );
  return Number(rows[0]?.n ?? 0);
}

// 任务结果全站共享：列表与详情不再按 user_id 过滤，附带生成者用户名用于前端署名。
// 列表接口被前端每 4 秒轮询（任务全站共享），只回展示所需字段；
// result/payload 是重 JSON，改由 /api/tasks/:id 按需拉取（结果面板/详情弹窗才需要）。
// MySQL 的 JSON 路径提取用 ->>'$.key'（PG 是 ->>'key'）。
const TASK_LIST_COLUMNS = `t.id, t.user_id, u.username, t.type, t.label, t.status, t.tab,
  t.provider_id, t.created_at, t.updated_at, t.error,
  t.payload->>'$.noteId' as note_id, t.payload->>'$.noteTitle' as note_title,
  t.payload->>'$.purpose' as purpose`;

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

async function listAllTasks(limit = 200) {
  const { rows } = await query(
    `select ${TASK_LIST_COLUMNS} from slenk_notes_tasks t
     left join slenk_notes_users u on u.id = t.user_id
     order by t.created_at desc limit ?`,
    [limit]
  );
  return rows.map(mapTaskListRow);
}

async function getTaskById(id) {
  const { rows } = await query(
    `select t.*, u.username from slenk_notes_tasks t
     left join slenk_notes_users u on u.id = t.user_id
     where t.id = ?`,
    [id]
  );
  return rows[0] ? mapTask(rows[0]) : null;
}

// 管理员删除他人任务时使用；本人的任务仍走 deleteTask(userId, id)。
async function deleteTaskById(id) {
  const { rowCount } = await query('delete from slenk_notes_tasks where id = ?', [id]);
  return rowCount > 0;
}

// 批量删除：管理员可删任何任务，普通用户只删得动自己的；返回实际删除条数。
// PG 的 id = any($1) 改为 MySQL 的 id in (?, ?, ...)。
async function deleteTasksByIds(ids, userId, isAdmin) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  if (isAdmin) {
    const { rowCount } = await query(`delete from slenk_notes_tasks where id in (${placeholders})`, ids);
    return rowCount;
  }
  const { rowCount } = await query(`delete from slenk_notes_tasks where id in (${placeholders}) and user_id = ?`, [...ids, userId]);
  return rowCount;
}

async function updateTask(userId, id, patch, insertMeta) {
  const fields = [];
  const values = [];
  const push = (column, value) => { values.push(value); fields.push(`${column} = ?`); };
  if ('status' in patch) push('status', patch.status);
  if ('result' in patch) push('result', toJson(patch.result));
  if ('error' in patch) push('error', patch.error);
  if ('label' in patch) push('label', patch.label);
  if (!fields.length) return await getTask(userId, id);
  values.push(id, userId);
  const { rowCount } = await query(
    `update slenk_notes_tasks set ${fields.join(', ')}, updated_at = UTC_TIMESTAMP(3)
     where id = ? and user_id = ?`,
    values
  );
  // 迁移前入队、但 MySQL 里没有对应行的旧任务：UPDATE 命中 0 行，状态会被静默丢弃。
  // worker 处理这类任务时带上 insertMeta（type/payload/providerId/tab/label，取自 job），
  // 命中 0 行就补插一行，让任务结果在 UI 任务列表可见，而不是无声消失。
  if (rowCount === 0 && insertMeta) {
    const cols = ['id', 'user_id', 'type', 'status', 'label'];
    const vals = [id, userId, insertMeta.type ?? 'task', patch.status ?? 'queued', patch.label ?? insertMeta.label ?? null];
    if (insertMeta.payload !== undefined) { cols.push('payload'); vals.push(toJson(insertMeta.payload)); }
    if (insertMeta.providerId !== undefined) { cols.push('provider_id'); vals.push(insertMeta.providerId); }
    if (insertMeta.tab !== undefined) { cols.push('tab'); vals.push(insertMeta.tab); }
    if ('result' in patch) { cols.push('result'); vals.push(toJson(patch.result)); }
    if ('error' in patch) { cols.push('error'); vals.push(patch.error); }
    // 重复键分支同样应用 patch（行恰好存在但值未变的极端情况）；cols 与 vals 同序，一一对应。
    const dupeCols = cols.slice(4);
    const dupeVals = vals.slice(4);
    await query(
      `insert into slenk_notes_tasks (${cols.join(', ')}, created_at, updated_at)
       values (${cols.map(() => '?').join(', ')}, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
       on duplicate key update ${dupeCols.map(c => `${c} = ?`).join(', ')}, updated_at = UTC_TIMESTAMP(3)`,
      [...vals, ...dupeVals]
    );
  }
  const { rows } = await query('select * from slenk_notes_tasks where user_id = ? and id = ?', [userId, id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

async function deleteTask(userId, id) {
  const { rowCount } = await query('delete from slenk_notes_tasks where user_id = ? and id = ?', [userId, id]);
  return rowCount > 0;
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
    active: Boolean(row.is_active),   // tinyint(1) → 布尔
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

async function listProviders() {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers order by created_at, id`);
  return rows.map(r => withMaskedKey(mapProvider(r)));
}

async function getProviderById(id) {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = ?`, [id]);
  return rows[0] ? withMaskedKey(mapProvider(rows[0])) : null;
}

async function getProviderUnmaskedById(id) {
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = ?`, [id]);
  return rows[0] ? mapProvider(rows[0]) : null;
}

async function addProvider(input) {
  const p = providerValues(input);
  await query(
    `insert into slenk_notes_providers
       (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, image_api, notes, is_active)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode, p.textModel, p.imageModel, p.imageApi, p.notes, p.active]
  );
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = ?`, [p.id]);
  return withMaskedKey(mapProvider(rows[0]));
}

async function updateProvider(id, input) {
  const existing = await getProviderUnmaskedById(id);
  if (!existing) return null;
  const p = providerValues({ ...existing, ...input, id }, id);
  if (!p.apiKey || p.apiKey === maskApiKey(existing.apiKey)) p.apiKey = existing.apiKey;
  await query(
    `update slenk_notes_providers set name=?, provider_type=?, app_type=?, base_url=?, api_key=?,
       mode=?, text_model=?, image_model=?, image_api=?, notes=?, is_active=?, updated_at = UTC_TIMESTAMP(3)
     where id = ?`,
    [p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode, p.textModel, p.imageModel, p.imageApi, p.notes, p.active, id]
  );
  const { rows } = await query(`select ${PROVIDER_COLUMNS} from slenk_notes_providers where id = ?`, [id]);
  return withMaskedKey(mapProvider(rows[0]));
}

async function deleteProvider(id) {
  const { rowCount } = await query('delete from slenk_notes_providers where id = ?', [id]);
  if (rowCount) {
    await query(
      `update slenk_notes_user_settings set
         active_provider_id = case when active_provider_id = ? then null else active_provider_id end,
         active_text_provider_id = case when active_text_provider_id = ? then null else active_text_provider_id end,
         active_image_provider_id = case when active_image_provider_id = ? then null else active_image_provider_id end`,
      [id, id, id]
    );
  }
  return rowCount > 0;
}

async function getActiveProvider(mode, userId) {
  const settings = await getActiveProviderIds(userId);
  const preferredId = mode === 'text' ? settings.activeTextProviderId
    : mode === 'image' ? settings.activeImageProviderId
    : settings.activeProviderId;
  // 一次查询完成三段回退（用户偏好 > 按模式首个 > 任意首个），省掉多次串行的远程往返。
  const { rows } = await query(
    `select ${PROVIDER_COLUMNS} from slenk_notes_providers
     order by (id = ?) desc, (mode = ?) desc, created_at, id limit 1`,
    [preferredId || '', mode]
  );
  return rows[0] ? mapProvider(rows[0]) : null;
}

async function setActiveProvider(providerId, mode, userId) {
  const column = mode === 'text' ? 'active_text_provider_id'
    : mode === 'image' ? 'active_image_provider_id'
    : 'active_provider_id';
  await query(
    `insert into slenk_notes_user_settings (user_id, ${column}) values (?, ?)
     on duplicate key update ${column} = values(${column})`,
    [userId, providerId]
  );
}

async function getActiveProviderIds(userId) {
  const { rows } = await query(
    `select active_provider_id, active_text_provider_id, active_image_provider_id
     from slenk_notes_user_settings where user_id = ?`,
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
  const id = uid('note');
  await query(
    `insert into slenk_notes_notes (id, user_id, title, content, tags, images)
     values (?, ?, ?, ?, ?, ?)`,
    [
      id, userId,
      String(note.title || ''), String(note.content || ''),
      toJson(Array.isArray(note.tags) ? note.tags : []),
      toJson(Array.isArray(note.images) ? note.images : [])
    ]
  );
  const { rows } = await query('select * from slenk_notes_notes where id = ?', [id]);
  return mapNote(rows[0]);
}

// 公开读取：/p/<id> 分享页依赖它，id 是随机串不可枚举。
async function getNote(id) {
  const { rows } = await query('select * from slenk_notes_notes where id = ?', [id]);
  return rows[0] ? mapNote(rows[0]) : null;
}

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

// 全部用户接口带 user_id 条件，服务端强制隔离，禁止跨用户访问。
async function listXhsAccounts(userId) {
  const { rows } = await query(
    'select * from slenk_notes_xhs_accounts where user_id = ? order by created_at desc',
    [userId]
  );
  return rows.map(mapXhsAccount);
}

async function getXhsAccount(userId, id) {
  const { rows } = await query('select * from slenk_notes_xhs_accounts where user_id = ? and id = ?', [userId, id]);
  return rows[0] ? mapXhsAccount(rows[0]) : null;
}

// 插入待绑定行：open_id 为 NULL，unique(user_id, open_id) 对 NULL 互不冲突。
async function createXhsAccountPending(userId, { id, credentialDir }) {
  await query(
    `insert into slenk_notes_xhs_accounts (id, user_id, credential_dir)
     values (?, ?, ?)`,
    [id, userId, credentialDir]
  );
  const { rows } = await query('select * from slenk_notes_xhs_accounts where id = ?', [id]);
  return mapXhsAccount(rows[0]);
}

// 扫码成功回填 open_id；unique(user_id, open_id) 冲突映射为 XHS_ACCOUNT_DUPLICATE。
async function bindXhsAccountOpenId(userId, id, { openId, nickname } = {}) {
  try {
    await query(
      `update slenk_notes_xhs_accounts set open_id = ?, nickname = ?, updated_at = UTC_TIMESTAMP(3)
       where user_id = ? and id = ?`,
      [openId ?? null, nickname ?? '', userId, id]
    );
    const { rows } = await query('select * from slenk_notes_xhs_accounts where user_id = ? and id = ?', [userId, id]);
    return rows[0] ? mapXhsAccount(rows[0]) : null;
  } catch (error) {
    if (isDuplicateError(error)) {
      const mapped = new Error('XHS 账号已绑定');
      mapped.code = 'XHS_ACCOUNT_DUPLICATE';
      throw mapped;
    }
    throw error;
  }
}

async function findXhsAccountByOpenId(userId, openId) {
  const { rows } = await query(
    'select * from slenk_notes_xhs_accounts where user_id = ? and open_id = ?',
    [userId, openId]
  );
  return rows[0] ? mapXhsAccount(rows[0]) : null;
}

// 返回被删行（含 credential_dir）供上层清理磁盘凭证目录；不存在或跨用户返回 null。
// MySQL 无 DELETE ... RETURNING，先 SELECT 后 DELETE。
async function deleteXhsAccount(userId, id) {
  const { rows } = await query('select * from slenk_notes_xhs_accounts where user_id = ? and id = ?', [userId, id]);
  const row = rows[0];
  if (!row) return null;
  await query('delete from slenk_notes_xhs_accounts where user_id = ? and id = ?', [userId, id]);
  return mapXhsAccount(row);
}

// 改名：仅当前用户，返回更新后行；不存在或跨用户返回 null。空字符串表示清除昵称。
async function updateXhsAccountNickname(userId, id, nickname) {
  await query(
    'update slenk_notes_xhs_accounts set nickname = ?, updated_at = UTC_TIMESTAMP(3) where user_id = ? and id = ?',
    [nickname, userId, id]
  );
  const { rows } = await query('select * from slenk_notes_xhs_accounts where user_id = ? and id = ?', [userId, id]);
  return rows[0] ? mapXhsAccount(rows[0]) : null;
}

// 管理员只读：按 user 分组返回 [{ userId, accounts }]。
async function listAllXhsAccounts() {
  const { rows } = await query(
    'select * from slenk_notes_xhs_accounts order by user_id, created_at desc'
  );
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

// 生成媒体（Phase 2）：本体存 MySQL LONGBLOB（slenk_notes_media），替代原 Supabase Storage。
// 任务 result 里的媒体引用是 /api/media/<id>；data 为 Buffer，size_bytes 由调用方按 data.length 写入。
async function insertMedia({ id, taskId, userId, filename, mimeType, data }) {
  await query(
    'insert into slenk_notes_media (id, task_id, user_id, filename, mime_type, data, size_bytes) values (?, ?, ?, ?, ?, ?, ?)',
    [id, taskId ?? null, userId, filename, mimeType, data, data.length]
  );
  return id;
}

async function getMedia(id) {
  const { rows } = await query(
    'select id, task_id, user_id, filename, mime_type, data, size_bytes from slenk_notes_media where id = ?',
    [id]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: row.id,
    taskId: row.task_id,
    userId: row.user_id,
    filename: row.filename,
    mimeType: row.mime_type,
    data: row.data,
    sizeBytes: Number(row.size_bytes)
  };
}

// cacheJanitor 用：全量笔记 images 与任务 payload（本地后端同样提供，供孤儿缓存清理引用扫描）。
export async function getAllNotesImagesForJanitor() {
  const { rows } = await query('select images from slenk_notes_notes');
  return rows.map(r => r.images);
}

export async function getAllTasksPayloadForJanitor() {
  const { rows } = await query('select payload from slenk_notes_tasks');
  return rows.map(r => r.payload);
}

export {
  ensureAdmin,
  findUserByUsername,
  findUserById,
  createUser,
  listUsers,
  updateUser,
  deleteUser,
  addTask,
  listTasks,
  countTasksByType,
  listAllTasks,
  getTask,
  getTaskById,
  updateTask,
  deleteTask,
  deleteTaskById,
  deleteTasksByIds,
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
  insertMedia,
  getMedia,
  listXhsAccounts,
  getXhsAccount,
  createXhsAccountPending,
  bindXhsAccountOpenId,
  findXhsAccountByOpenId,
  deleteXhsAccount,
  updateXhsAccountNickname,
  listAllXhsAccounts
};
