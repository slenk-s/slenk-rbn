import jwt from 'jsonwebtoken';

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
