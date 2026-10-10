import jwt from 'jsonwebtoken';
import { dbClient } from '../db.js';

export const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
export const JWT_DAYS = Number(process.env.JWT_DAYS || 14);

export function sign(user) {
  return jwt.sign({ userId: user.id, email: user.email, exp: Math.floor(Date.now()/1000) + JWT_DAYS*86400 }, SECRET);
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
