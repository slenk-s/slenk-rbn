// store.local.js — 本地 JSON 文件存储后端（SLENK_DATA_BACKEND=local）
//
// 不用 MySQL：每张"表"一个 JSON 文件（storage/local/<table>.json），媒体（原 LONGBLOB）存
// storage/local/media/<id> 文件 + media.json 元数据。导出接口与 store.mysql.js 完全一致，
// 由 store.js 按 SLENK_DATA_BACKEND 选择，routes / worker / auth 等调用方零改动。
//
// 跨进程一致性（关键）：server 与 worker 是两个独立进程，不做内存缓存，每次操作读最新文件，
// "文件即真相"。本地文件规模小（数千条），每次 JSON.parse 开销可接受；/api/tasks 轮询除外
// 另有 listAllTasks 单函数承担。
//
// 时间戳与 MySQL UTC_TIMESTAMP(3) 格式一致（'YYYY-MM-DD HH:MM:SS.mmm'，UTC 无时区后缀），
// 保证前端 new Date() 的解析行为与 MySQL 后端完全相同。

import bcrypt from 'bcryptjs';
import './loadEnv.js';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { scheduleSyncProvidersUsers } from './syncTiDB.js';

const localDir = path.join(paths.dataDir, 'local');
const mediaDir = path.join(localDir, 'media');
const mediaMetaFile = path.join(localDir, 'media.json');

// ---- 文件读写（每表一个 JSON 文件；无内存缓存） ----

function ensureDirs() {
  fs.mkdirSync(mediaDir, { recursive: true });
}

function tableFile(table) {
  return path.join(localDir, `${table}.json`);
}

function loadTable(table) {
  try {
    return JSON.parse(fs.readFileSync(tableFile(table), 'utf8'));
  } catch {
    return [];
  }
}

function saveTable(table, rows) {
  fs.writeFileSync(tableFile(table), JSON.stringify(rows));
}

function loadMediaMeta() {
  try {
    return JSON.parse(fs.readFileSync(mediaMetaFile, 'utf8'));
  } catch {
    return [];
  }
}

function saveMediaMeta(meta) {
  fs.writeFileSync(mediaMetaFile, JSON.stringify(meta));
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// 与 MySQL UTC_TIMESTAMP(3) 同格式：'YYYY-MM-DD HH:MM:SS.mmm'（UTC，无 Z）。
function nowUtc() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

// ---- 映射（与 store.mysql.js 一致，行结构即列名） ----

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at
  };
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

// ---- 用户 ----

let adminEnsured = false;
async function ensureAdmin() {
  ensureDirs();
  // 启动同步一次：把当前本地供应商/用户镜像到 TiDB（幂等；TIDB_PG_URL 未配置则空转）。
  scheduleSyncProvidersUsers();
  if (adminEnsured) return;
  const users = loadTable('users');
  const exists = users.some(u => u.username === 'admin');
  if (exists) { adminEnsured = true; return; }
  const id = uid('user');
  users.push({ id, username: 'admin', password_hash: bcrypt.hashSync('123456', 10), is_admin: true, created_at: nowUtc() });
  saveTable('users', users);
  const settings = loadTable('user_settings');
  if (!settings.some(s => s.user_id === id)) settings.push({ user_id: id, active_provider_id: null, active_text_provider_id: null, active_image_provider_id: null });
  saveTable('user_settings', settings);
  adminEnsured = true;
}

async function findUserByUsername(username) {
  const row = loadTable('users').find(u => u.username === username);
  return row ? mapUser(row) : null;
}

async function findUserById(id) {
  const row = loadTable('users').find(u => u.id === id);
  return row ? mapUser(row) : null;
}

async function createUser({ username, passwordHash, isAdmin = false }) {
  const id = uid('user');
  const users = loadTable('users');
  users.push({ id, username: String(username).trim(), password_hash: String(passwordHash), is_admin: Boolean(isAdmin), created_at: nowUtc() });
  saveTable('users', users);
  const settings = loadTable('user_settings');
  if (!settings.some(s => s.user_id === id)) settings.push({ user_id: id, active_provider_id: null, active_text_provider_id: null, active_image_provider_id: null });
  saveTable('user_settings', settings);
  scheduleSyncProvidersUsers();
  return mapUser(users.find(u => u.id === id));
}

async function listUsers() {
  const users = loadTable('users');
  const notes = loadTable('notes');
  const tasks = loadTable('tasks');
  return users
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(u => ({
      id: u.id,
      username: u.username,
      isAdmin: Boolean(u.is_admin),
      createdAt: u.created_at,
      noteCount: notes.filter(n => n.user_id === u.id).length,
      taskCount: tasks.filter(t => t.user_id === u.id).length
    }));
}

