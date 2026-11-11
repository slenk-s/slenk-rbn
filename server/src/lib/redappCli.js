// redapp CLI 服务端封装：每次先跑 ensure-cli 版本门禁（进程级 npm prefix 落在 storage 下，不污染全局），
// 再按 Skill 的 dry-run → confirm 两段式执行 upload / preview，解析 RESULT_JSON 回执。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { paths } from '../paths.js';

const SKILL_GATE = path.join(os.homedir(), '.claude', 'skills', 'redapp-cli', 'scripts', 'ensure-cli.mjs');
const NPM_HOME = path.join(paths.dataDir, 'redapp-npm');
const NPM_PREFIX = path.join(NPM_HOME, 'prefix');
const NPM_CACHE = path.join(NPM_HOME, 'cache');
const CLI_ENTRY = path.join(NPM_PREFIX, 'node_modules', 'redskillhub-upload', 'cli', 'redapp', 'index.mjs');

function npmEnv() {
  return {
    ...process.env,
    NPM_CONFIG_PREFIX: NPM_PREFIX,
    NPM_CONFIG_CACHE: NPM_CACHE,
    PATH: NPM_PREFIX + path.delimiter + process.env.PATH
  };
}

function spawnNode(args, timeoutMs) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: npmEnv(),
    windowsHide: true
  });
  return {
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: r.error || null
  };
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
}

function assignBoundedString(target, source, field, maxLength) {
  const value = boundedString(source[field], maxLength);
  if (value !== undefined) target[field] = value;
}

function sanitizePrompt(value) {
  if (!isRecord(value)) return {};
  const safe = {};
  assignBoundedString(safe, value, 'type', 256);
  assignBoundedString(safe, value, 'authorizeCommonUrl', 4096);
  assignBoundedString(safe, value, 'authorizeH5Url', 4096);
  assignBoundedString(safe, value, 'authorizeUrl', 4096);
  assignBoundedString(safe, value, 'userCode', 256);
  if (typeof value.expiresInSeconds === 'number'
      && Number.isFinite(value.expiresInSeconds)
      && value.expiresInSeconds >= 0) {
    safe.expiresInSeconds = value.expiresInSeconds;
  }
  assignBoundedString(safe, value, 'message', 4096);
  assignBoundedString(safe, value, 'qrCodePath', 4096);
  return safe;
}

function sanitizePlan(value) {
  if (!isRecord(value)) return {};
  const safe = {};
  assignBoundedString(safe, value, 'planHash', 512);
  return safe;
}

function sanitizeData(value) {
  if (!isRecord(value)) return {};
  const safe = {};
  assignBoundedString(safe, value, 'fileId', 4096);
  assignBoundedString(safe, value, 'md5', 128);
  assignBoundedString(safe, value, 'qrCodePath', 4096);
  assignBoundedString(safe, value, 'previewUrl', 4096);
  assignBoundedString(safe, value, 'qrError', 4096);
  return safe;
}

function sanitizeResult(value) {
  if (!isRecord(value)) return {};
  const safe = {};
  assignBoundedString(safe, value, 'status', 64);
  assignBoundedString(safe, value, 'command', 128);
  if (Object.hasOwn(value, 'credentials')) safe.credentials = sanitizeCredentials(value.credentials);
  if (isRecord(value.plan)) {
    const plan = sanitizePlan(value.plan);
    if (Object.hasOwn(plan, 'planHash')) safe.plan = plan;
  }
  if (isRecord(value.data)) safe.data = sanitizeData(value.data);
  return safe;
}

export function parseTaggedOutput(output) {
  const prompts = [];
  const results = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    for (const [tag, target, sanitize] of [
      ['PROMPT:', prompts, sanitizePrompt],
      ['RESULT_JSON:', results, sanitizeResult]
    ]) {
      if (!line.startsWith(tag)) continue;
      try { target.push(sanitize(JSON.parse(line.slice(tag.length)))); } catch {}
    }
  }
  return { prompts, results };
}

