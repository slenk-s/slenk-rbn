import { Router } from 'express';
import { verify } from '../auth.js';
import { enqueueTask } from './tasks.js';

export const router = Router();
router.use(verify);

router.post('/rewrite-note-text', async (req, res, next) => {
  try {
    res.json(await enqueueTask('rewrite', req.body, req.user.userId));
  } catch (err) {
    next(err);
  }
});
router.post('/images', async (req, res, next) => {
  try {
    res.json(await enqueueTask('image', req.body, req.user.userId));
  } catch (err) {
    next(err);
  }
});
router.post('/video', async (req, res, next) => {
  try {
    res.json(await enqueueTask('video', req.body, req.user.userId));
  } catch (err) {
    next(err);
  }
});