async function updateUser(id, patch = {}) {
  const users = loadTable('users');
  const row = users.find(u => u.id === id);
  if (!row) return null;
  if ('passwordHash' in patch) row.password_hash = patch.passwordHash;
  if ('isAdmin' in patch) row.is_admin = Boolean(patch.isAdmin);
  saveTable('users', users);
  scheduleSyncProvidersUsers();
  return mapUser(row);
}

async function deleteUser(id) {
  const users = loadTable('users');
  const before = users.length;
  const next = users.filter(u => u.id !== id);
  if (next.length === before) return false;
  saveTable('users', next);
  scheduleSyncProvidersUsers();
  return true;
}

// ---- 任务 ----

async function addTask(task) {
  const tasks = loadTable('tasks');
  const row = {
    id: task.id,
    user_id: task.userId,
    type: task.type,
    label: task.label ?? null,
    status: task.status ?? 'queued',
    payload: task.payload ?? null,
    provider_id: task.providerId ?? null,
    tab: task.tab ?? null,
    result: task.result ?? null,
    error: task.error ?? null,
    created_at: nowUtc(),
    updated_at: nowUtc()
  };
  tasks.push(row);
  saveTable('tasks', tasks);
  return mapTask(row);
}

async function listTasks(userId, limit = 100) {
  return loadTable('tasks')
    .filter(t => t.user_id === userId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map(mapTask);
}

async function countTasksByType(userId, type, tab) {
  return loadTable('tasks').filter(t =>
    t.user_id === userId && t.type === type &&
    (type !== 'image' || (t.tab ?? '') === (tab ?? ''))
  ).length;
}

async function listAllTasks(limit = 200) {
  const users = new Map(loadTable('users').map(u => [u.id, u.username]));
  return loadTable('tasks')
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit)
    .map(t => mapTaskListRow({
      id: t.id, user_id: t.user_id, username: users.get(t.user_id) || null,
      type: t.type, label: t.label, status: t.status, tab: t.tab,
      provider_id: t.provider_id, created_at: t.created_at, updated_at: t.updated_at,
      error: t.error,
      note_id: t.payload?.noteId ?? null, note_title: t.payload?.noteTitle ?? null,
      purpose: t.payload?.purpose ?? null
    }));
}

async function getTask(userId, id) {
  const row = loadTable('tasks').find(t => t.user_id === userId && t.id === id);
  return row ? mapTask(row) : null;
}

async function getTaskById(id) {
  const users = new Map(loadTable('users').map(u => [u.id, u.username]));
  const row = loadTable('tasks').find(t => t.id === id);
  return row ? mapTask({ ...row, username: users.get(row.user_id) || null }) : null;
}

// worker 在任务不在库（迁移前入队）时带 insertMeta 补插；本地后端同样实现。
async function updateTask(userId, id, patch, insertMeta) {
  const tasks = loadTable('tasks');
  let row = tasks.find(t => t.user_id === userId && t.id === id);
  if (!row && insertMeta) {
    row = {
      id, user_id: userId,
      type: insertMeta.type ?? 'task',
      status: patch.status ?? 'queued',
      label: patch.label ?? insertMeta.label ?? null,
      payload: insertMeta.payload !== undefined ? insertMeta.payload : null,
      provider_id: insertMeta.providerId ?? null,
      tab: insertMeta.tab ?? null,
      result: 'result' in patch ? patch.result : null,
      error: patch.error ?? null,
      created_at: nowUtc(),
      updated_at: nowUtc()
    };
    tasks.push(row);
  } else if (row) {
    if ('status' in patch) row.status = patch.status;
    if ('result' in patch) row.result = patch.result;
    if ('error' in patch) row.error = patch.error;
    if ('label' in patch) row.label = patch.label;
    row.updated_at = nowUtc();
  }
  if (!row) return null;
  saveTable('tasks', tasks);
  return mapTask(row);
}

async function deleteTask(userId, id) {
  const tasks = loadTable('tasks');
  const before = tasks.length;
  const next = tasks.filter(t => !(t.user_id === userId && t.id === id));
  if (next.length === before) return false;
  saveTable('tasks', next);
  return true;
}

async function deleteTaskById(id) {
  const tasks = loadTable('tasks');
  const before = tasks.length;
  const next = tasks.filter(t => t.id !== id);
  if (next.length === before) return false;
  saveTable('tasks', next);
  return true;
}

