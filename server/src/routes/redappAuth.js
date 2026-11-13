import { Router } from 'express';
import path from 'node:path';
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
  deleteXhsAccount,
  updateXhsAccountNickname,
  findUserById as storeFindUserById,
  listAllXhsAccounts as storeListAllXhsAccounts
} from '../store.js';

const MAX_NICKNAME_LENGTH = 40;

// 昵称必须是字符串、不超过 40 字；trim 后为空表示清除昵称。非法返回 null。
function normalizeNickname(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > MAX_NICKNAME_LENGTH) return null;
  return trimmed;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// 脱敏账号 DTO：status pending_bind/bound、openIdMasked、credentialDirHint（只给目录尾段）。
// 永不返回 accessToken/refreshToken/完整 openId/credentialDir 绝对路径。
function maskOpenId(openId) {
  if (typeof openId !== 'string' || openId.length === 0) return null;
  if (openId.length <= 8) return `${openId.slice(0, 2)}…`;
  return `${openId.slice(0, 4)}…${openId.slice(-4)}`;
}

function credentialDirHint(credentialDir) {
  if (typeof credentialDir !== 'string' || !credentialDir) return null;
  return `…/${path.basename(credentialDir)}`;
}

function toAccountDto(account, authStatus = {}) {
  return {
    id: account.id,
    status: account.openId ? 'bound' : 'pending_bind',
    openIdMasked: maskOpenId(account.openId),
    nickname: typeof account.nickname === 'string' ? account.nickname : '',
    credentialDirHint: credentialDirHint(account.credentialDir),
    loggedIn: authStatus.loggedIn === true,
    scope: Array.isArray(authStatus.scope) ? authStatus.scope.filter(item => typeof item === 'string') : [],
    expireTimeMs: Number.isFinite(authStatus.expireTimeMs) ? authStatus.expireTimeMs : null,
    needsReauth: authStatus.needsReauth === true,
    createdAt: account.createdAt ?? null
  };
}

// 合并该账号的授权状态（whoami）；状态机内部已把失败投影为不可用状态，此处再兜底一次。
async function mergeAuthStatus(authManager, userId, account) {
  try {
    return await authManager.getStatus(userId, account.id, account.credentialDir);
  } catch {
    return {};
  }
}

// 校验 accountId 属于当前用户；不属于返回 404 并写入响应，调用方以 null 提前返回。
async function requireOwnedAccount(accountRegistry, req, res) {
  const account = await accountRegistry.getForUser(req.user.userId, req.query.accountId);
  if (!account) {
    res.status(404).json({ error: 'XHS 账号不存在', code: 'XHS_ACCOUNT_NOT_FOUND' });
    return null;
  }
  return account;
}

