import fs from 'node:fs';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

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
  activeImageProviderId: null
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

function findUserByUsername(username) {
  return read().users.find(u => u.username === username) || null;
}

function findUserById(id) {
  return read().users.find(u => u.id === id) || null;
}

function ensureAdmin() {
  const data = read();
  if (!data.users.find(u => u.username === 'admin')) {
    data.users.push({ id: 'admin', username: 'admin', passwordHash: bcrypt.hashSync('123456', 10), createdAt: new Date().toISOString() });
    write(data);
  }
  return data;
}

function addTask(task) {
  const data = read();
  data.tasks.unshift(task);
  write(data);
  return task;
}

function listTasks(userId, limit = 100) {
  return read().tasks.filter(t => t.userId === userId).slice(0, limit);
}

function getTask(userId, id) {
  return read().tasks.find(t => t.userId === userId && t.id === id) || null;
}

function updateTask(id, patch) {
  const data = read();
  const task = data.tasks.find(t => t.id === id);
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  write(data);
  return task;
}

function deleteTask(userId, id) {
  const data = read();
  const before = data.tasks.length;
  data.tasks = data.tasks.filter(t => !(t.id === id && t.userId === userId));
  write(data);
  return data.tasks.length < before;
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

function setActiveProvider(id, mode) {
  const data = read();
  if (!data.providers.find(p => p.id === id)) return null;
  if (mode === 'text') {
    data.activeTextProviderId = id;
  } else if (mode === 'image') {
    data.activeImageProviderId = id;
  } else {
    data.activeProviderId = id;
  }
  write(data);
  return getProviderById(id);
}

function getActiveProviderIds() {
  const data = read();
  return {
    activeProviderId: data.activeProviderId || null,
    activeTextProviderId: data.activeTextProviderId || null,
    activeImageProviderId: data.activeImageProviderId || null
  };
}

export {
  ensureAdmin,
  findUserByUsername,
  findUserById,
  addTask,
  listTasks,
  getTask,
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
  dataDir
};
