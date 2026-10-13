import { Router } from 'express';
import os from 'node:os';
import { verify } from '../auth.js';
import { saveNote, getNote } from '../store.js';

export const router = Router();

function lanOrigin(req) {
  const port = Number(process.env.PORT || 3001);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return 'http://' + net.address + ':' + port;
    }
  }
  return (req.protocol + '://' + req.get('host'));
}

router.post('/', verify, (req, res) => {
  const note = saveNote(req.body || {});
  res.status(201).json({ id: note.id, url: lanOrigin(req) + '/p/' + note.id });
});

router.get('/:id', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'note_not_found' });
  res.json({ note });
});
