// 小红书半自动发布：校验入参 → 建任务 → 入 xhs-publish 队列（worker 串行执行）。
import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import { addTask, updateTask, listTasks } from '../store.js';
import { verify } from '../auth.js';
import { buildMiniToolZip } from '../lib/minitoolBuild.js';
import { uploadPackage, createPreview } from '../lib/redappCli.js';
import { authManager } from './redappAuth.js';

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

    // worker 没跑时任务会永远卡在排队中，提交前直接拦截报错。
    const workers = await publishQueue.getWorkers().catch(() => []);
    if (!workers.length) return res.status(503).json({ error: '发布 worker 未运行，请先启动：npm run dev:queue' });

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

// 小工具渠道：笔记打包成离线 zip → redapp 上传 → 预览二维码。同步请求，整体约 30~60 秒。
const AUDIT_SCRIPT = path.join(os.homedir(), '.claude', 'skills', 'minitool-zip-builder', 'scripts', 'audit_artifact.mjs');

function runAudit(target) {
  if (!fs.existsSync(AUDIT_SCRIPT)) return { target, output: '（审计脚本不存在，未运行）' };
  const r = spawnSync(process.execPath, [AUDIT_SCRIPT, target], { encoding: 'utf8', timeout: 60000 });
  return { target, output: String(r.stdout || '') + String(r.stderr || '') };
}

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const FAILED_JOB_ERROR = '扫码直达发布失败，请重新提交';

export function createMiniToolPublishJobRegistry({
  terminalTtlMs = 30 * 60 * 1000,
  maxEntries = 100,
  now = Date.now,
  cleanupIntervalMs = 60 * 1000
} = {}) {
  const jobs = new Map();
  const keyFor = (userId, attemptId) => `${userId}\u0000${attemptId}`;

  function cleanup() {
    const current = now();
    for (const [key, job] of jobs) {
      if (job.status !== 'running' && current - job.finishedAt >= terminalTtlMs) jobs.delete(key);
    }
    if (jobs.size <= maxEntries) return;
    const terminal = [...jobs.entries()]
      .filter(([, job]) => job.status !== 'running')
      .sort((a, b) => a[1].finishedAt - b[1].finishedAt);
    while (jobs.size > maxEntries && terminal.length) jobs.delete(terminal.shift()[0]);
  }

  function createOrReuse(userId, attemptId, operation) {
    cleanup();
    const key = keyFor(userId, attemptId);
    const existing = jobs.get(key);
    if (existing) return existing;
    if (jobs.size >= maxEntries) {
      cleanup();
      if (jobs.size >= maxEntries) {
        throw Object.assign(new Error('publish_job_capacity'), { code: 'PUBLISH_JOB_CAPACITY' });
      }
    }
    const job = { userId, attemptId, status: 'running', result: null, finishedAt: null, promise: null };
    jobs.set(key, job);
    job.promise = Promise.resolve()
      .then(operation)
      .then(result => {
        job.status = 'done';
        job.result = result;
        job.finishedAt = now();
      }, () => {
        job.status = 'failed';
        job.result = null;
        job.finishedAt = now();
      })
      .finally(cleanup);
    return job;
  }

  function get(userId, attemptId) {
    cleanup();
    return jobs.get(keyFor(userId, attemptId)) || null;
  }

  function toDto(job) {
    if (!job) return null;
    if (job.status === 'done') return { attemptId: job.attemptId, status: 'done', ...job.result };
    if (job.status === 'failed') return { attemptId: job.attemptId, status: 'failed', error: FAILED_JOB_ERROR };
    return { attemptId: job.attemptId, status: 'running' };
  }

  const timer = setInterval(cleanup, cleanupIntervalMs);
  timer.unref?.();
  return {
    createOrReuse,
    get,
    toDto,
    cleanup,
    dispose: () => clearInterval(timer),
    get size() { return jobs.size; }
  };
}

export const miniToolPublishJobs = createMiniToolPublishJobRegistry();

function validAttemptId(value) {
  return typeof value === 'string' && ATTEMPT_ID_PATTERN.test(value);
}

