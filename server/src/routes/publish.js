// 小红书半自动发布：草稿队列 + 扫码直达的有界异步作业系统。
import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import { addTask, updateTask, listTasks } from '../store.js';
import { verify } from '../auth.js';
import { paths } from '../paths.js';
import { buildMiniToolZip, cleanupMiniToolArtifacts, effectiveMiniToolTitle, MINITOOL_CONTENT_MAX } from '../lib/minitoolBuild.js';
import { createAsyncProcessRunner, createPreviewAsync, readRedappQrFile, uploadPackageAsync } from '../lib/redappCli.js';
import { authManager } from './redappAuth.js';

const conn = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: null });
export const publishQueue = new Queue('xhs-publish', { connection: conn });
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
    if (mine.find(t => t.type === 'publish' && ACTIVE_STATUS.has(t.status))) return res.status(409).json({ error: '你还有一个发布任务在进行中，请先完成或等待它结束' });
    const workers = await publishQueue.getWorkers().catch(() => []);
    if (!workers.length) return res.status(503).json({ error: '发布 worker 未运行，请先启动：npm run dev:queue' });
    const id = nanoid(16);
    const payload = { taskId: id, title: title.slice(0, 100), content: content.slice(0, 1000), images, noteId: req.body?.noteId || null, noteTitle: String(req.body?.noteTitle || title || '未命名笔记').slice(0, 100) };
    await addTask({ id, userId: req.user.userId, type: 'publish', label: '小红书发布' + (mine.filter(t => t.type === 'publish').length + 1), status: 'queued', payload, providerId: null, tab: 'note-rewrite' });
    try { await publishQueue.add('publish', { id, payload, userId: req.user.userId }, { removeOnComplete: 100, removeOnFail: 100 }); }
    catch (err) {
      await updateTask(req.user.userId, id, { status: 'failed', error: JSON.stringify({ error: err.message || 'queue_error', code: 'redis_queue_error' }) });
      return res.status(503).json({ error: '任务队列不可用，请确认 Redis 已启动' });
    }
    res.json({ id, status: 'queued' });
  } catch (err) { next(err); }
});

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const FAILED_JOB_ERROR = '扫码直达发布失败，请重新提交';
const AUDIT_SCRIPT = path.join(paths.root, '.skills', 'minitool-zip-builder', 'scripts', 'audit_artifact.mjs');
const runNodeAsync = createAsyncProcessRunner();

function invalid(message = '发布参数无效') { throw Object.assign(new Error(message), { code: 'PUBLISH_VALIDATION' }); }
function canonicalTag(value) { return value.trim().replace(/^#+/, '').trim(); }
function allowedImage(value) { return /^https?:\/\//i.test(value) || /^\/(uploads|notes-images|videos)\/[A-Za-z0-9._~!$&'()+,;=@%-]+$/.test(value); }

export function canonicalizeMiniToolPublishRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  if (typeof body.attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(body.attemptId)) invalid('无效的发布尝试标识');
  if (typeof body.title !== 'string' || body.title.length > 100) invalid();
  if (typeof body.content !== 'string' || body.content.length > MINITOOL_CONTENT_MAX) invalid();
  if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some(t => typeof t !== 'string' || t.length > 40)) invalid();
  if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > 9 || body.images.some(i => typeof i !== 'string' || i.length > 8192 || !allowedImage(i))) invalid();
  const request = {
    title: effectiveMiniToolTitle(body.title),
    content: body.content.trim(),
    tags: body.tags.map(canonicalTag).filter(Boolean),
    images: [...body.images]
  };
  if (!request.title && !request.content) invalid('标题和正文至少填一项');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return { attemptId: body.attemptId, request, fingerprint };
}

export function createArtifactAuditor({ scriptPath = AUDIT_SCRIPT, scriptExists = fs.existsSync, runProcess = runNodeAsync } = {}) {
  return async function audit(target, { signal } = {}) {
    if (!scriptExists(scriptPath)) throw new Error('artifact_audit_failed');
    const result = await runProcess([scriptPath, target], 120_000, { signal });
    const output = String(result?.stdout || '') + '\n' + String(result?.stderr || '');
    if (result?.error || result?.status !== 0 || /(^|\n)ERROR\b/.test(output) || !/(^|\n)PASS\b/.test(output)) throw new Error('artifact_audit_failed');
    return { status: 'passed' };
  };
}
export const runAudit = createArtifactAuditor();

