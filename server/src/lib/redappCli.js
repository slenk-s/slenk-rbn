// redapp CLI 服务端封装：每次先跑 ensure-cli 版本门禁（进程级 npm prefix 落在 storage 下，不污染全局），
// 再按 Skill 的 dry-run → confirm 两段式执行 upload / preview，解析 RESULT_JSON 回执。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { paths } from '../paths.js';

export const redappSkillGatePath = path.join(paths.root, '.skills', 'redapp-cli', 'scripts', 'ensure-cli.mjs');
const NPM_HOME = path.join(paths.dataDir, 'redapp-npm');
const NPM_PREFIX = path.join(NPM_HOME, 'prefix');
const NPM_CACHE = path.join(NPM_HOME, 'cache');
const CLI_ENTRY = path.join(NPM_PREFIX, 'node_modules', 'redskillhub-upload', 'cli', 'redapp', 'index.mjs');

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_QR_BYTES = 512 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 2_000;
const PROCESS_FORCE_CONFIRM_MS = 3_000;

async function terminateProcessTree(pid, force) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolve(false));
      killer.once('close', status => resolve(status === 0));
    });
  }
  try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); return true; } catch {
    try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); return true; } catch { return false; }
  }
}

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

export function createAsyncProcessRunner({
  spawnProcess = spawn,
  terminateTree = terminateProcessTree,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  terminationGraceMs = PROCESS_TERMINATION_GRACE_MS,
  forceConfirmMs = PROCESS_FORCE_CONFIRM_MS,
  maxOutputBytes = MAX_PROCESS_OUTPUT_BYTES
} = {}) {
  return function runNodeAsync(args, timeoutMs, { signal } = {}) {
    return new Promise(resolve => {
      let child;
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timer = null;
      let escalationTimer = null;
      let supervisorTimer = null;
      let settled = false;
      let terminatingError = null;

      const append = (chunks, byteCount, chunk) => {
        const remaining = maxOutputBytes - byteCount;
        if (remaining <= 0) return byteCount;
        const incoming = Buffer.from(chunk);
        const accepted = incoming.subarray(0, remaining);
        chunks.push(accepted);
        return byteCount + accepted.length;
      };
      const onStdout = chunk => { stdoutBytes = append(stdoutChunks, stdoutBytes, chunk); };
      const onStderr = chunk => { stderrBytes = append(stderrChunks, stderrBytes, chunk); };
      const requestTermination = errorMarker => {
        if (settled || terminatingError) return;
        terminatingError = errorMarker;
        if (timer !== null) { clearTimer(timer); timer = null; }
        signal?.removeEventListener?.('abort', onAbort);
        try { child?.kill?.('SIGTERM'); } catch {}
        escalationTimer = setTimer(() => {
          escalationTimer = null;
          void terminateTree(child?.pid, true).catch(() => false);
          if (settled) return;
          supervisorTimer = setTimer(() => finalize(null, 'process_termination_unconfirmed'), forceConfirmMs);
          supervisorTimer?.unref?.();
        }, terminationGraceMs);
        escalationTimer?.unref?.();
      };
      const onAbort = () => requestTermination('aborted');
      const cleanup = () => {
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        if (escalationTimer !== null) { clearTimer(escalationTimer); escalationTimer = null; }
        if (supervisorTimer !== null) { clearTimer(supervisorTimer); supervisorTimer = null; }
        signal?.removeEventListener?.('abort', onAbort);
        child?.stdout?.off?.('data', onStdout);
        child?.stderr?.off?.('data', onStderr);
        child?.off?.('error', onError);
        child?.off?.('close', onClose);
      };
      const finalize = (status, errorMarker) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          status,
          stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
          stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
          error: errorMarker ? new Error(errorMarker) : null
        });
      };
      const onError = () => finalize(null, terminatingError || 'process_error');
      const onClose = status => finalize(status, terminatingError);

      try {
        child = spawnProcess(process.execPath, args, {
          env: npmEnv(),
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch {
        finalize(null, 'process_error');
        return;
      }

      child.stdout?.on?.('data', onStdout);
      child.stderr?.on?.('data', onStderr);
      child.on('error', onError);
      child.on('close', onClose);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimer(() => requestTermination('timeout'), timeoutMs);
      timer?.unref?.();
    });
  };
}

const spawnNodeAsync = createAsyncProcessRunner();

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
  assignBoundedString(safe, value, 'code', 128);
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
  gateExists: () => fs.existsSync(redappSkillGatePath),
  cliExists: () => fs.existsSync(CLI_ENTRY),
  prepareCache: () => fs.mkdirSync(NPM_CACHE, { recursive: true }),
  executeGate: () => spawnNode([redappSkillGatePath], 180 * 1000)
});

export function createRedappCliEnsurerAsync({ gateExists, cliExists, prepareCache, executeGate }) {
  return async function ensureCliAsync(options) {
    if (!gateExists()) throw new Error('redapp-cli Skill 未安装');
    prepareCache();
    const r = await executeGate(options);
    if (r.error || r.status !== 0) throw new Error('CLI 版本门禁执行失败');
    const verdict = extractTaggedLine(String(r.stdout || '') + '\n' + String(r.stderr || ''), 'CLI_VERSION_JSON');
    if (!verdict) throw new Error('CLI 版本门禁输出无法解析');
    if (!['current', 'installed', 'updated'].includes(verdict.status)) throw new Error('CLI 版本门禁未通过');
    if (!cliExists()) throw new Error('redapp CLI 入口不存在');
    return { status: verdict.status };
  };
}

