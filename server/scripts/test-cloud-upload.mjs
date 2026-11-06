// 端到端验证：入队一个生图任务 → worker 生成并上传 Supabase Storage →
// result.image 为公网 URL → 删除本地缓存文件后公网 URL 仍可访问。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../src/db.js';
import { getActiveProvider, getTaskById } from '../src/store.js';
import { enqueueTask, closeQueue } from '../src/routes/tasks.js';
import { paths } from '../src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { rows } = await query('select id, username from slenk_notes_users order by created_at asc limit 5');
if (!rows.length) throw new Error('no users');
let userId = null;
let provider = null;
for (const row of rows) {
  provider = await getActiveProvider('image', row.id);
  if (provider) { userId = row.id; break; }
}
if (!userId) throw new Error('no user with active image provider');
console.log('user:', userId, 'provider:', provider.name, provider.imageModel);

const { id } = await enqueueTask('image', {
  prompt: '一只橘猫趴在窗台上晒太阳，简约扁平插画风格',
  canvasSize: '1024x1024',
  count: 1
}, userId);
console.log('task enqueued:', id);

let task = null;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 5000));
  task = await getTaskById(id);
  if (task.status === 'done' || task.status === 'failed') break;
  process.stdout.write('.');
}
console.log('\nstatus:', task.status);
if (task.status !== 'done') {
  console.error('error:', task.error);
  process.exit(1);
}
console.log('result.image:', task.result.image);
console.log('result.images:', JSON.stringify(task.result.images));
console.log('result.localImages:', JSON.stringify(task.result.localImages));

const url = task.result.image;
if (!/^https:\/\/.*supabase\.co\/storage\//.test(url)) {
  console.error('FAIL: result.image is not a supabase URL');
  process.exit(1);
}

// 删除本地缓存文件，验证公网 URL 独立可用
const localName = (task.result.localImages && task.result.localImages[0]) || '';
const localPath = path.join(paths.videosDir, path.basename(localName));
if (fs.existsSync(localPath)) {
  fs.unlinkSync(localPath);
  console.log('local cache deleted:', localPath);
} else {
  console.log('local cache already absent:', localPath);
}

const res = await fetch(url);
console.log('cloud fetch:', res.status, res.headers.get('content-type'), (await res.arrayBuffer()).byteLength, 'bytes');
if (!res.ok) {
  console.error('FAIL: cloud URL not accessible after local delete');
  process.exit(1);
}

// 本地下载接口应走代理转发
const dl = await fetch(`http://localhost:3001/api/tasks/${id}/download?format=image`, { redirect: 'manual' });
console.log('download endpoint status (unauthenticated, expect 401):', dl.status);

console.log('PASS');
await closeQueue();
process.exit(0);
