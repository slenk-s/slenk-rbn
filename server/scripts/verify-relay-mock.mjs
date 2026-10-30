// 一次性验证脚本：本地 mock 一个 GPT-image 中转站，走真实队列跑一个替换生图任务，
// 断言 worker 按文档用 multipart/form-data 调 /images/edits 且响应 b64_json 能落图。
// 用法：确保 Redis 与 queue worker 在跑，然后 `node server/scripts/verify-relay-mock.mjs`。
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { addProvider, deleteProvider, findUserByUsername, getTask, deleteTask } from '../src/store.js';
import { enqueueTask, closeQueue } from '../src/routes/tasks.js';
import { paths } from '../src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const received = [];
// 1x1 透明 PNG，作为 b64_json 返回
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 只验证关键点：content-type、字段名、字段值。完整 multipart 解析不必引入依赖。
function inspectMultipart(buf, contentType) {
  const boundary = (contentType.match(/boundary=(.+)$/) || [])[1];
  const text = buf.toString('latin1');
  const fields = {};
  const fileFields = [];
  for (const part of text.split('--' + boundary)) {
    const head = part.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!head) continue;
    if (head[2] !== undefined) fileFields.push(head[1]);
    else {
      const bodyStart = part.indexOf('\r\n\r\n');
      // 字段值是 UTF-8，先按 latin1 切回字节再解码，避免中文乱码。
      fields[head[1]] = bodyStart >= 0 ? Buffer.from(part.slice(bodyStart + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8') : '';
    }
  }
  return { fields, fileFields };
}

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  console.log(`[mock] ${req.method} ${req.url} content-type=${req.headers['content-type']}`);
  const record = { url: req.url, contentType: req.headers['content-type'] || '', body };
  if (record.contentType.includes('multipart/form-data')) {
    Object.assign(record, inspectMultipart(body, record.contentType));
  } else if (record.contentType.includes('application/json')) {
    record.json = JSON.parse(body.toString('utf8'));
  }
  received.push(record);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ created: Date.now(), data: [{ b64_json: PNG_1PX.toString('base64') }] }));
});

await new Promise(resolve => server.listen(3999, '127.0.0.1', resolve));

let providerId = null;
let taskId = null;
let failed = false;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed = true; console.error(`  FAIL ${name} ${detail}`); }
};

try {
  const admin = await findUserByUsername('admin');
  if (!admin) throw new Error('admin user not found');

  const provider = await addProvider({
    name: 'mock-relay-verify',
    appType: 'openai',
    imageApi: 'form',
    baseUrl: 'http://127.0.0.1:3999/v1',
    apiKey: 'test-key',
    imageModel: 'turing/gpt-image-2'
  });
  providerId = provider.id;

  // 参考图：512x512 PNG data URL，模拟上传后的参考图
  const refPng = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const refDataUrl = 'data:image/png;base64,' + refPng.toString('base64');

  console.log('[1] 文生图（/images/generations, JSON）');
  const t1 = await enqueueTask('image', {
    prompt: 'mock 文生图', count: 1, canvasSize: '1080x1080', providerId: provider.id
  }, admin.id, 'ai-image');
  taskId = t1.id;
  await waitTask(t1.id);
  let gen = received.find(r => r.url.includes('/images/generations'));
  check('generations 被调用', !!gen);
  check('generations 是 JSON', gen?.contentType.includes('application/json'), gen?.contentType);
  check('model 正确', gen?.json?.model === 'turing/gpt-image-2', gen?.json?.model);
  check('size=1088x1088（1080 向上 snap 到 32 倍数）', gen?.json?.size === '1088x1088', gen?.json?.size);
  check('不带 watermark', gen && !('watermark' in gen.json));
  check('n=1', gen?.json?.n === 1);

  console.log('[2] 替换生图单参考图（/images/edits, multipart）');
  const t2 = await enqueueTask('image', {
    prompt: '把背景换成沙滩', count: 1, canvasSize: '1080x1440', providerId: provider.id,
    imageUrls: [refDataUrl]
  }, admin.id, 'replace-image');
  await waitTask(t2.id);
  let edit = received.find(r => r.url.includes('/images/edits'));
  check('edits 被调用', !!edit);
  check('edits 是 multipart', edit?.contentType.includes('multipart/form-data'), edit?.contentType);
  check('单图字段名是 image', edit?.fileFields?.join() === 'image', JSON.stringify(edit?.fileFields));
  check('model 字段正确', edit?.fields?.model === 'turing/gpt-image-2', JSON.stringify(edit?.fields));
  check('size=1088x1440', edit?.fields?.size === '1088x1440', edit?.fields?.size);
  check('prompt 透传', edit?.fields?.prompt === '把背景换成沙滩');
  check('不带 watermark', edit && !('watermark' in (edit.fields || {})));

  console.log('[3] 多参考图（一一对应，image[] 或拆分单图）');
  received.length = 0;
  const t3 = await enqueueTask('image', {
    prompt: '参考风格生成', count: 1, canvasSize: '1080x1080', providerId: provider.id,
    imageUrls: [refDataUrl, refDataUrl]
  }, admin.id, 'replace-image');
  await waitTask(t3.id);
  const edits = received.filter(r => r.url.includes('/images/edits'));
  // 一一对应模式：每张参考图单独一次请求，每次带 1 张（字段 image）
  check('一一对应拆成 2 次编辑请求', edits.length === 2, `got ${edits.length}`);
  check('每次各带 1 张图', edits.every(e => e.fileFields.length === 1), JSON.stringify(edits.map(e => e.fileFields)));

  const task3 = await getTask(admin.id, t3.id);
  const resultImages = task3?.result?.images || [];
  check('任务成功且有结果图', task3?.status === 'done' && resultImages.length === 2, JSON.stringify({ status: task3?.status, error: task3?.error }));
  const first = resultImages[0] ? path.join(paths.videosDir, path.basename(resultImages[0])) : null;
  check('结果图已落盘', !!first && fs.existsSync(first), String(first));

  taskId = t3.id;
  await deleteTask(admin.id, t1.id).catch(() => {});
  await deleteTask(admin.id, t2.id).catch(() => {});
  await deleteTask(admin.id, t3.id).catch(() => {});
} catch (err) {
  failed = true;
  console.error('verify error:', err);
} finally {
  if (providerId) await deleteProvider(providerId).catch(() => {});
  server.close();
  await closeQueue().catch(() => {});
}

console.log(failed ? '\n验证失败' : '\n全部通过');
process.exit(failed ? 1 : 0);

async function waitTask(id, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  const admin = await findUserByUsername('admin');
  while (Date.now() < deadline) {
    const t = await getTask(admin.id, id);
    if (t.status === 'done' || t.status === 'succeeded' || t.status === 'failed') {
      if (t.status === 'failed') console.error(`task ${id} failed:`, t.error);
      return t;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const t = await getTask(admin.id, id);
  console.error(`task ${id} timeout, status=${t?.status} error=${t?.error} received=${received.map(r => r.url).join(',') || '(none)'}`);
  return t;
}