async function deleteTasksByIds(ids, userId, isAdmin) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const idSet = new Set(ids);
  const tasks = loadTable('tasks');
  const before = tasks.length;
  const next = tasks.filter(t =>
    idSet.has(t.id) && (isAdmin || t.user_id === userId) ? false : true
  );
  const removed = before - next.length;
  if (removed) saveTable('tasks', next);
  return removed;
}

// ---- 供应商 ----

function providerValues(input = {}, id) {
  return {
    id: id || uid('prov'),
    name: String(input.name || 'Custom Provider').trim() || 'Custom Provider',
    provider_type: String(input.providerType || 'openai-compatible').trim() || 'openai-compatible',
    app_type: String(input.appType || 'openai').trim() || 'openai',
    base_url: String(input.baseUrl || '').trim().replace(/\/$/, ''),
    api_key: String(input.apiKey || '').trim(),
    mode: String(input.mode || 'image').trim() || 'image',
    text_model: String(input.textModel || '').trim(),
    image_model: String(input.imageModel || '').trim(),
    image_api: input.imageApi === 'form' ? 'form' : 'json',
    notes: String(input.notes || ''),
    is_active: Boolean(input.active)
  };
}

async function listProviders() {
  return loadTable('providers')
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
    .map(r => withMaskedKey(mapProvider(r)));
}

async function getProviderById(id) {
  const row = loadTable('providers').find(p => p.id === id);
  return row ? withMaskedKey(mapProvider(row)) : null;
}

async function getProviderUnmaskedById(id) {
  const row = loadTable('providers').find(p => p.id === id);
  return row ? mapProvider(row) : null;
}

async function addProvider(input) {
  const p = providerValues(input);
  const providers = loadTable('providers');
  const row = { ...p, created_at: nowUtc(), updated_at: nowUtc() };
  providers.push(row);
  saveTable('providers', providers);
  scheduleSyncProvidersUsers();
  return withMaskedKey(mapProvider(row));
}

async function updateProvider(id, input) {
  const providers = loadTable('providers');
  const existing = providers.find(p => p.id === id);
  if (!existing) return null;
  const p = providerValues({ ...mapProvider(existing), ...input }, id);
  if (!p.api_key || p.api_key === maskApiKey(existing.api_key)) p.api_key = existing.api_key;
  Object.assign(existing, p, { updated_at: nowUtc() });
  saveTable('providers', providers);
  scheduleSyncProvidersUsers();
  return withMaskedKey(mapProvider(existing));
}

async function deleteProvider(id) {
  const providers = loadTable('providers');
  const before = providers.length;
  const next = providers.filter(p => p.id !== id);
  if (next.length === before) return false;
  saveTable('providers', next);
  const settings = loadTable('user_settings');
  let changed = false;
  for (const s of settings) {
    if (s.active_provider_id === id) { s.active_provider_id = null; changed = true; }
    if (s.active_text_provider_id === id) { s.active_text_provider_id = null; changed = true; }
    if (s.active_image_provider_id === id) { s.active_image_provider_id = null; changed = true; }
  }
  if (changed) saveTable('user_settings', settings);
  scheduleSyncProvidersUsers();
  return true;
}

async function getActiveProvider(mode, userId) {
  const settings = await getActiveProviderIds(userId);
  const preferredId = mode === 'text' ? settings.activeTextProviderId
    : mode === 'image' ? settings.activeImageProviderId
    : settings.activeProviderId;
  const providers = loadTable('providers');
  const byId = providers.find(p => p.id === preferredId);
  if (byId) return mapProvider(byId);
  const byMode = providers
    .filter(p => p.mode === mode)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0];
  if (byMode) return mapProvider(byMode);
  const any = providers
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0];
  return any ? mapProvider(any) : null;
}

async function setActiveProvider(providerId, mode, userId) {
  const column = mode === 'text' ? 'active_text_provider_id'
    : mode === 'image' ? 'active_image_provider_id'
    : 'active_provider_id';
  const settings = loadTable('user_settings');
  let s = settings.find(x => x.user_id === userId);
  if (!s) {
    s = { user_id: userId, active_provider_id: null, active_text_provider_id: null, active_image_provider_id: null };
    settings.push(s);
  }
  s[column] = providerId;
  saveTable('user_settings', settings);
}

async function getActiveProviderIds(userId) {
  const s = loadTable('user_settings').find(x => x.user_id === userId) || {};
  return {
    activeProviderId: s.active_provider_id ?? null,
    activeTextProviderId: s.active_text_provider_id ?? null,
    activeImageProviderId: s.active_image_provider_id ?? null
  };
}

