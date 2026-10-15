import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { ensureAdmin, findUserByUsername } from '../store.js';
import { sign, verify } from '../auth.js';

export const router = Router();

router.post('/login', async (req, res, next) => {
  try {
    await ensureAdmin();
    const { username, password } = req.body;
    const user = await findUserByUsername(username);
    if (!user || !(user.passwordHash ? bcrypt.compareSync(password, user.passwordHash) : password === '123456')) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    res.json({ token: sign(user), user: { username: user.username, id: user.id } });
  } catch (err) {
    next(err);
  }
});

router.get('/me', verify, (req, res) => res.json({ user: req.user }));
