import { Router } from 'express';
import { verify as defaultVerify } from '../auth.js';
import { createRedappAuthManager } from '../lib/redappAuth.js';
import { readRedappQrFile, runRedappCommandAsync, spawnRedappLogin } from '../lib/redappCli.js';

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createRedappAuthRouter({ authManager, verify = defaultVerify }) {
  const router = Router();
  router.use(verify);
  router.get('/', asyncRoute(async (req, res) => res.json(await authManager.getStatus())));
  router.post('/login', asyncRoute(async (req, res) => res.json(await authManager.startLogin())));
  router.get('/session/:id', asyncRoute(async (req, res) => {
    const session = await authManager.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    return res.json(session);
  }));
  router.post('/session/:id/cancel', asyncRoute(async (req, res) => {
    const session = await authManager.cancelLogin(req.params.id);
    if (!session) return res.status(404).json({ error: 'session_not_found' });
    return res.json(session);
  }));
  router.post('/logout', asyncRoute(async (req, res) => res.json(await authManager.logout())));
  return router;
}

export const authManager = createRedappAuthManager({
  spawnCli: spawnRedappLogin,
  runCli: runRedappCommandAsync,
  readFile: readRedappQrFile
});

export const router = createRedappAuthRouter({ authManager });
