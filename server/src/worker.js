import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'fluent-ffmpeg';
import { dataDir, updateTask } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
const uploadDir = path.resolve(process.env.UPLOADS_PATH || path.join(dataDir, 'uploads'));
const videoDir = path.resolve(process.env.VIDEO_OUT_PATH || path.join(dataDir, 'videos'));
fs.mkdirSync(videoDir, { recursive: true });

function env(key, fallback) { return process.env[key] || fallback; }

function senseNovaChat({ prompt, source }) {
  const baseUrl = (env('SENSENOVA_BASE_URL', 'https://platform.sensenova.cn/v1')).replace(/\/$/, '');
  return fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env('SENSENOVA_API_KEY', '')}` },
    body: JSON.stringify({ model: env('SENSENOVA_TEXT_MODEL', 'sensenova-6.8-flash-lite'), messages: [{ role: 'user', content: `${prompt}\n\n${source||''}` }] })
  });
}

function senseNovaImage({ prompt }) {
  const baseUrl = (env('SENSENOVA_BASE_URL', 'https://platform.sensenova.cn/v1')).replace(/\/$/, '');
  return fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env('SENSENOVA_API_KEY', '')}` },
    body: JSON.stringify({ model: env('SENSENOVA_IMAGE_MODEL', 'gpt-image-1'), prompt, n: 1 })
  });
}

function makeVideo(payload, id) {
  return new Promise((resolve, reject) => {
    const input = path.resolve(uploadDir, path.basename(payload.mediaUrls?.[0] || ''));
    const output = path.join(videoDir, `${id}.mp4`);
    const duration = Math.max(1, Math.min(30, Number(payload.duration) || 3));
    const intensity = Math.max(0, Math.min(100, Number(payload.shakeStrength) || 35));
    const frequency = Math.max(0, Math.min(100, Number(payload.shakeFrequency) || 45));
    if (!fs.existsSync(input)) return reject(new Error('input_file_missing'));
    const filter = [
      `zoompan=z='if(eq(on,0),1.0,if(lt(on,${duration*30}),1.0+${intensity/10000},${1+intensity/1000})')`,
      `x='if(eq(mod(on,${frequency||30}),0),iw/2,j(n))'`,
      `y='if(eq(mod(on,${frequency||30}),0),ih/2,j(n))'`,
      `s=1280x720`,
      `fps=30`
    ].join(',');
    ffmpeg(input)
      .outputOptions(['-t', String(duration), '-vf', filter, '-pix_fmt', 'yuv420p', '-c:v', 'libx264'])
      .on('end', () => resolve(output))
      .on('error', reject)
      .save(output);
  });
}

new Worker('ai-tasks', async (job) => {
  const { id, payload } = job.data;
  try {
    if (job.name === 'rewrite') {
      const res = await senseNovaChat(payload);
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data.error?.message || 'sensenova_api_error');
      updateTask(id, { status: 'done', result: JSON.stringify({ text: data.choices?.[0]?.message?.content || '' }) });
      return { text: data.choices?.[0]?.message?.content || '' };
    }
    if (job.name === 'image') {
      const res = await senseNovaImage(payload);
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data.error?.message || 'sensenova_image_error');
      const url = data.data?.[0]?.url || data.images?.[0] || data.url;
      if (url) {
        const out = path.join(videoDir, `${id}.png`);
        const imageRes = await fetch(url);
        fs.writeFileSync(out, Buffer.from(await imageRes.arrayBuffer()));
        updateTask(id, { status: 'done', result: JSON.stringify({ image: `/videos/${path.basename(out)}` }) });
        return { image: `/videos/${path.basename(out)}` };
      }
      updateTask(id, { status: 'done', result: JSON.stringify(data) });
      return data;
    }
    if (job.name === 'video') {
      const out = await makeVideo(payload, id);
      updateTask(id, { status: 'done', result: JSON.stringify({ video: `/videos/${path.basename(out)}` }) });
      return { video: `/videos/${path.basename(out)}` };
    }
    throw new Error('unknown_job');
  } catch (err) {
    updateTask(id, { status: 'failed', error: JSON.stringify({ error: err.message }) });
    throw err;
  }
}, { connection: redis, concurrency: Number(process.env.QUEUE_CONCURRENCY || 2) });