export function createMiniToolPublishHandler({
  authManager,
  registry = miniToolPublishJobs,
  buildMiniToolZip,
  runAudit,
  uploadPackage,
  createPreview,
  readQrImage = qrPath => qrPath && fs.existsSync(qrPath)
    ? 'data:image/png;base64,' + fs.readFileSync(qrPath).toString('base64')
    : null
}) {
  return async (req, res, next) => {
    try {
      const title = String(req.body?.title || '').trim();
      const content = String(req.body?.content || '').trim();
      const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
      const images = (Array.isArray(req.body?.images) ? req.body.images : []).map(String).filter(Boolean).slice(0, 9);
      if (!images.length) return res.status(400).json({ error: '发布需要至少 1 张图片（最多 9 张）' });
      if (!title && !content) return res.status(400).json({ error: '标题和正文至少填一项' });

      const auth = await authManager.getStatus();
      if (!auth.available) {
        return res.status(503).json({ error: auth.error || 'redapp CLI 不可用', code: 'REDAPP_UNAVAILABLE' });
      }
      if (!auth.loggedIn || auth.needsReauth) {
        return res.status(401).json({
          error: '需要连接小红书后继续',
          code: 'AUTH_REQUIRED',
          auth: await authManager.startLogin()
        });
      }

      const attemptId = req.body?.attemptId;
      if (!validAttemptId(attemptId)) return res.status(400).json({ error: '无效的发布尝试标识' });
      const userId = req.user?.userId;
      const job = registry.createOrReuse(userId, attemptId, async () => {
        const buildId = nanoid(12);
        const built = await buildMiniToolZip({ buildId, title, content, tags, imageUrls: images });
        const audits = [runAudit(built.dir), runAudit(built.zipPath)];
        const auditLog = audits.map(a => `[${path.basename(a.target)}]\n${String(a.output || '').trim()}`).join('\n');
        if (/^ERROR/m.test(audits[1].output)) throw new Error('artifact_audit_failed');
        const uploaded = await uploadPackage(built.zipPath);
        const qrOut = path.join(path.dirname(built.zipPath), `${buildId}-qr.png`);
        const preview = await createPreview({ fileId: uploaded.fileId, md5: uploaded.md5, qrOut });
        const qrPath = preview.qrCodePath || qrOut;
        return {
          ok: true,
          qrImage: readQrImage(qrPath),
          previewUrl: preview.previewUrl || '',
          package: { size: built.size, imageCount: built.imageCount },
          audit: auditLog
        };
      });
      const dto = registry.toDto(job);
      return res.status(dto.status === 'running' ? 202 : 200).json(dto);
    } catch (err) {
      if (err?.code === 'PUBLISH_JOB_CAPACITY') {
        return res.status(503).json({ error: '发布任务繁忙，请稍后重试', code: 'PUBLISH_JOB_CAPACITY' });
      }
      next(err);
    }
  };
}

export function createMiniToolJobHandler({ registry = miniToolPublishJobs } = {}) {
  return (req, res) => {
    const attemptId = req.params?.attemptId;
    if (!validAttemptId(attemptId)) return res.status(400).json({ error: '无效的发布尝试标识' });
    const job = registry.get(req.user?.userId, attemptId);
    if (!job) return res.status(404).json({ error: '发布任务不存在' });
    return res.json(registry.toDto(job));
  };
}

export function createMiniToolPublishRouter({ verify: verifyMiddleware, registry = miniToolPublishJobs, ...dependencies }) {
  const miniRouter = Router();
  miniRouter.use(verifyMiddleware);
  miniRouter.post('/', createMiniToolPublishHandler({ registry, ...dependencies }));
  miniRouter.get('/jobs/:attemptId', createMiniToolJobHandler({ registry }));
  return miniRouter;
}

export const miniToolPublishHandler = createMiniToolPublishHandler({
  authManager,
  registry: miniToolPublishJobs,
  buildMiniToolZip,
  runAudit,
  uploadPackage,
  createPreview
});

router.post('/minitool', miniToolPublishHandler);
router.get('/minitool/jobs/:attemptId', createMiniToolJobHandler({ registry: miniToolPublishJobs }));