// 只保留可对账的 fileId/md5，绝不透出路径、原始 CLI 输出或其他回执字段。
function sanitizeUploadReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const safe = {};
  if (typeof receipt.fileId === 'string' && receipt.fileId) safe.fileId = receipt.fileId.slice(0, 4096);
  if (typeof receipt.md5 === 'string' && receipt.md5) safe.md5 = receipt.md5.slice(0, 128);
  return Object.keys(safe).length ? safe : null;
}

export function createMiniToolPublishJobRegistry({
  terminalTtlMs = 30 * 60 * 1000, maxEntries = 100, maxConcurrent = 2, perUserLimit = 1,
  jobDeadlineMs = 30 * 60 * 1000, maxAliasesPerJob = 8, now = Date.now,
  cleanupIntervalMs = 60_000, setTimer = setTimeout, clearTimer = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval
} = {}) {
  const aliases = new Map();
  const fingerprints = new Map();
  const jobs = new Set();
  const queue = [];
  let active = 0;
  let disposed = false;
  const keyFor = (userId, value) => `${userId}\0${value}`;
  const countUser = userId => [...jobs].filter(j => j.userId === userId && (j.status === 'queued' || j.status === 'running')).length;

  function remove(job) {
    jobs.delete(job);
    for (const alias of job.aliases) aliases.delete(keyFor(job.userId, alias));
    if (fingerprints.get(keyFor(job.userId, job.fingerprint)) === job) fingerprints.delete(keyFor(job.userId, job.fingerprint));
  }
  // failed_after_side_effect 墓碑的生命周期：永不按 TTL 或容量淘汰（淘汰会让同指纹重新上传，
  // 正是该状态要防止的事故）；只能由属主显式 acknowledgeUnknown 退役。
  // 总量仍受 maxEntries 约束——极端情况下所有槽位都是墓碑时，新任务以 PUBLISH_JOB_CAPACITY 关闭，绝不误删墓碑。
  function cleanup() {
    const current = now();
    for (const job of [...jobs]) if (['done', 'failed'].includes(job.status) && current - job.finishedAt >= terminalTtlMs) remove(job);
    if (jobs.size > maxEntries) {
      const terminal = [...jobs].filter(j => ['done', 'failed'].includes(j.status)).sort((a, b) => a.finishedAt - b.finishedAt);
      while (jobs.size > maxEntries && terminal.length) remove(terminal.shift());
    }
  }
  function resolveCompletion(job) {
    if (job.completionResolved) return;
    job.completionResolved = true;
    job.resolveCompletion?.(job);
  }
  function releaseSlot(job) {
    if (job.slotReleased) return;
    job.slotReleased = true;
    active--;
    startNext(); cleanup();
  }
  function finish(job, status, result = null) {
    if (job.status !== 'running') return;
    clearTimer(job.deadlineTimer);
    job.deadlineTimer = null;
    job.status = status;
    job.result = status === 'done' ? result : null;
    job.finishedAt = now();
    resolveCompletion(job);
  }
  function start(job) {
    if (disposed || job.status !== 'queued') return;
    active++;
    clearTimer(job.queueTimer);
    job.queueTimer = null;
    job.status = 'running';
    job.controller = new AbortController();
    job.deadlineTimer = setTimer(() => {
      if (job.status !== 'running') return;
      job.controller.abort(new Error('publish_job_deadline'));
      finish(job, job.sideEffectStarted ? 'failed_after_side_effect' : 'failed');
    }, jobDeadlineMs);
    job.deadlineTimer?.unref?.();
    job.executionPromise = Promise.resolve().then(() => job.operation({
      signal: job.controller.signal,
      markSideEffectStarted: receipt => { job.sideEffectStarted = true; job.uploadReceipt = receipt || null; }
    })).then(
      result => finish(job, 'done', result),
      () => finish(job, job.sideEffectStarted ? 'failed_after_side_effect' : 'failed')
    ).finally(() => {
      if (job.status === 'failed' && fingerprints.get(keyFor(job.userId, job.fingerprint)) === job) fingerprints.delete(keyFor(job.userId, job.fingerprint));
      releaseSlot(job);
    });
  }
  function startNext() { while (!disposed && active < maxConcurrent && queue.length) start(queue.shift()); }
  function createOrReuse(userId, attemptId, fingerprint, operation) {
    if (typeof fingerprint === 'function' && operation === undefined) {
      operation = fingerprint;
      fingerprint = `legacy:${attemptId}`;
    }
    if (disposed) throw Object.assign(new Error('publish_job_disposed'), { code: 'PUBLISH_JOB_CAPACITY' });
    cleanup();
    const aliasKey = keyFor(userId, attemptId);
    const byAlias = aliases.get(aliasKey);
    if (byAlias) {
      if (byAlias.fingerprint !== fingerprint) throw Object.assign(new Error('publish_attempt_conflict'), { code: 'PUBLISH_ATTEMPT_CONFLICT' });
      return byAlias;
    }
    const fingerprintKey = keyFor(userId, fingerprint);
    const byFingerprint = fingerprints.get(fingerprintKey);
    if (byFingerprint && byFingerprint.status !== 'failed') {
      if (byFingerprint.aliases.size >= maxAliasesPerJob) {
        throw Object.assign(new Error('publish_alias_capacity'), { code: 'PUBLISH_ALIAS_CAPACITY' });
      }
      byFingerprint.aliases.add(attemptId); aliases.set(aliasKey, byFingerprint);
      return byFingerprint;
    }
    if (jobs.size >= maxEntries) {
      const evictable = [...jobs].filter(j => ['done', 'failed'].includes(j.status)).sort((a, b) => a.finishedAt - b.finishedAt);
      if (evictable.length) remove(evictable[0]);
    }
    if (jobs.size >= maxEntries) throw Object.assign(new Error('publish_job_capacity'), { code: 'PUBLISH_JOB_CAPACITY' });
    if (countUser(userId) >= perUserLimit) throw Object.assign(new Error('publish_user_limit'), { code: 'PUBLISH_USER_LIMIT' });
    const completion = {};
    completion.promise = new Promise(resolve => { completion.resolve = resolve; });
    const job = { userId, canonicalAttemptId: attemptId, fingerprint, aliases: new Set([attemptId]), status: 'queued', result: null, finishedAt: null, operation, controller: null, queueTimer: null, deadlineTimer: null, executionPromise: null, promise: completion.promise, resolveCompletion: completion.resolve, completionResolved: false, slotReleased: false, sideEffectStarted: false, uploadReceipt: null };
    job.queueTimer = setTimer(() => {
      if (job.status !== 'queued') return;
      const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
      job.status = 'failed'; job.finishedAt = now(); resolveCompletion(job);
      if (fingerprints.get(fingerprintKey) === job) fingerprints.delete(fingerprintKey);
    }, jobDeadlineMs);
    job.queueTimer?.unref?.();
    jobs.add(job); aliases.set(aliasKey, job); fingerprints.set(fingerprintKey, job); queue.push(job); startNext();
    return job;
  }
  function get(userId, attemptId) { cleanup(); return aliases.get(keyFor(userId, attemptId)) || null; }
  function getByFingerprint(userId, fingerprint) { cleanup(); return fingerprints.get(keyFor(userId, fingerprint)) || null; }
  function acknowledgeUnknown(userId, attemptId) {
    const job = aliases.get(keyFor(userId, attemptId));
    if (!job || job.status !== 'failed_after_side_effect') return false;
    remove(job);
    return true;
  }
  function toDto(job, requestedAttemptId = job?.canonicalAttemptId) {
    if (!job) return null;
    const identity = requestedAttemptId === job.canonicalAttemptId
      ? { attemptId: job.canonicalAttemptId }
      : { attemptId: job.canonicalAttemptId, requestedAttemptId };
    if (job.status === 'done') {
      const dto = { ...job.result, ...identity, status: 'done' };
      if (!('requestedAttemptId' in identity)) delete dto.requestedAttemptId;
      return dto;
    }
    if (job.status === 'failed_after_side_effect') {
      const dto = { ...identity, status: 'failed_after_side_effect', error: '上传结果无法安全重试，请先核对小红书预览记录' };
      const receipt = sanitizeUploadReceipt(job.uploadReceipt);
      if (receipt) dto.uploadReceipt = receipt;
      return dto;
    }
    if (job.status === 'failed') return { ...identity, status: 'failed', error: FAILED_JOB_ERROR };
    return { ...identity, status: job.status };
  }
  const timer = setIntervalFn(cleanup, cleanupIntervalMs); timer?.unref?.();
  function dispose() {
    if (disposed) return; disposed = true; clearIntervalFn(timer); queue.length = 0;
    for (const job of jobs) {
      if (job.status === 'running') { job.controller?.abort(new Error('publish_job_disposed')); clearTimer(job.deadlineTimer); job.deadlineTimer = null; job.status = 'failed'; job.result = null; job.finishedAt = now(); resolveCompletion(job); }
      else if (job.status === 'queued') { clearTimer(job.queueTimer); job.queueTimer = null; job.status = 'failed'; job.finishedAt = now(); resolveCompletion(job); }
    }
  }
  return { createOrReuse, get, getByFingerprint, acknowledgeUnknown, toDto, cleanup, dispose, get size() { return jobs.size; } };
}