export const ensureRedappCliAsync = createRedappCliEnsurerAsync({
  gateExists: () => fs.existsSync(redappSkillGatePath),
  cliExists: () => fs.existsSync(CLI_ENTRY),
  prepareCache: () => fs.mkdirSync(NPM_CACHE, { recursive: true }),
  executeGate: options => spawnNodeAsync([redappSkillGatePath], 180 * 1000, options)
});

export async function spawnRedappLogin() {
  await ensureRedappCliAsync();
  return spawn(process.execPath, [CLI_ENTRY, 'login', '--agent'], {
    env: npmEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function createRedappQrReader({ open, maxBytes = MAX_QR_BYTES }) {
  return function readQrFile(filePath) {
    let handle;
    try {
      handle = open(filePath, 'r');
      const stat = handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('二维码文件无效');
      const image = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
      const bytesRead = handle.read(image, 0, image.length, 0);
      if (bytesRead !== stat.size || bytesRead > maxBytes) throw new Error('二维码文件无效');
      const result = image.subarray(0, bytesRead);
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (result.length < pngSignature.length || !result.subarray(0, pngSignature.length).equals(pngSignature)) {
        throw new Error('二维码文件无效');
      }
      return result;
    } catch {
      throw new Error('二维码文件无效');
    } finally {
      try { handle?.close(); } catch {}
    }
  };
}

export const readRedappQrFile = createRedappQrReader({
  open(filePath, flags) {
    const fd = fs.openSync(filePath, flags);
    return {
      stat: () => fs.fstatSync(fd),
      read: (buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
      close: () => fs.closeSync(fd)
    };
  }
});

// 未门禁的执行原语只供版本检查后的公共 runner 使用。
function runRedappCommandUngated(args, { timeoutMs = 120 * 1000 } = {}) {
  return spawnNode([CLI_ENTRY, ...args, '--agent'], timeoutMs);
}

function parseCommandExecution(execution = {}) {
  if (execution.error) throw new Error('redapp 命令执行失败');
  if (!Number.isFinite(execution.status) || !Number.isInteger(execution.status)) {
    throw new Error('redapp 命令执行失败');
  }
  const output = String(execution.stdout || '') + '\n' + String(execution.stderr || '');
  const parsed = parseTaggedOutput(output);
  const result = parsed.results.at(-1);
  const isAuthRequired = result?.status === 'error'
    && result.code === 'AUTH_REQUIRED'
    && Object.keys(result).length === 2;
  if (isAuthRequired) return result;
  if (execution.status !== 0) throw new Error('redapp 命令执行失败');
  if (parsed.prompts.length > 0) {
    throw new Error('redapp 需要重新登录授权，请在终端完成 redapp login 后再试');
  }
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

export function createRedappCommandRunnerAsync({ ensureCli, execute }) {
  return async function run(args, options) {
    await ensureCli(options);
    return parseCommandExecution(await execute(args, options));
  };
}

function runRedappCommandUngatedAsync(args, { timeoutMs = 120 * 1000, signal } = {}) {
  return spawnNodeAsync([CLI_ENTRY, ...args, '--agent'], timeoutMs, { signal });
}

export const runRedappCommandAsync = createRedappCommandRunnerAsync({
  ensureCli: ensureRedappCliAsync,
  execute: runRedappCommandUngatedAsync
});

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

export function createRedappOperationsAsync({ runCommand, writeFile, fileExists }) {
  async function dryRunThenConfirm(args, { timeoutMs = 120 * 1000, confirmOnlyArgs = [], signal } = {}) {
    const plan = await runCommand([...args, '--dry-run'], { timeoutMs, signal });
    const planHash = plan?.plan?.planHash;
    if (!planHash) throw new Error('dry-run 未返回 planHash');
    return runCommand([...args, ...confirmOnlyArgs, '--confirm', planHash], { timeoutMs, signal });
  }

  async function uploadPackageAsync(zipPath, { signal } = {}) {
    const result = await dryRunThenConfirm(['upload', '--file', zipPath, '--type', 'pkg'], { timeoutMs: 180 * 1000, signal });
    const fileId = result?.data?.fileId;
    const md5 = result?.data?.md5;
    if (!fileId || !md5) throw new Error('上传回执缺少 fileId/md5');
    return { fileId, md5 };
  }

  async function createPreviewAsync({ fileId, md5, appName, qrOut, signal }) {
    const previewJson = qrOut.replace(/\.png$/i, '') + '.json';
    writeFile(previewJson, JSON.stringify({ pkgFileId: fileId, md5, appName: appName || '笔记发布助手', version: '1.0.0' }, null, 2));
    const result = await dryRunThenConfirm(
      ['preview', '--source', 'thirdAgent', '--file', previewJson],
      { timeoutMs: 120 * 1000, confirmOnlyArgs: ['--qr-out', qrOut], signal }
    );
    const data = sanitizeData(result?.data);
    return { qrCodePath: data.qrCodePath || (fileExists(qrOut) ? qrOut : null), previewUrl: data.previewUrl || '', raw: data };
  }

  return { uploadPackageAsync, createPreviewAsync };
}

const asyncOperations = createRedappOperationsAsync({
  runCommand: runRedappCommandAsync,
  writeFile: fs.writeFileSync,
  fileExists: fs.existsSync
});

export const uploadPackageAsync = asyncOperations.uploadPackageAsync;
export const createPreviewAsync = asyncOperations.createPreviewAsync;

// 上传 zip 代码包，返回 { fileId, md5 }。
export const uploadPackage = operations.uploadPackage;

// 创建手机预览，返回 { qrCodePath, previewUrl }。qrOut 不能覆盖已有文件。
export const createPreview = operations.createPreview;
