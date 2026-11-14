import bcrypt from 'bcryptjs';
import './loadEnv.js';
import { query } from './db.js';

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

// 幂等自检：admin 用户存在与否一旦确认过就不再每次登录都查库（远程库往返成本高）。
let adminEnsured = false;
async function ensureAdmin() {
  if (adminEnsured) return;
  const existing = await query('select id from slenk_notes_users where username = $1', ['admin']);
  if (existing.rows.length) { adminEnsured = true; return; }
  await query(
    `insert into slenk_notes_users (id, username, password_hash, is_admin)
     values ($1, $2, $3, true) on conflict (username) do nothing`,
    ['admin', 'admin', bcrypt.hashSync('123456', 10)]
  );
  await query('insert into slenk_notes_user_settings (user_id) values ($1) on conflict do nothing', ['admin']);
  adminEnsured = true;
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
  const { rows } = await query('select u.id, u.username, u.is_admin, u.created_at, (select count(*)::int from slenk_notes_notes n where n.user_id = u.id) as note_count, (select count(*)::int from slenk_notes_tasks t where t.user_id = u.id) as task_count from slenk_notes_users u order by u.created_at');
  return rows.map(r => ({ id: r.id, username: r.username, isAdmin: r.is_admin, createdAt: r.created_at, noteCount: r.note_count, taskCount: r.task_count }));
}

async function updateUser(id, patch = {}) {
  const fields = [];
  const values = [];
  const push = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
  if ('passwordHash' in patch) push('password_hash', patch.passwordHash);
  if ('isAdmin' in patch) push('is_admin', Boolean(patch.isAdmin));
  if (!fields.length) return findUserById(id);
  values.push(id);
  const { rows } = await query(`update slenk_notes_users set ${fields.join(', ')} where id = $${values.length} returning *`, values);
  return rows[0] ? mapUser(rows[0]) : null;
}