export const miniToolPublishJobs = createMiniToolPublishJobRegistry();
function qrData(readQrImage, candidates) {
  const unique = [...new Set(candidates.filter(Boolean).map(candidate => path.resolve(candidate)))];
  for (const candidate of unique) {
    try {
      const value = readQrImage(candidate);
      if (typeof value === 'string') return value;
      if (Buffer.isBuffer(value)) return 'data:image/png;base64,' + value.toString('base64');
    } catch {}
  }
  return null;
}

export function createMiniToolPublishHandler({
  authManager, registry = miniToolPublishJobs, buildMiniToolZip, runAudit, uploadPackage, createPreview,
  readQrImage = readRedappQrFile, cleanupArtifacts = cleanupMiniToolArtifacts
}) {
  return async (req, res, next) => {
    let validated;
    try { validated = canonicalizeMiniToolPublishRequest(req.body); }
    catch { return res.status(400).json({ error: '发布参数无效', code: 'PUBLISH_VALIDATION' }); }
    try {
      const { attemptId, request, fingerprint } = validated;
      const existing = registry.get(req.user?.userId, attemptId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw Object.assign(new Error('publish_attempt_conflict'), { code: 'PUBLISH_ATTEMPT_CONFLICT' });
        const dto = registry.toDto(existing, attemptId);
        return res.status(dto.status === 'queued' || dto.status === 'running' ? 202 : 200).json(dto);
      }
      const retained = registry.getByFingerprint?.(req.user?.userId, fingerprint);
      if (retained && retained.status !== 'failed') {
        const reused = registry.createOrReuse(req.user?.userId, attemptId, fingerprint, async () => null);
        const dto = registry.toDto(reused, attemptId);
        return res.status(dto.status === 'queued' || dto.status === 'running' ? 202 : 200).json(dto);
      }
      const auth = await authManager.getStatus();
      if (!auth.available) return res.status(503).json({ error: auth.error || 'redapp CLI 不可用', code: 'REDAPP_UNAVAILABLE' });
      if (!auth.loggedIn || auth.needsReauth) return res.status(401).json({ error: '需要连接小红书后继续', code: 'AUTH_REQUIRED', auth: await authManager.startLogin() });
      const job = registry.createOrReuse(req.user?.userId, attemptId, fingerprint, async ({ signal, markSideEffectStarted }) => {
        const buildId = nanoid(12);
        try {
          const built = await buildMiniToolZip({ buildId, title: request.title, content: request.content, tags: request.tags, imageUrls: request.images, signal });
          await runAudit(built.dir, { signal });
          await runAudit(built.zipPath, { signal });
          const uploaded = await uploadPackage(built.zipPath, { signal, onBeforeConfirm: markSideEffectStarted });
          markSideEffectStarted(uploaded);
          const qrOut = path.join(path.dirname(built.zipPath), `${buildId}-qr.png`);
          const preview = await createPreview({ fileId: uploaded.fileId, md5: uploaded.md5, qrOut, signal });
          const expectedQr = path.resolve(qrOut);
          const reportedQr = typeof preview.qrCodePath === 'string' && path.resolve(preview.qrCodePath) === expectedQr ? preview.qrCodePath : null;
          return {
            ok: true,
            qrImage: qrData(readQrImage, [reportedQr, qrOut]),
            previewUrl: typeof preview.previewUrl === 'string' ? preview.previewUrl.slice(0, 4096) : '',
            package: { size: built.size, imageCount: built.imageCount },
            audit: { directory: 'passed', zip: 'passed' }
          };
        } finally {
          try { cleanupArtifacts(buildId); }
          catch { /* deferred startup janitor owns locked leftovers; never alter the publish DTO */ }
        }
      });
      const dto = registry.toDto(job, attemptId);
      return res.status(dto.status === 'queued' || dto.status === 'running' ? 202 : 200).json(dto);
    } catch (err) {
      if (err?.code === 'PUBLISH_ATTEMPT_CONFLICT') return res.status(409).json({ error: '发布尝试标识已用于其他内容', code: err.code });
      if (err?.code === 'PUBLISH_USER_LIMIT') return res.status(429).json({ error: '你已有发布任务正在处理', code: err.code });
      if (err?.code === 'PUBLISH_ALIAS_CAPACITY') return res.status(409).json({ error: '相同内容的恢复标识已达上限，请使用已存在的发布任务查询结果', code: err.code });
      if (err?.code === 'PUBLISH_JOB_CAPACITY') return res.status(503).json({ error: '发布任务繁忙，请稍后重试', code: err.code });
      next(err);
    }
  };
}

