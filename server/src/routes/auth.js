import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { dbClient } from '../db.js';
import { sign, verify } from '../auth.js';

export const router = Router();

router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'missing_email_or_password' });
  const existing = await dbClient.get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return res.status(409).json({ error: 'email_exists' });
  const id = nanoid(12);
  const hash = await bcrypt.hash(password, 10);
  const expiresAt = new Date(Date.now() + 14*86400000).toISOString();
  await dbClient.run('INSERT INTO users(id,email,password_hash,expires_at,created_at) VALUES (?, ?, ?, ?, ?)', [id, email, hash, expiresAt, new Date().toISOString()]);
  res.json({ token: sign({ id, email }), user: { email, expiresAt, id } });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await dbClient.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'invalid_credentials' });
  res.json({ token: sign(user), user: { email: user.email, expiresAt: user.expires_at, id: user.id } });
});

router.get('/me', verify, async (req, res) => {
  const user = await dbClient.get('SELECT email, expires_at, id FROM users WHERE id = ?', [req.user.userId]);
  res.json({ user });
});
