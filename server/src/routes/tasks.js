import { Router } from 'express';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { nanoid } from 'nanoid';
import { addTask, getTask, listTasks } from '../store.js';
import { verify } from '../auth.js';

const conn = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
export const queue = new Queue('ai-tasks', { connection: conn });

export const router = Router();
router.use(verify);

router.post('/', async (req,res)=>{
  const { type, payload } = req.body;
  const id = nanoid(16);
  const now = new Date().toISOString();
  const task = { id, userId: req.user.userId, type, status: 'queued', payload: JSON.stringify(payload||{}), createdAt: now, updatedAt: now };
  addTask(task);
  await queue.add(type, { id, payload, userId: req.user.userId }, { removeOnComplete: 100, removeOnFail: 100 });
  res.json({ id, status: 'queued' });
});

router.get('/', (req,res)=> res.json({ tasks: listTasks(req.user.userId) }));
router.get('/:id', (req,res)=> {
  const item = getTask(req.user.userId, req.params.id);
  if(!item) return res.status(404).json({ error: 'not_found' });
  res.json({ task: item });
});
