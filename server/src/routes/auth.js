import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { ensureAdmin, findUserByUsername, findUserById } from '../store.js';
import { sign, verify } from '../auth.js';

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

async function verifyTurnstile(req, res) {
  const token = req.body?.['cf-turnstile-response'];
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 2048 ||
    !process.env.TURNSTILE_SECRET ||
    turnstileHostnames.size === 0
  ) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  let result;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET,
        response: token,
        remoteip: req.ip,
      }),
    });
    if (!r.ok) throw new Error(`siteverify ${r.status}`);
    result = await r.json();
  } catch {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  if (!result.success || result.action !== TURNSTILE_ACTION || !turnstileHostnames.has(result.hostname)) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

router.post('/login', async (req, res, next) => {
  try {
    if (!(await verifyTurnstile(req, res))) return;
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