// /api/redapp/auth/*：授权状态按账号，accountId 必带且必须属于当前用户。
export function createRedappAuthRouter({ authManager, accountRegistry = xhsAccountRegistry, verify = defaultVerify }) {
  const router = Router();
  router.use(verify);
  router.get('/', asyncRoute(async (req, res) => {
    const account = await requireOwnedAccount(accountRegistry, req, res);
    if (!account) return;
    res.json(await authManager.getStatus(req.user.userId, account.id, account.credentialDir));
  }));
  router.post('/login', asyncRoute(async (req, res) => {
    const account = await requireOwnedAccount(accountRegistry, req, res);
    if (!account) return;
    res.json(await authManager.startLogin(req.user.userId, account.id, account.credentialDir));
  }));
  router.get('/session/:id', asyncRoute(async (req, res) => {
    const account = await requireOwnedAccount(accountRegistry, req, res);
    if (!account) return;
    const session = await authManager.getSession(req.user.userId, account.id, req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    return res.json(session);
  }));
  router.post('/session/:id/cancel', asyncRoute(async (req, res) => {
    const account = await requireOwnedAccount(accountRegistry, req, res);
    if (!account) return;
    const session = await authManager.cancelLogin(req.user.userId, account.id, req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    return res.json(session);
  }));
  router.post('/logout', asyncRoute(async (req, res) => {
    const account = await requireOwnedAccount(accountRegistry, req, res);
    if (!account) return;
    res.json(await authManager.logout(req.user.userId, account.id, account.credentialDir));
  }));
  return router;
}

// /api/redapp/accounts 与 /api/redapp/admin/accounts：账号 CRUD + 管理员只读。
// 管理员判定复用既有模式：从数据库读回用户行校验 isAdmin（不信任 JWT 声明，非绕过）。
export function createRedappAccountsRouter({
  accountRegistry = xhsAccountRegistry,
  authManager,
  findUserById = storeFindUserById,
  listAllAccounts = storeListAllXhsAccounts,
  verify = defaultVerify
}) {
  const router = Router();
  router.use(verify);
  router.get('/accounts', asyncRoute(async (req, res) => {
    const accounts = await accountRegistry.listForUser(req.user.userId);
    const dtos = await Promise.all(accounts.map(account => mergeAuthStatus(authManager, req.user.userId, account).then(status => toAccountDto(account, status))));
    res.json(dtos);
  }));
  router.post('/accounts', asyncRoute(async (req, res) => {
    const account = await accountRegistry.createPendingForUser(req.user.userId, {});
    res.json({ id: account.id, status: 'pending_bind', credentialDirHint: credentialDirHint(account.credentialDir) });
  }));
  router.delete('/accounts/:id', asyncRoute(async (req, res) => {
    const deleteCredentials = req.query.deleteCredentials !== 'false';
    const deleted = await accountRegistry.deleteForUser(req.user.userId, req.params.id, { deleteCredentials });
    if (!deleted) return res.status(404).json({ error: 'XHS 账号不存在', code: 'XHS_ACCOUNT_NOT_FOUND' });
    return res.json({ deleted: true });
  }));
  router.patch('/accounts/:id', asyncRoute(async (req, res) => {
    const nickname = normalizeNickname(req.body?.nickname);
    if (nickname === null) return res.status(400).json({ error: '昵称需为不超过 40 字的字符串', code: 'XHS_NICKNAME_INVALID' });
    const account = await accountRegistry.renameForUser(req.user.userId, req.params.id, nickname);
    if (!account) return res.status(404).json({ error: 'XHS 账号不存在', code: 'XHS_ACCOUNT_NOT_FOUND' });
    return res.json(toAccountDto(account));
  }));
  router.get('/admin/accounts', asyncRoute(async (req, res) => {
    const user = await findUserById(req.user.userId);
    if (!user?.isAdmin) return res.status(403).json({ error: '需要管理员权限', code: 'XHS_ADMIN_REQUIRED' });
    const groups = await listAllAccounts();
    const result = await Promise.all(groups.map(async group => ({
      userId: group.userId,
      accounts: await Promise.all(group.accounts.map(account => mergeAuthStatus(authManager, group.userId, account).then(status => toAccountDto(account, status))))
    })));
    res.json(result);
  }));
  return router;
}

// 生产态注册表：封装 store 的读写与凭证目录生命周期，供扫码自动匹配器使用。
export const xhsAccountRegistry = createXhsAccountRegistry({
  listForUser: listXhsAccounts,
  getForUser: getXhsAccount,
  createPendingForUser: createXhsAccountPending,
  bindOpenIdForUser: bindXhsAccountOpenId,
  findByOpenIdForUser: findXhsAccountByOpenId,
  deleteForUser: deleteXhsAccount,
  renameForUser: updateXhsAccountNickname
});

export const authManager = createRedappAuthManager({
  spawnCli: spawnRedappLogin,
  runCli: runRedappCommandAsync,
  readFile: readRedappQrFile,
  // 登录成功后扫码自动匹配：把 openId 绑定到发起登录的账号槽位；结果由管理器写入会话 auth.match。
  onLoginDone: info => matchLoginToAccount({ ...info, registry: xhsAccountRegistry })
});

export const router = createRedappAuthRouter({ authManager });
export const accountsRouter = createRedappAccountsRouter({ authManager });
