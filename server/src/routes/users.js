import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { verify, requireAdmin } from '../auth.js';
import { listUsers, createUser, updateUser, deleteUser, findUserById } from '../store.js';

export const router = Router();
router.use(verify);
router.use(requireAdmin);

const MIN_PASSWORD = 6;

router.get('/', async (req, res, next) => {
  try {
    res.json({ users: await listUsers() });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username) return res.status(400).json({ error: 'username_required' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'password_too_short', minLength: MIN_PASSWORD });
    const created = await createUser({ username, passwordHash: bcrypt.hashSync(password, 10), isAdmin: Boolean(req.body?.isAdmin) });
    res.status(201).json({ user: { id: created.id, username: created.username, isAdmin: created.isAdmin, createdAt: created.createdAt }, users: await listUsers() });
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ error: 'username_taken' });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    const patch = {};
    if (req.body?.password !== undefined) {
      const password = String(req.body.password);
      if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'password_too_short', minLength: MIN_PASSWORD });
      patch.passwordHash = bcrypt.hashSync(password, 10);
    }
    if (req.body?.isAdmin !== undefined) {
      const isAdmin = Boolean(req.body.isAdmin);
      // Refuse to drop your own admin flag; it would lock you out of this screen.
      if (target.id === req.user.userId && !isAdmin) return res.status(400).json({ error: 'cannot_demote_self' });
      patch.isAdmin = isAdmin;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    await updateUser(req.params.id, patch);
    res.json({ users: await listUsers() });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (req.params.id === req.user.userId) return res.status(400).json({ error: 'cannot_delete_self' });
    const target = await findUserById(req.params.id);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    await deleteUser(req.params.id);
    res.json({ users: await listUsers() });
  } catch (err) { next(err); }
});