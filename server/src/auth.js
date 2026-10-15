import jwt from 'jsonwebtoken';
import { findUserById } from './store.js';

export const SECRET = process.env.JWT_SECRET || 'slenk-notes-local-secret';
export const JWT_DAYS = Number(process.env.JWT_DAYS || 14);

export function sign(user) {
  return jwt.sign({ userId: user.id, username: user.username, exp: Math.floor(Date.now()/1000) + JWT_DAYS*86400 }, SECRET);
}

export function verify(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

// Must run after verify(): it reads the caller from the JWT payload and checks
// the database, so a token alone is never enough for admin-only routes.
export async function requireAdmin(req, res, next) {
  try {
    const user = await findUserById(req.user?.userId);
    if (!user?.isAdmin) return res.status(403).json({ error: 'admin_required' });
    next();
  } catch (err) {
    next(err);
  }
}