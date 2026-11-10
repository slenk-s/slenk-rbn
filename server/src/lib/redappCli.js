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

function extractTaggedLine(output, tag) {
  const line = output.split(/\r?\n/).reverse().find(l => l.startsWith(tag + ':'));
  if (!line) return null;
  try { return JSON.parse(line.slice(tag.length + 1)); } catch { return null; }
}

// 版本门禁：只有 current / installed / updated 才算通过。
export function ensureRedappCli() {
  if (!fs.existsSync(SKILL_GATE)) throw new Error('redapp-cli Skill 未安装：' + SKILL_GATE);
  fs.mkdirSync(NPM_CACHE, { recursive: true });
  const r = spawnNode([SKILL_GATE], 180 * 1000);
  const verdict = extractTaggedLine(r.stdout + '\n' + r.stderr, 'CLI_VERSION_JSON');
  if (!verdict) throw new Error('CLI 版本门禁输出无法解析：' + (r.stderr || r.stdout).slice(0, 300));
  if (!['current', 'installed', 'updated'].includes(verdict.status)) {
    throw new Error('CLI 版本门禁未通过：' + (verdict.message || verdict.status));
  }
  if (!fs.existsSync(CLI_ENTRY)) throw new Error('redapp CLI 入口不存在：' + CLI_ENTRY);
  return verdict;
}

// 执行一条 redapp 命令，返回 RESULT_JSON；出现 PROMPT 说明登录失效。
function runRedapp(args, timeoutMs = 120 * 1000) {
  const r = spawnNode([CLI_ENTRY, ...args, '--agent'], timeoutMs);
  const output = r.stdout + '\n' + r.stderr;
  const prompt = extractTaggedLine(output, 'PROMPT');
  if (prompt) throw new Error('redapp 需要重新登录授权，请在终端完成 redapp login 后再试');
  const result = extractTaggedLine(output, 'RESULT_JSON');
  if (!result) throw new Error('redapp 未返回结果：' + output.slice(0, 400));
  if (result.status === 'error') throw new Error(result.message || result.error || 'redapp 执行失败');
  return result;
}

// 两段式：dry-run 拿 planHash，confirm 执行。confirmOnlyArgs（如 --qr-out）只进 confirm 阶段。
function dryRunThenConfirm(args, { timeoutMs = 120 * 1000, confirmOnlyArgs = [] } = {}) {
  const plan = runRedapp([...args, '--dry-run'], timeoutMs);
  const planHash = plan?.plan?.planHash;
  if (!planHash) throw new Error('dry-run 未返回 planHash：' + JSON.stringify(plan).slice(0, 300));
  return runRedapp([...args, ...confirmOnlyArgs, '--confirm', planHash], timeoutMs);
}

// 上传 zip 代码包，返回 { fileId, md5 }。
export function uploadPackage(zipPath) {
  const result = dryRunThenConfirm(['upload', '--file', zipPath, '--type', 'pkg'], { timeoutMs: 180 * 1000 });
  const fileId = result?.data?.fileId;
  const md5 = result?.data?.md5;
  if (!fileId || !md5) throw new Error('上传回执缺少 fileId/md5：' + JSON.stringify(result).slice(0, 300));
  return { fileId, md5 };
}

// 创建手机预览，返回 { qrCodePath, previewUrl }。qrOut 不能覆盖已有文件。
export function createPreview({ fileId, md5, appName, qrOut }) {
  const previewJson = qrOut.replace(/\.png$/i, '') + '.json';
  const payload = { pkgFileId: fileId, md5, appName: appName || '笔记发布助手', version: '1.0.0' };
  fs.writeFileSync(previewJson, JSON.stringify(payload, null, 2));
  const result = dryRunThenConfirm(
    ['preview', '--source', 'thirdAgent', '--file', previewJson],
    { timeoutMs: 120 * 1000, confirmOnlyArgs: ['--qr-out', qrOut] }
  );
  return {
    qrCodePath: result?.data?.qrCodePath || (fs.existsSync(qrOut) ? qrOut : null),
    previewUrl: result?.data?.previewUrl || '',
    raw: result?.data || {}
  };
}
