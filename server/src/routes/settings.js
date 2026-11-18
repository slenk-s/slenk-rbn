import { Router } from 'express';
import fs from 'node:fs';
import { verify, requireAdmin } from '../auth.js';
import { getEffectiveDb, getDbConfigPath, testConnection, getPool, invalidateDbConfigCache } from '../db.js';

// 本地存储模式（默认；SLENK_DATA_BACKEND 未设置或 =local）：无 MySQL 连接，连接管理接口不适用。
const isLocalBackend = process.env.SLENK_DATA_BACKEND !== 'mysql';

export const router = Router();
router.use(verify);
router.use(requireAdmin);

export function validateBody(body) {
  const host = String(body?.host || '').trim();
  const user = String(body?.user || '').trim();
  const database = String(body?.database || '').trim();
  const port = Number(body?.port ?? 3306);
  if (!host) return { error: 'host_required' };
  if (!user) return { error: 'user_required' };
  if (!database) return { error: 'database_required' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'invalid_port' };
  return { config: { host, port, user, password: String(body?.password ?? ''), database } };
}

// GET 当前有效连接（绝不返回密码）。本地模式返回 local 标记，前端据此隐藏表单。
router.get('/db', (req, res, next) => {
  try {
    if (isLocalBackend) return res.json({ storage: 'local', source: 'local' });
    const { config, source } = getEffectiveDb();
    res.json({
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      passwordSet: Boolean(config.password),
      source
    });
  } catch (err) { next(err); }
});

// POST 测试连接：校验后建一次性池 SELECT 1，不落盘；密码留空=用当前。
router.post('/db/test', async (req, res, next) => {
  try {
    if (isLocalBackend) return res.status(400).json({ error: 'local_storage' });
    const v = validateBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const current = getEffectiveDb().config;
    const password = v.config.password || current.password;
    const result = await testConnection({ ...v.config, password });
    if (!result.ok) return res.status(400).json({ error: 'connection_failed', detail: result.error });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST 保存：先校验连通性，通过才写 db.json；写后失效缓存并触发一次预重连。
// 已运行中的 server/worker 各自在下次 DB 访问时自动换池（无重启）。
router.post('/db', async (req, res, next) => {
  try {
    if (isLocalBackend) return res.status(400).json({ error: 'local_storage' });
    const v = validateBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const current = getEffectiveDb().config;
    const candidate = { ...v.config, password: v.config.password || current.password };
    const result = await testConnection(candidate);
    if (!result.ok) return res.status(400).json({ error: 'connection_failed', detail: result.error });
    fs.writeFileSync(getDbConfigPath(), JSON.stringify(candidate, null, 2) + '\n', 'utf8');
    invalidateDbConfigCache();
    void getPool().catch(err => console.error('[db] reconnect after save failed:', err.message));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE 重置：删 db.json，回退 .env。
router.delete('/db', (req, res, next) => {
  try {
    if (isLocalBackend) return res.status(400).json({ error: 'local_storage' });
    const file = getDbConfigPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    invalidateDbConfigCache();
    void getPool().catch(err => console.error('[db] reconnect after reset failed:', err.message));
    res.json({ ok: true });
  } catch (err) { next(err); }
});
