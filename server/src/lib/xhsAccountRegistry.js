// 小红书账号绑定注册表：封装 slenk_notes_xhs_accounts 的读写与匹配逻辑。
// 纯逻辑层，store 函数以依赖注入传入；凭证目录路径生成与磁盘删除均默认可注入，便于测试与隔离。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.js';

// 默认凭证目录：storage/auth/<userId>/<accountId>/，可用 SLENK_XHS_AUTH_ROOT 覆盖（安装包场景）。
function defaultGenerateCredentialDir(userId, accountId) {
  const authRoot = process.env.SLENK_XHS_AUTH_ROOT || path.join(paths.root, 'storage', 'auth');
  return path.join(authRoot, String(userId), String(accountId));
}

function defaultGenerateAccountId() {
  return `acct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// force 使目录不存在时静默成功，避免重复解绑报错。
// 必须用 promises.rm（返回 Promise）——fs.rm 不带回调会以 undefined 回调抛 TypeError 崩溃进程。
function defaultRemoveCredentialDir(dir) {
  return fs.promises.rm(dir, { recursive: true, force: true });
}

export function createXhsAccountRegistry({
  listForUser,
  getForUser,
  createPendingForUser,
  bindOpenIdForUser,
  findByOpenIdForUser,
  deleteForUser,
  resolveCredentialDir,
  generateAccountId = defaultGenerateAccountId,
  generateCredentialDir = defaultGenerateCredentialDir,
  removeCredentialDir = defaultRemoveCredentialDir
} = {}) {
  // 发布前解析凭证目录，校验归属；待绑定账号同样可解析（用于发起登录）。无归属返回 null。
  async function resolveDir(userId, accountId) {
    if (resolveCredentialDir) return resolveCredentialDir(userId, accountId);
    const account = await getForUser(userId, accountId);
    return account ? account.credentialDir : null;
  }

  // 插入待绑定行；credentialDir 未给时由服务端生成（不依赖用户输入），id 亦由服务端生成。
  async function createPending(userId, { credentialDir, accountId } = {}) {
    const id = accountId ?? generateAccountId();
    const dir = credentialDir ?? generateCredentialDir(userId, id);
    return createPendingForUser(userId, { id, credentialDir: dir });
  }

  // 仅删除属于该用户的绑定；deleteCredentials 为 true（默认）时同时删除磁盘凭证目录。
  async function remove(userId, accountId, { deleteCredentials = true } = {}) {
    const deleted = await deleteForUser(userId, accountId);
    if (!deleted) return false;
    if (deleteCredentials && deleted.credentialDir) {
      await removeCredentialDir(deleted.credentialDir);
    }
    return true;
  }

  return {
    listForUser,
    getForUser,
    createPendingForUser: createPending,
    bindOpenIdForUser,
    findByOpenIdForUser,
    deleteForUser: remove,
    resolveCredentialDir: resolveDir
  };
}