async function deleteUser(id) {
  const { rowCount } = await query('delete from slenk_notes_users where id = $1', [id]);
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

// 任务编号计数：image 类型按来源页签区分（替换生图与 AI 生图共用 type=image）。
async function countTasksByType(userId, type, tab) {
  const { rows } = await query(
    `select count(*)::int as n from slenk_notes_tasks
     where user_id = $1 and type = $2
       and ($2 <> 'image' or coalesce(tab, '') = coalesce($3, ''))`,
    [userId, type, tab ?? null]
  );
  return rows[0].n;
}

// 任务结果全站共享：列表与详情不再按 user_id 过滤，附带生成者用户名用于前端署名。
// 列表接口被前端每 4 秒轮询（任务全站共享），只回展示所需字段；
// result/payload 是重 JSONB，改由 /api/tasks/:id 按需拉取（结果面板/详情弹窗才需要）。
const TASK_LIST_COLUMNS = `t.id, t.user_id, u.username, t.type, t.label, t.status, t.tab,
  t.provider_id, t.created_at, t.updated_at, t.error,
  t.payload->>'noteId' as note_id, t.payload->>'noteTitle' as note_title,
  t.payload->>'purpose' as purpose`;

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
     order by t.created_at desc limit $1`,
    [limit]
  );
  return rows.map(mapTaskListRow);
}

async function getTaskById(id) {
  const { rows } = await query(
    `select t.*, u.username from slenk_notes_tasks t
     left join slenk_notes_users u on u.id = t.user_id
     where t.id = $1`,
    [id]
  );
  return rows[0] ? mapTask(rows[0]) : null;
}

// 管理员删除他人任务时使用；本人的任务仍走 deleteTask(userId, id)。
async function deleteTaskById(id) {
  const { rowCount } = await query('delete from slenk_notes_tasks where id = $1', [id]);
  return rowCount > 0;
}

// 批量删除：管理员可删任何任务，普通用户只删得动自己的；返回实际删除条数。
async function deleteTasksByIds(ids, userId, isAdmin) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  if (isAdmin) {
    const { rowCount } = await query('delete from slenk_notes_tasks where id = any($1)', [ids]);
    return rowCount;
  }
  const { rowCount } = await query('delete from slenk_notes_tasks where id = any($1) and user_id = $2', [ids, userId]);
  return rowCount;
}

async function updateTask(userId, id, patch) {
  const fields = [];
  const values = [];
  const push = (column, value) => { values.push(value); fields.push(`${column} = $${values.length}`); };
  if ('status' in patch) push('status', patch.status);
  if ('result' in patch) push('result', patch.result);
  if ('error' in patch) push('error', patch.error);
  if ('label' in patch) push('label', patch.label);
  if (!fields.length) return await getTask(userId, id);
  values.push(id, userId);
  const { rows } = await query(
    `update slenk_notes_tasks set ${fields.join(', ')}, updated_at = now()
     where id = $${values.length - 1} and user_id = $${values.length} returning *`,
    values
  );
  return rows[0] ? mapTask(rows[0]) : null;
}

async function deleteTask(userId, id) {
  const { rowCount } = await query('delete from slenk_notes_tasks where user_id = $1 and id = $2', [userId, id]);
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
       (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, image_api, notes, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning ${PROVIDER_COLUMNS}`,
    [p.id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode, p.textModel, p.imageModel, p.imageApi, p.notes, p.active]
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
       mode=$7, text_model=$8, image_model=$9, image_api=$10, notes=$11, is_active=$12, updated_at = now()
     where id = $1 returning ${PROVIDER_COLUMNS}`,
    [id, p.name, p.providerType, p.appType, p.baseUrl, p.apiKey, p.mode, p.textModel, p.imageModel, p.imageApi, p.notes, p.active]
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
  // 一次查询完成三段回退（用户偏好 > 按模式首个 > 任意首个），省掉多次串行的远程往返。
  const { rows } = await query(
    `select ${PROVIDER_COLUMNS} from slenk_notes_providers
     order by (id = $2) desc, (mode = $1) desc, created_at, id limit 1`,
    [mode, preferredId || '']
  );
  return rows[0] ? mapProvider(rows[0]) : null;
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
    'select * from slenk_notes_xhs_accounts where user_id = $1 order by created_at desc',
    [userId]
  );
  return rows.map(mapXhsAccount);
}

async function getXhsAccount(userId, id) {
  const { rows } = await query('select * from slenk_notes_xhs_accounts where user_id = $1 and id = $2', [userId, id]);
  return rows[0] ? mapXhsAccount(rows[0]) : null;
}

// 插入待绑定行：open_id 为 NULL，Postgres 的 unique(user_id, open_id) 对 NULL 互不冲突。
async function createXhsAccountPending(userId, { id, credentialDir }) {
  const { rows } = await query(
    `insert into slenk_notes_xhs_accounts (id, user_id, credential_dir)
     values ($1, $2, $3) returning *`,
    [id, userId, credentialDir]
  );
  return mapXhsAccount(rows[0]);
}

// 扫码成功回填 open_id；unique(user_id, open_id) 冲突（23505）映射为 XHS_ACCOUNT_DUPLICATE。
async function bindXhsAccountOpenId(userId, id, { openId, nickname } = {}) {
  try {
    const { rows } = await query(
      `update slenk_notes_xhs_accounts set open_id = $3, nickname = $4, updated_at = now()
       where user_id = $1 and id = $2 returning *`,
      [userId, id, openId ?? null, nickname ?? '']
    );
    return rows[0] ? mapXhsAccount(rows[0]) : null;
  } catch (error) {
    if (error?.code === '23505') {
      const mapped = new Error('XHS 账号已绑定');
      mapped.code = 'XHS_ACCOUNT_DUPLICATE';
      throw mapped;
    }
    throw error;
  }
}

async function findXhsAccountByOpenId(userId, openId) {
  const { rows } = await query(
    'select * from slenk_notes_xhs_accounts where user_id = $1 and open_id = $2',
    [userId, openId]
  );
  return rows[0] ? mapXhsAccount(rows[0]) : null;
}

// 返回被删行（含 credential_dir）供上层清理磁盘凭证目录；不存在或跨用户返回 null。
async function deleteXhsAccount(userId, id) {
  const { rows } = await query(
    'delete from slenk_notes_xhs_accounts where user_id = $1 and id = $2 returning *',
    [userId, id]
  );
  return rows[0] ? mapXhsAccount(rows[0]) : null;
}

// 改名：仅当前用户，返回更新后行；不存在或跨用户返回 null。空字符串表示清除昵称。
async function updateXhsAccountNickname(userId, id, nickname) {
  const { rows } = await query(
    'update slenk_notes_xhs_accounts set nickname = $3, updated_at = now() where user_id = $1 and id = $2 returning *',
    [userId, id, nickname]
  );
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
  listXhsAccounts,
  getXhsAccount,
  createXhsAccountPending,
  bindXhsAccountOpenId,
  findXhsAccountByOpenId,
  deleteXhsAccount,
  updateXhsAccountNickname,
  listAllXhsAccounts
};
