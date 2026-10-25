import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePool } from '../src/db.js';
import { addTask, listTasks, getTask, updateTask, deleteTask } from '../src/store.js';
import { enqueueTask, queue, closeQueue } from '../src/routes/tasks.js';
import { createTestUser, dropTestUser } from './helpers.mjs';

// 引入 routes/tasks.js 会连上 Redis 起 BullMQ 队列；不显式断开的话 node --test 永远退不出来。
after(() => Promise.allSettled([closePool(), closeQueue()]));

function seed(userId, id) {
  return addTask({
    id, userId, type: 'image', label: 'Image1', status: 'queued',
    payload: { prompt: 'hello' }, providerId: 'prov_x', tab: 'ai-image'
  });
}

test('addTask stores payload as a jsonb object', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const task = await seed(userId, 'task_a');
  assert.deepEqual(task.payload, { prompt: 'hello' });
  const loaded = await getTask(userId, 'task_a');
  assert.deepEqual(loaded.payload, { prompt: 'hello' });
});

test('tasks are isolated per user', async (t) => {
  const a = await createTestUser();
  t.after(() => dropTestUser(a));
  const b = await createTestUser();
  t.after(() => dropTestUser(b));
  await seed(a, 'task_a');
  assert.equal((await listTasks(a)).length, 1);
  assert.equal((await listTasks(b)).length, 0);
  assert.equal(await getTask(b, 'task_a'), null);
  assert.equal(await deleteTask(b, 'task_a'), false);
  assert.equal(await deleteTask(a, 'task_a'), true);
});

test('updateTask writes result, bumps updatedAt, and refuses another user', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const other = await createTestUser();
  t.after(() => dropTestUser(other));
  await seed(userId, 'task_a');
  const before = await getTask(userId, 'task_a');
  await new Promise(resolve => setTimeout(resolve, 5));
  const updated = await updateTask(userId, 'task_a', { status: 'done', result: { images: ['/videos/x.png'] } });
  assert.equal(updated.status, 'done');
  assert.deepEqual(updated.result, { images: ['/videos/x.png'] });
  assert.ok(new Date(updated.updatedAt) > new Date(before.updatedAt));
  assert.equal(await updateTask(other, 'task_a', { status: 'failed', error: 'not yours' }), null);
  assert.equal((await getTask(userId, 'task_a')).status, 'done');
});

test('enqueueTask marks the task failed when the queue rejects', async (t) => {
  const userId = await createTestUser();
  t.after(() => dropTestUser(userId));
  const originalAdd = queue.add;
  t.after(() => { queue.add = originalAdd; });
  queue.add = async () => { throw new Error('redis down'); };
  await assert.rejects(
    enqueueTask('rewrite', { prompt: 'rewrite it', purpose: 'title' }, userId),
    err => err.code === 'redis_queue_error' && err.message === 'redis down'
  );
  const [task] = await listTasks(userId);
  assert.equal(task.status, 'failed');
  assert.equal(JSON.parse(task.error).code, 'redis_queue_error');
  assert.equal(task.label, '标题生成1');
});

