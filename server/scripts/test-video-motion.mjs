// 临时验证脚本：四种运镜模式各发一个实况视频任务，跑完后退出。
import { findUserByUsername, getTask } from '../src/store.js';
import { enqueueTask, closeQueue } from '../src/routes/tasks.js';

const admin = await findUserByUsername('admin');
const effects = ['手持轻晃', '缓慢推近', '缓慢拉远', '轻微环绕'];
const ids = [];
for (const motionEffect of effects) {
  const task = await enqueueTask('video', {
    prompt: '测试运镜效果',
    mediaUrls: ['/uploads/BkxSUZlRQcZEUv33KZ2nh.jpg'],
    canvasSize: '1080x1080',
    duration: 3,
    durationMode: 'fixed',
    motionEffect,
    shakeStrength: 35,
    shakeFrequency: 45
  }, admin.id, 'live-video');
  console.log('enqueued', motionEffect, task.id);
  ids.push([motionEffect, task.id]);
}

const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  const states = [];
  let pending = 0;
  for (const [effect, id] of ids) {
    const t = await getTask(admin.id, id);
    states.push(`${effect}:${t?.status}${t?.error ? '(' + t.error + ')' : ''}`);
    if (!t || (t.status !== 'done' && t.status !== 'failed')) pending++;
  }
  console.log(new Date().toISOString().slice(11, 19), states.join(' | '));
  if (!pending) break;
  await new Promise(r => setTimeout(r, 5000));
}
await closeQueue().catch(() => {});
process.exit(0);
