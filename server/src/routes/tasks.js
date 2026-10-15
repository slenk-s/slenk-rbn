import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import { addTask, getTask, listTasks, deleteTask, updateTask, getActiveProvider } from '../store.js';
import { paths } from '../paths.js';
import { verify } from '../auth.js';

const conn = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: null });
export const queue = new Queue('ai-tasks', { connection: conn });

function typeLabel(type) {
  if (type === 'image') return 'Image';
  if (type === 'video') return 'Video';
  if (type === 'rewrite') return 'Text';
  return String(type || 'Task');
}

export async function enqueueTask(type, payload, userId, tab) {
  const mode = type === 'rewrite' ? 'text' : 'image';
  const input = payload || {};
  const sourceTab = input.tab || tab || null;
  const aiPayload = { ...input };
  delete aiPayload.tab;
  const active = await getActiveProvider(mode, userId);
  const taskPayload = { ...aiPayload, providerId: aiPayload.providerId || active?.id || null };
  const id = nanoid(16);
  const now = new Date().toISOString();
  const sameTypeCount = (await listTasks(userId)).filter(t => t.type === type).length + 1;
  await addTask({
    id,
    userId,
    type,
    label: `${typeLabel(type)}${sameTypeCount}`,
    status: 'queued',
    payload: taskPayload,
    providerId: taskPayload.providerId,
    tab: sourceTab,
    createdAt: now,
    updatedAt: now
  });
  try {
    await queue.add(type, { id, payload: taskPayload, userId }, { removeOnComplete: 100, removeOnFail: 100 });
    return { id, status: 'queued' };
  } catch (err) {
    await updateTask(id, { status: 'failed', error: JSON.stringify({ error: err.message, code: 'redis_queue_error' }) });
    throw err;
  }
}

export const router = Router();
router.use(verify);

router.post('/', async (req,res)=> {
  try {
    res.json(await enqueueTask(req.body.type, req.body.payload, req.user.userId, req.body.tab));
  } catch (err) {
    res.status(503).json({ error: err.message || 'queue_error' });
  }
});
router.get('/', async (req, res, next) => {
  try {
    res.json({ tasks: await listTasks(req.user.userId) });
  } catch (err) {
    next(err);
  }
});
router.get('/:id', async (req, res, next) => {
  try {
    const item = await getTask(req.user.userId, req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json({ task: item });
  } catch (err) {
    next(err);
  }
});
router.delete('/:id', async (req, res, next) => {
  try {
    const removed = await deleteTask(req.user.userId, req.params.id);
    if (!removed) return res.status(404).json({ error: 'task_not_found' });
    res.json({ ok: true, tasks: await listTasks(req.user.userId) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/download', async (req, res, next) => {
  try {
    const item = await getTask(req.user.userId, req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    const format = req.query.format === 'video' ? 'video' : req.query.format === 'image' ? 'image' : 'text';
    const ext = format === 'video' ? 'mp4' : format === 'image' ? 'png' : 'txt';
    const name = /\.[a-z0-9]+$/i.test(String(req.query.name || ''))
      ? String(req.query.name)
      : String(req.query.name || req.params.id + '-' + item.type) + '.' + ext;

    const parsed = item.result && typeof item.result === 'object' ? item.result : {};

    if (format === 'text') {
      const text = parsed.text ?? (typeof item.result === 'string' ? item.result : '');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + name.replace(/"/g, '') + '"');
      return res.send(text);
    }

    const mediaUrl = format === 'video' ? (parsed.video || '') : (parsed.image || parsed.images?.[0] || '');
    if (!mediaUrl) return res.status(404).json({ error: 'no_media' });
    const base = mediaUrl.startsWith('/uploads/')
      ? paths.uploadsDir
      : mediaUrl.startsWith('/videos/')
        ? paths.videosDir
        : null;
    if (!base) return res.status(400).json({ error: 'bad_media_url' });
    const target = path.resolve(base, path.basename(mediaUrl));
    if (!target.startsWith(base) || !fs.existsSync(target)) return res.status(404).json({ error: 'media_missing' });
    return res.download(target, name);
  } catch (err) {
    next(err);
  }
});

