import { Router } from 'express';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import { dbClient } from '../db.js';
import { verify } from '../auth.js';

const conn = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
export const queue = new Queue('ai-tasks', { connection: conn });

export const router = Router();
router.use(verify);

router.post('/', async (req,res)=>{
  const { type, payload } = req.body;
  const id = nanoid(16);
  const now = new Date().toISOString();
  await dbClient.run('INSERT INTO tasks(id,user_id,type,status,payload,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, req.user.userId, type, 'queued', JSON.stringify(payload||{}), now, now]);
  await queue.add(type, { id, payload, userId: req.user.userId }, { removeOnComplete: 100, removeOnFail: 100 });
  res.json({ id, status: 'queued' });
});

router.get('/', async (req,res)=>{
  const items = await dbClient.all('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.userId]);
  res.json({ tasks: items });
});

router.get('/:id', async (req,res)=>{
  const item = await dbClient.get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId]);
  if(!item) return res.status(404).json({ error: 'not_found' });
  res.json({ task: item });
});
