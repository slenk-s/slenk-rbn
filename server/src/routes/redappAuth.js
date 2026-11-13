import { Router } from 'express';
import { verify as defaultVerify } from '../auth.js';
import { createRedappAuthManager } from '../lib/redappAuth.js';
import { readRedappQrFile, runRedappCommandAsync, spawnRedappLogin } from '../lib/redappCli.js';
import { createXhsAccountRegistry } from '../lib/xhsAccountRegistry.js';
import { matchLoginToAccount } from '../lib/xhsAccountMatcher.js';
import {
  listXhsAccounts,
  getXhsAccount,
  createXhsAccountPending,
  bindXhsAccountOpenId,
  findXhsAccountByOpenId,
  deleteXhsAccount
} from '../store.js';

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createRedappAuthRouter({ authManager, verify = defaultVerify }) {
  const router = Router();
  router.use(verify);
  router.get('/', asyncRoute(async (req, res) => res.json(await authManager.getStatus())));
  router.post('/login', asyncRoute(async (req, res) => res.json(await authManager.startLogin())));
  router.get('/session/:id', asyncRoute(async (req, res) => {
    const session = await authManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    return res.json(session);
  }));
  router.post('/session/:id/cancel', asyncRoute(async (req, res) => {
    const session = await authManager.cancelLogin(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    return res.json(session);
  }));
  router.post('/logout', asyncRoute(async (req, res) => res.json(await authManager.logout())));
  return router;
}

// 生产态注册表：封装 store 的读写与凭证目录生命周期，供扫码自动匹配器使用。
const xhsAccountRegistry = createXhsAccountRegistry({
  listForUser: listXhsAccounts,
  getForUser: getXhsAccount,
  createPendingForUser: createXhsAccountPending,
  bindOpenIdForUser: bindXhsAccountOpenId,
  findByOpenIdForUser: findXhsAccountByOpenId,
  deleteForUser: deleteXhsAccount
});

export const authManager = createRedappAuthManager({
  spawnCli: spawnRedappLogin,
  runCli: runRedappCommandAsync,
  readFile: readRedappQrFile,
  // 登录成功后扫码自动匹配：把 openId 绑定到发起登录的账号槽位；结果由管理器写入会话 auth.match。
  onLoginDone: info => matchLoginToAccount({ ...info, registry: xhsAccountRegistry })
});

export const router = createRedappAuthRouter({ authManager });
