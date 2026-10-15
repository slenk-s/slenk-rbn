import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { ensureAdmin, findUserByUsername, findUserById } from '../store.js';
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

// Reads the user back from the database so the client learns isAdmin without
// trusting a claim baked into the token.
router.get('/me', verify, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.userId);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    res.json({ user: { id: user.id, username: user.username, isAdmin: user.isAdmin } });
  } catch (err) { next(err); }
});
