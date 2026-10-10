import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = process.env.STORAGE_PATH || path.resolve(root, '../storage');
const dbPath = path.resolve(dataDir, 'app.json');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const DEFAULT = { users: [], tasks: [] };
function read() {
  if (!fs.existsSync(dbPath)) return DEFAULT;
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}
function write(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}
function findUserByUsername(username) { return read().users.find(u => u.username === username) || null; }
function findUserById(id) { return read().users.find(u => u.id === id) || null; }
function ensureAdmin() {
  const data = read();
  if (!data.users.find(u => u.username === 'admin')) {
    data.users.push({ id: 'admin', username: 'admin', passwordHash: bcrypt.hashSync('123456', 10), createdAt: new Date().toISOString() });
    write(data);
  }
}
function addTask(task) {
  const data = read();
  data.tasks.unshift(task);
  write(data);
  return task;
}
function listTasks(userId, limit = 50) {
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

export { ensureAdmin, findUserByUsername, addTask, listTasks, getTask, updateTask, dataDir };
