import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { dbClient } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');

async function openaiChat({ baseUrl, apiKey, model, messages }) {
  const base = (baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = `${base}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey || process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: model || process.env.TEXT_MODEL || 'deepseek-v4-pro', messages })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error?.message || 'openai_api_error');
  return data.choices?.[0]?.message?.content || '';
}

async function mark(id, status, payload) {
  await dbClient.run('UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?', [status, payload ? JSON.stringify(payload) : null, payload ? null : JSON.stringify(payload), new Date().toISOString(), id]);
}

new Worker('ai-tasks', async (job) => {
  const { id, payload, userId } = job.data;
  try {
    if (job.name === 'rewrite') {
      const text = await openaiChat({
        ...payload,
        messages: [{ role: 'user', content: `${payload.prompt}\n\n${payload.source||''}` }]
      });
      await mark(id, 'done', { text });
      return { text };
    }
    if (job.name === 'image') {
      const base = (payload.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const url = `${base}/images/generations`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${payload.apiKey || process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: payload.model || process.env.IMAGE_MODEL || 'gpt-image-1', prompt: payload.prompt, n: 1 })
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data.error?.message || 'image_api_error');
      const outDir = path.resolve(__dirname, '../../uploads');
      fs.mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, `${id}.png`);
      const imageRes = await fetch(data.data?.[0]?.url || data.images?.[0] || data.url);
      const buf = Buffer.from(await imageRes.arrayBuffer());
      fs.writeFileSync(filePath, buf);
      await mark(id, 'done', { image: `/uploads/${path.basename(filePath)}` });
      return { image: `/uploads/${path.basename(filePath)}` };
    }
    if (job.name === 'video') {
      await mark(id, 'done', { video: null, note: 'video_generation_stub' });
      return { video: null, note: 'video_generation_stub' };
    }
    throw new Error('unknown_job');
  } catch (err) {
    await mark(id, 'failed', { error: err.message });
    throw err;
  }
}, { connection: redis, concurrency: Number(process.env.QUEUE_CONCURRENCY || 2) });
