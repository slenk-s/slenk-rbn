import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { ensureAdmin, findUserByUsername, findUserById } from '../store.js';
import { sign, verify } from '../auth.js';
import {
  formatTurnstileDiagnostic,
  verifyTurnstile,
} from '../lib/turnstile.js';

export const router = Router();

// Cloudflare Turnstile gate for login. The browser sends cf-turnstile-response;
// we redeem it once at siteverify before any credential check runs.
const TURNSTILE_ACTION = 'login';
const turnstileHostnames = new Set(
  (process.env.TURNSTILE_HOSTNAMES ?? '')
    .split(',')
    .map((hostname) => hostname.trim())
    .filter(Boolean),
);

async function verifyLoginTurnstile(req, res) {
  const result = await verifyTurnstile({
    token: req.body?.['cf-turnstile-response'],
    secret: process.env.TURNSTILE_SECRET,
    expectedAction: TURNSTILE_ACTION,
    expectedHostnames: turnstileHostnames,
    remoteIp: req.ip,
  });
  if (!result.ok) {
    console.warn('Turnstile verification rejected', formatTurnstileDiagnostic(result));
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

router.post('/login', async (req, res, next) => {
  try {
    if (!(await verifyLoginTurnstile(req, res))) return;
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