// ---- 笔记 ----

async function saveNote(userId, note = {}) {
  const id = uid('note');
  const notes = loadTable('notes');
  const row = {
    id, user_id: userId,
    title: String(note.title || ''), content: String(note.content || ''),
    tags: Array.isArray(note.tags) ? note.tags : [],
    images: Array.isArray(note.images) ? note.images : [],
    created_at: nowUtc()
  };
  notes.push(row);
  saveTable('notes', notes);
  return mapNote(row);
}

async function getNote(id) {
  const row = loadTable('notes').find(n => n.id === id);
  return row ? mapNote(row) : null;
}

// ---- XHS 账号（user_id 强制隔离） ----

async function listXhsAccounts(userId) {
  return loadTable('xhs_accounts')
    .filter(a => a.user_id === userId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(mapXhsAccount);
}

async function getXhsAccount(userId, id) {
  const row = loadTable('xhs_accounts').find(a => a.user_id === userId && a.id === id);
  return row ? mapXhsAccount(row) : null;
}

async function createXhsAccountPending(userId, { id, credentialDir }) {
  const accounts = loadTable('xhs_accounts');
  const row = { id, user_id: userId, credential_dir: credentialDir, open_id: null, nickname: null, created_at: nowUtc(), updated_at: nowUtc() };
  accounts.push(row);
  saveTable('xhs_accounts', accounts);
  return mapXhsAccount(row);
}

async function bindXhsAccountOpenId(userId, id, { openId, nickname } = {}) {
  const accounts = loadTable('xhs_accounts');
  const row = accounts.find(a => a.user_id === userId && a.id === id);
  if (!row) return null;
  // unique(user_id, open_id)：同用户另一账号已有该 openId → 冲突。
  const dup = accounts.some(a => a.user_id === userId && a.id !== id && a.open_id === openId);
  if (dup) {
    const mapped = new Error('XHS 账号已绑定');
    mapped.code = 'XHS_ACCOUNT_DUPLICATE';
    throw mapped;
  }
  row.open_id = openId ?? null;
  row.nickname = nickname ?? '';
  row.updated_at = nowUtc();
  saveTable('xhs_accounts', accounts);
  return mapXhsAccount(row);
}

async function findXhsAccountByOpenId(userId, openId) {
  const row = loadTable('xhs_accounts').find(a => a.user_id === userId && a.open_id === openId);
  return row ? mapXhsAccount(row) : null;
}

async function deleteXhsAccount(userId, id) {
  const accounts = loadTable('xhs_accounts');
  const row = accounts.find(a => a.user_id === userId && a.id === id);
  if (!row) return null;
  saveTable('xhs_accounts', accounts.filter(a => !(a.user_id === userId && a.id === id)));
  return mapXhsAccount(row);
}

async function updateXhsAccountNickname(userId, id, nickname) {
  const accounts = loadTable('xhs_accounts');
  const row = accounts.find(a => a.user_id === userId && a.id === id);
  if (!row) return null;
  row.nickname = nickname;
  row.updated_at = nowUtc();
  saveTable('xhs_accounts', accounts);
  return mapXhsAccount(row);
}

async function listAllXhsAccounts() {
  const rows = loadTable('xhs_accounts')
    .slice()
    .sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)) || String(b.created_at).localeCompare(String(a.created_at)));
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

// ---- 媒体（原 MySQL LONGBLOB → storage/local/media/<id> 文件） ----

async function insertMedia({ id, taskId, userId, filename, mimeType, data }) {
  ensureDirs();
  fs.writeFileSync(path.join(mediaDir, id), data);
  const meta = loadMediaMeta();
  meta.push({ id, task_id: taskId ?? null, user_id: userId, filename, mime_type: mimeType, size_bytes: data.length });
  saveMediaMeta(meta);
  return id;
}

async function getMedia(id) {
  const row = loadMediaMeta().find(m => m.id === id);
  if (!row) return null;
  let data;
  try {
    data = fs.readFileSync(path.join(mediaDir, id));
  } catch {
    return null;
  }
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

// ---- cacheJanitor 用 ----

async function getAllNotesImagesForJanitor() {
  return loadTable('notes').map(n => n.images);
}

async function getAllTasksPayloadForJanitor() {
  return loadTable('tasks').map(t => t.payload);
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
  listAllXhsAccounts,
  getAllNotesImagesForJanitor,
  getAllTasksPayloadForJanitor
};