function maskOpenId(value) {
  const s = String(value || '');
  if (!s) return null;
  if (s.length === 1) return '…';
  if (s.length <= 4) return s.slice(0, 1) + '…';
  if (s.length <= 8) return s.slice(0, 2) + '…' + s.slice(-1);
  return s.slice(0, 4) + '…' + s.slice(-4);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeScope(value) {
  if (typeof value === 'string') {
    return value.split(',').map(scope => scope.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter(scope => typeof scope === 'string').map(scope => scope.trim()).filter(Boolean);
  }
  return [];
}

export function sanitizeCredentials(credentials = {}) {
  const source = isRecord(credentials) ? credentials : {};
  const loggedIn = source.loggedIn === true;
  const expireTimeMs = finiteNumberOrNull(source.expireTimeMs);
  return {
    available: true,
    loggedIn,
    openIdMasked: maskOpenId(typeof source.openId === 'string' ? source.openId : ''),
    scope: sanitizeScope(source.scope),
    expireTimeMs,
    refreshExpireTimeMs: finiteNumberOrNull(source.refreshExpireTimeMs),
    needsReauth: !loggedIn || (expireTimeMs !== null && expireTimeMs <= Date.now())
  };
}

function extractTaggedLine(output, tag) {
  const line = output.split(/\r?\n/).reverse().find(l => l.startsWith(tag + ':'));
  if (!line) return null;
  try { return JSON.parse(line.slice(tag.length + 1)); } catch { return null; }
}

// 版本门禁：只有 current / installed / updated 才算通过。
export function createRedappCliEnsurer({ gateExists, cliExists, prepareCache, executeGate }) {
  return function ensureCli() {
    if (!gateExists()) throw new Error('redapp-cli Skill 未安装');
    prepareCache();
    const r = executeGate();
    if (r.error || r.status !== 0) throw new Error('CLI 版本门禁执行失败');
    const verdict = extractTaggedLine(String(r.stdout || '') + '\n' + String(r.stderr || ''), 'CLI_VERSION_JSON');
    if (!verdict) throw new Error('CLI 版本门禁输出无法解析');
    if (!['current', 'installed', 'updated'].includes(verdict.status)) {
      throw new Error('CLI 版本门禁未通过');
    }
    if (!cliExists()) throw new Error('redapp CLI 入口不存在');
    return { status: verdict.status };
  };
}

export const ensureRedappCli = createRedappCliEnsurer({
  gateExists: () => fs.existsSync(SKILL_GATE),
  cliExists: () => fs.existsSync(CLI_ENTRY),
  prepareCache: () => fs.mkdirSync(NPM_CACHE, { recursive: true }),
  executeGate: () => spawnNode([SKILL_GATE], 180 * 1000)
});

// 未门禁的执行原语只供版本检查后的公共 runner 使用。
function runRedappCommandUngated(args, { timeoutMs = 120 * 1000 } = {}) {
  return spawnNode([CLI_ENTRY, ...args, '--agent'], timeoutMs);
}

function parseCommandExecution(execution = {}) {
  if (execution.error || execution.status !== 0) throw new Error('redapp 命令执行失败');
  const output = String(execution.stdout || '') + '\n' + String(execution.stderr || '');
  const parsed = parseTaggedOutput(output);
  if (parsed.prompts.length > 0) {
    throw new Error('redapp 需要重新登录授权，请在终端完成 redapp login 后再试');
  }
  const result = parsed.results.at(-1);
  if (!result) throw new Error('redapp 未返回可解析的结果');
  if (result.status === 'error') throw new Error('redapp 执行失败');
  return result;
}

export function createRedappCommandRunner({ ensureCli, execute }) {
  return function run(args, options) {
    ensureCli();
    return parseCommandExecution(execute(args, options));
  };
}

// 公共执行边界始终先通过版本门禁，再执行 redapp 业务命令。
export const runRedappCommand = createRedappCommandRunner({
  ensureCli: ensureRedappCli,
  execute: runRedappCommandUngated
});

export function createRedappOperations({ runCommand, writeFile, fileExists }) {
  function dryRunThenConfirm(args, { timeoutMs = 120 * 1000, confirmOnlyArgs = [] } = {}) {
    const plan = runCommand([...args, '--dry-run'], { timeoutMs });
    const planHash = plan?.plan?.planHash;
    if (!planHash) throw new Error('dry-run 未返回 planHash');
    return runCommand([...args, ...confirmOnlyArgs, '--confirm', planHash], { timeoutMs });
  }

  function uploadPackageWithDependencies(zipPath) {
    const result = dryRunThenConfirm(['upload', '--file', zipPath, '--type', 'pkg'], { timeoutMs: 180 * 1000 });
    const fileId = result?.data?.fileId;
    const md5 = result?.data?.md5;
    if (!fileId || !md5) throw new Error('上传回执缺少 fileId/md5');
    return { fileId, md5 };
  }

  function createPreviewWithDependencies({ fileId, md5, appName, qrOut }) {
    const previewJson = qrOut.replace(/\.png$/i, '') + '.json';
    const payload = { pkgFileId: fileId, md5, appName: appName || '笔记发布助手', version: '1.0.0' };
    writeFile(previewJson, JSON.stringify(payload, null, 2));
    const result = dryRunThenConfirm(
      ['preview', '--source', 'thirdAgent', '--file', previewJson],
      { timeoutMs: 120 * 1000, confirmOnlyArgs: ['--qr-out', qrOut] }
    );
    const data = sanitizeData(result?.data);
    return {
      qrCodePath: data.qrCodePath || (fileExists(qrOut) ? qrOut : null),
      previewUrl: data.previewUrl || '',
      raw: data
    };
  }

  return { uploadPackage: uploadPackageWithDependencies, createPreview: createPreviewWithDependencies };
}

const operations = createRedappOperations({
  runCommand: runRedappCommand,
  writeFile: fs.writeFileSync,
  fileExists: fs.existsSync
});

// 上传 zip 代码包，返回 { fileId, md5 }。
export const uploadPackage = operations.uploadPackage;

// 创建手机预览，返回 { qrCodePath, previewUrl }。qrOut 不能覆盖已有文件。
export const createPreview = operations.createPreview;