export function createMiniToolJobHandler({ registry = miniToolPublishJobs } = {}) {
  return (req, res) => {
    const attemptId = req.params?.attemptId;
    if (typeof attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(attemptId)) return res.status(400).json({ error: '无效的发布尝试标识' });
    const job = registry.get(req.user?.userId, attemptId);
    if (!job) return res.status(404).json({ error: '发布任务不存在' });
    return res.json(registry.toDto(job, attemptId));
  };
}
export function createMiniToolUnknownAcknowledgeHandler({ registry = miniToolPublishJobs } = {}) {
  return (req, res) => {
    const attemptId = req.params?.attemptId;
    if (typeof attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(attemptId)) return res.status(400).json({ error: '无效的发布尝试标识' });
    if (!registry.acknowledgeUnknown?.(req.user?.userId, attemptId)) return res.status(404).json({ error: '待确认的发布任务不存在' });
    return res.json({ acknowledged: true });
  };
}
export function createMiniToolPublishRouter({ verify: verifyMiddleware, registry = miniToolPublishJobs, ...dependencies }) {
  const miniRouter = Router(); miniRouter.use(verifyMiddleware);
  miniRouter.post('/', createMiniToolPublishHandler({ registry, ...dependencies }));
  miniRouter.get('/jobs/:attemptId', createMiniToolJobHandler({ registry }));
  miniRouter.post('/jobs/:attemptId/acknowledge-unknown', createMiniToolUnknownAcknowledgeHandler({ registry }));
  return miniRouter;
}
export const miniToolPublishHandler = createMiniToolPublishHandler({ authManager, registry: miniToolPublishJobs, buildMiniToolZip, runAudit, uploadPackage: uploadPackageAsync, createPreview: createPreviewAsync });
router.post('/minitool', miniToolPublishHandler);
router.get('/minitool/jobs/:attemptId', createMiniToolJobHandler({ registry: miniToolPublishJobs }));
router.post('/minitool/jobs/:attemptId/acknowledge-unknown', createMiniToolUnknownAcknowledgeHandler({ registry: miniToolPublishJobs }));
