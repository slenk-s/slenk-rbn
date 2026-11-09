// 小红书半自动发布：校验入参 → 建任务 → 入 xhs-publish 队列（worker 串行执行）。
import { Router } from 'express';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import { addTask, updateTask, listTasks } from '../store.js';
import { verify } from '../auth.js';

const conn = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: null });
export const publishQueue = new Queue('xhs-publish', { connection: conn });

// 队列里/浏览器里还挂着的发布状态；这些状态下不允许同一用户再提新任务。
const ACTIVE_STATUS = new Set(['queued', 'filling', 'waiting_login', 'waiting_confirm']);

export const router = Router();
router.use(verify);

router.post('/', async (req, res, next) => {
  try {
    const title = String(req.body?.title || '').trim();
    const content = String(req.body?.content || '').trim();
    const images = (Array.isArray(req.body?.images) ? req.body.images : []).map(String).filter(Boolean).slice(0, 9);
    if (!images.length) return res.status(400).json({ error: '发布需要至少 1 张图片（最多 9 张）' });
    if (!title && !content) return res.status(400).json({ error: '标题和正文至少填一项' });

    const mine = await listTasks(req.user.userId, 50);
    const running = mine.find(t => t.type === 'publish' && ACTIVE_STATUS.has(t.status));
    if (running) return res.status(409).json({ error: '你还有一个发布任务在进行中，请先完成或等待它结束' });

    const id = nanoid(16);
    const count = mine.filter(t => t.type === 'publish').length + 1;
    const payload = {
      taskId: id,
      title: title.slice(0, 100),
      content: content.slice(0, 1000),
      images,
      noteId: req.body?.noteId || null,
      noteTitle: String(req.body?.noteTitle || title || '未命名笔记').slice(0, 100)
    };
    await addTask({
      id,
      userId: req.user.userId,
      type: 'publish',
      label: '小红书发布' + count,
      status: 'queued',
      payload,
      providerId: null,
      tab: 'note-rewrite'
    });
    try {
      await publishQueue.add('publish', { id, payload, userId: req.user.userId }, { removeOnComplete: 100, removeOnFail: 100 });
    } catch (err) {
      await updateTask(req.user.userId, id, { status: 'failed', error: JSON.stringify({ error: err.message || 'queue_error', code: 'redis_queue_error' }) });
      return res.status(503).json({ error: '任务队列不可用，请确认 Redis 已启动' });
    }
    res.json({ id, status: 'queued' });
  } catch (err) {
    next(err);
  }
});
