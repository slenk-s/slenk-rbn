// 真实中转站联调：创建 Turing 供应商并逐功能页发真实任务，打印每步结果。
// 任务与供应商都会保留，方便在 UI 里查看结果。用法：node server/scripts/test-real-relay.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addProvider, listProviders, setActiveProvider, findUserByUsername, getTask
} from '../src/store.js';
import { enqueueTask, closeQueue } from '../src/routes/tasks.js';
import { paths } from '../src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const BASE_URL = 'https://live-turing.cn.llm.tcljd.com/api/v1';
const API_KEY = 'sk-turing-v1-tcl-aigc-portal-Fxc1VSPsbC0GMUOZoYXI7hlVR9Zx59hOvdQr4q37ZaL';

const results = [];
const report = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`);
};

async function waitTask(userId, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await getTask(userId, id);
    if (t.status === 'done' || t.status === 'failed') return t;
    await new Promise(r => setTimeout(r, 3000));
  }
  return getTask(userId, id);
}

const admin = await findUserByUsername('admin');
if (!admin) throw new Error('admin user not found');

// 1. 建供应商（按名字复用，避免重复创建）
let provider = (await listProviders()).find(p => p.name === 'Turing 中转站');
if (!provider) {
  provider = await addProvider({
    name: 'Turing 中转站',
    providerType: 'openai-compatible',
    appType: 'openai',
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    textModel: 'turing/gpt-4o-mini',
    imageModel: 'turing/gpt-image-2.5-flare',
    imageApi: 'form',
    notes: '真实中转站联调创建'
  });
}
console.log('provider:', provider.id, provider.name, 'imageApi=', provider.imageApi);
await setActiveProvider(provider.id, 'image', admin.id);
await setActiveProvider(provider.id, 'text', admin.id);

// 2. 笔记改写（/chat/completions，文本模型）
try {
  const t = await enqueueTask('rewrite', {
    prompt: '把以下内容改写成适合小红书发布的种草文案，口语化、带 emoji，100 字左右。',
    source: '本周入手了一款便携榨汁杯，400ml，充电款，早上打香蕉牛奶两分钟搞定，清洗也只要冲一下。',
    purpose: 'content',
    providerId: provider.id
  }, admin.id, 'note-rewrite');
  const done = await waitTask(admin.id, t.id, 120000);
  const text = done.result?.text || '';
  report('笔记改写 /chat/completions', done.status === 'done' && text.length > 10,
    done.status === 'done' ? `输出 ${text.length} 字：${text.slice(0, 40)}…` : done.error);
} catch (e) { report('笔记改写 /chat/completions', false, e.message); }

// 3. AI 生图（/images/generations，文生图）
let generatedImageUrl = null;
try {
  const t = await enqueueTask('image', {
    prompt: '小红书风格静物摄影：一只奶白色便携榨汁杯放在原木餐桌上，旁边有香蕉和牛奶，清晨柔和自然光，画面干净，主体突出',
    count: 1,
    canvasSize: '1080x1440',
    providerId: provider.id
  }, admin.id, 'ai-image');
  console.log('ai-image task:', t.id, '（文生图通常 1-4 分钟）');
  const done = await waitTask(admin.id, t.id, 420000);
  generatedImageUrl = done.result?.images?.[0] || null;
  report('AI 生图 /images/generations', done.status === 'done' && !!generatedImageUrl,
    done.status === 'done' ? generatedImageUrl : done.error);
} catch (e) { report('AI 生图 /images/generations', false, e.message); }

// 4. 替换生图（/images/edits，multipart），参考图用第 3 步的产物
if (generatedImageUrl) {
  try {
    const t = await enqueueTask('image', {
      prompt: '保持榨汁杯主体不变，把背景替换成奶油风厨房台面，整体色调更暖',
      count: 1,
      canvasSize: '1080x1440',
      imageUrls: [generatedImageUrl],
      providerId: provider.id
    }, admin.id, 'replace-image');
    console.log('replace-image task:', t.id);
    const done = await waitTask(admin.id, t.id, 420000);
    const out = done.result?.images?.[0] || null;
    report('替换生图 /images/edits', done.status === 'done' && !!out,
      done.status === 'done' ? out : done.error);
  } catch (e) { report('替换生图 /images/edits', false, e.message); }
} else {
  report('替换生图 /images/edits', false, '跳过：文生图未产出参考图');
}

// 5. 实况视频（本地 FFmpeg，不走中转站）。把生成的图复制到 uploads 作为素材
try {
  let uploadUrl = null;
  if (generatedImageUrl) {
    const src = path.join(paths.videosDir, path.basename(generatedImageUrl));
    const dst = path.join(paths.uploadsDir, 'video-test-' + path.basename(generatedImageUrl));
    fs.copyFileSync(src, dst);
    uploadUrl = '/uploads/' + path.basename(dst);
  }
  if (!uploadUrl) throw new Error('无可用素材图');
  const t = await enqueueTask('video', {
    prompt: '测试运镜',
    mediaUrls: [uploadUrl],
    canvasSize: '1080x1440',
    durationMode: 'fixed',
    duration: 3,
    motionEffect: '手持轻晃',
    shakeStrength: 35,
    shakeFrequency: 45,
    providerId: provider.id
  }, admin.id, 'live-video');
  console.log('video task:', t.id);
  const done = await waitTask(admin.id, t.id, 180000);
  const video = done.result?.video || null;
  const exists = video && fs.existsSync(path.join(paths.videosDir, path.basename(video)));
  report('实况视频 FFmpeg 运镜', done.status === 'done' && !!exists,
    done.status === 'done' ? `${video} (${exists ? Math.round(fs.statSync(path.join(paths.videosDir, path.basename(video))).size / 1024) + 'KB' : '文件缺失'})` : done.error);
} catch (e) { report('实况视频 FFmpeg 运镜', false, e.message); }

await closeQueue().catch(() => {});
console.log('\n==== 汇总 ====');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
