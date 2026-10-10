import { Router } from 'express';
import { verify } from '../auth.js';
import { queue } from './tasks.js';

export const router = Router();
router.use(verify);
router.post('/rewrite-note-text', async (req,res)=>{
  const { prompt, source } = req.body;
  await queue.add('rewrite', { prompt, source }, { removeOnComplete: 100, removeOnFail: 100 });
  res.json({ status: 'queued' });
});
router.post('/images', async (req,res)=>{
  const { prompt, image } = req.body;
  await queue.add('image', { prompt, image }, { removeOnComplete: 100, removeOnFail: 100 });
  res.json({ status: 'queued' });
});
router.post('/video', async (req,res)=>{
  const { mediaUrls, motion, duration, shakeStrength, shakeFrequency } = req.body;
  await queue.add('video', { mediaUrls, motion, duration, shakeStrength, shakeFrequency }, { removeOnComplete: 100, removeOnFail: 100 });
  res.json({ status: 'queued' });
});
