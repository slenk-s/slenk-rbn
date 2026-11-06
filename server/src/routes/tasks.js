import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import { addTask, getTask, getTaskById, listTasks, listAllTasks, deleteTask, deleteTaskById, deleteTasksByIds, updateTask, getActiveProvider, findUserById } from '../store.js';
import { paths } from '../paths.js';
import { verify } from '../auth.js';

const conn = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: null });
export const queue = new Queue('ai-tasks', { connection: conn });

// 队列共享上面这个连接，queue.close() 关不掉它；测试需要自己断开，否则进程退不出去。
export async function closeQueue() {
  await Promise.allSettled([queue.close(), conn.quit()]);
}

function typeLabel(type) {
  if (type === 'image') return 'AI生图';
  if (type === 'video') return '实况视频';
  if (type === 'rewrite') return '文案改写';
  return String(type || '任务');
}

function taskName(type, payload, tab) {
  const purpose = payload && payload.purpose;
  if (purpose === 'title') return '标题生成';
  if (purpose === 'content') return '正文生成';
  if (purpose === 'tags') return '话题标签生成';
  if (purpose === 'noteImage') return '配图生成';
  // 图片任务按来源页签命名：替换生图与 AI 生图共用一个 type=image。
  if (type === 'image' && tab === 'replace-image') return '替换生图';
  return typeLabel(type);
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
  const sameTypeCount = (await listTasks(userId))
    .filter(t => t.type === type && (type !== 'image' || (t.tab || null) === sourceTab))
    .length + 1;
  await addTask({
    id,
    userId,
    type,
    label: `${taskName(type, payload, sourceTab)}${sameTypeCount}`,
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
    const queueError = Object.assign(new Error(err.message || 'queue_error'), { code: 'redis_queue_error', cause: err });
    await updateTask(userId, id, { status: 'failed', error: JSON.stringify({ error: queueError.message, code: queueError.code }) });
    throw queueError;
  }
}

export const router = Router();
router.use(verify);

router.post('/', async (req, res, next) => {
  try {
    res.json(await enqueueTask(req.body.type, req.body.payload, req.user.userId, req.body.tab));
  } catch (err) {
    if (err.code === 'redis_queue_error') return res.status(503).json({ error: err.message || 'queue_error' });
    next(err);
  }
});
router.get('/', async (req, res, next) => {
  try {
    // 任务结果全站共享：任何登录用户都能看到所有人的任务。
    res.json({ tasks: await listAllTasks() });
  } catch (err) {
    next(err);
  }
});
router.get('/:id', async (req, res, next) => {
  try {
    const item = await getTaskById(req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json({ task: item });
  } catch (err) {
    next(err);
  }
});
// 批量删除：与单个删除同一套权限——本人可删自己的，管理员可删任何人的；
// 普通用户混入他人 id 时静默跳过，返回实际删除条数。
router.post('/batch-delete', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean).slice(0, 200) : [];
    if (!ids.length) return res.status(400).json({ error: 'missing_ids' });
    const me = await findUserById(req.user.userId);
    const deleted = await deleteTasksByIds(ids, req.user.userId, Boolean(me?.isAdmin));
    res.json({ ok: true, deleted, tasks: await listAllTasks() });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    // 共享可见但删除受限：只有本人或管理员能删。
    const item = await getTaskById(req.params.id);
    if (!item) return res.status(404).json({ error: 'task_not_found' });
    let removed = false;
    if (item.userId === req.user.userId) {
      removed = await deleteTask(req.user.userId, req.params.id);
    } else {
      const me = await findUserById(req.user.userId);
      if (!me?.isAdmin) return res.status(403).json({ error: 'not_task_owner' });
      removed = await deleteTaskById(req.params.id);
    }
    if (!removed) return res.status(404).json({ error: 'task_not_found' });
    res.json({ ok: true, tasks: await listAllTasks() });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/download', async (req, res, next) => {
  try {
    const item = await getTaskById(req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    const format = req.query.format === 'video' ? 'video' : req.query.format === 'image' ? 'image' : 'text';
    const ext = format === 'video' ? 'mp4' : format === 'image' ? 'png' : 'txt';
    const name = /\.[a-z0-9]+$/i.test(String(req.query.name || ''))
      ? String(req.query.name)
      : String(req.query.name || req.params.id + '-' + item.type) + '.' + ext;

    const parsed = item.result && typeof item.result === 'object' ? item.result : {};

    if (format === 'text') {
      const text = parsed.text ?? (typeof item.result === 'string' ? item.result : JSON.stringify(parsed, null, 2));
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + name.replace(/"/g, '') + '"');
      return res.send(text);
    }

    const mediaUrl = format === 'video' ? (parsed.video || '') : (parsed.image || parsed.images?.[0] || '');
    if (!mediaUrl) return res.status(404).json({ error: 'no_media' });
    // 云端 URL（Supabase Storage 公网地址）：服务端拉回字节再转发，保住附件下载的文件名。
    if (/^https?:\/\//i.test(mediaUrl)) {
      const upstream = await fetch(mediaUrl);
      if (!upstream.ok) return res.status(502).json({ error: 'upstream_fetch_failed' });
      res.setHeader('Content-Type', upstream.headers.get('content-type') || (format === 'video' ? 'video/mp4' : 'image/png'));
      res.setHeader('Content-Disposition', 'attachment; filename="' + name.replace(/"/g, '') + '"');
      return res.send(Buffer.from(await upstream.arrayBuffer()));
    }
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

