import './env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initStore, closeStore, createUser, deleteUser,
  addTask, listTasks, getTask, getTaskById, countTasksByType,
  listAllTasks, updateTask, deleteTask, deleteTaskById, deleteTasksByIds
} from '../src/store.sqlite.js';

after(async () => { await closeStore(); });

test('addTask/listTasks 保留 payload/result 的 JSON 结构', async () => {
  await initStore();
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'task_' + Math.random().toString(36).slice(2);
  await addTask({ id, userId: user.id, type: 'image', label: 'AI生图1', status: 'queued', payload: { prompt: 'x', noteId: 'n1' } });
  const list = await listTasks(user.id);
  assert.equal(list[0].id, id);
  assert.deepEqual(list[0].payload, { prompt: 'x', noteId: 'n1' });
  await updateTask(user.id, id, { status: 'done', result: { images: ['/api/media/a'] } });
  const detail = await getTask(user.id, id);
  assert.equal(detail.status, 'done');
  assert.deepEqual(detail.result, { images: ['/api/media/a'] });
  await deleteTask(user.id, id);
  await deleteUser(user.id);
});

test('countTasksByType 对 image 类型按 tab 区分', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  await addTask({ id: 't1_' + user.id, userId: user.id, type: 'image', tab: 'replace' });
  await addTask({ id: 't2_' + user.id, userId: user.id, type: 'image', tab: 'generate' });
  await addTask({ id: 't3_' + user.id, userId: user.id, type: 'video' });
  assert.equal(await countTasksByType(user.id, 'image', 'replace'), 1);
  assert.equal(await countTasksByType(user.id, 'image', 'generate'), 1);
  assert.equal(await countTasksByType(user.id, 'video', null), 1);
  await deleteUser(user.id);
});

test('listAllTasks 全站共享并带用户名与 note 字段', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  await addTask({ id: 't_' + user.id, userId: user.id, type: 'rewrite', label: 'Text1', payload: { noteId: 'n9', noteTitle: '标题', purpose: 'title' } });
  const all = await listAllTasks(50);
  const row = all.find(t => t.id === 't_' + user.id);
  assert.equal(row.username, user.username);
  assert.equal(row.noteId, 'n9');
  assert.equal(row.noteTitle, '标题');
  assert.equal(row.label, '标题生成1');
  await deleteUser(user.id);
});

test('updateTask 在行不存在且给了 insertMeta 时补插', async () => {
  const user = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const id = 'late_' + user.id;
  const saved = await updateTask(user.id, id, { status: 'done' }, {
    type: 'video', label: '实况视频1', payload: { images: [] }, providerId: 'prov_x', tab: 'video'
  });
  assert.equal(saved.id, id);
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.payload, { images: [] });
  assert.equal((await getTaskById(id)).status, 'done');
  await deleteUser(user.id);
});

test('删除接口按用户隔离，管理员批量删除可跨用户', async () => {
  const a = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  const b = await createUser({ username: 'u_' + Math.random().toString(36).slice(2), passwordHash: 'h' });
  await addTask({ id: 'a1_' + a.id, userId: a.id, type: 'image' });
  await addTask({ id: 'b1_' + b.id, userId: b.id, type: 'image' });
  assert.equal(await deleteTask(b.id, 'a1_' + a.id), false);
  assert.equal(await deleteTaskById('a1_' + a.id), true);
  assert.equal(await deleteTasksByIds(['b1_' + b.id], b.id, false), 1);
  await deleteUser(a.id);
  await deleteUser(b.id);
});
