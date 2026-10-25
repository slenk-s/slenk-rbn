import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureAdmin } from './store.js';
import { paths } from './paths.js';
import { startNotesImagesJanitor } from './cacheJanitor.js';
import { router as authRoutes } from './routes/auth.js';
import { router as userRoutes } from './routes/users.js';
import { router as uploadRoutes } from './routes/upload.js';
import { router as taskRoutes } from './routes/tasks.js';
import { router as aiRoutes } from './routes/ai.js';
import { router as providerRoutes } from './routes/providers.js';
import { router as noteRoutes } from './routes/notes.js';
import { router as downloadRoutes } from './routes/download.js';

await ensureAdmin();
startNotesImagesJanitor();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = paths.uploadsDir;
const videosDir = paths.videosDir;
const notesImagesDir = path.join(paths.dataDir, 'notes-images');
function serveNotesImages(req, res, next) {
  const ext = path.extname(req.path).toLowerCase();
  const rel = decodeURIComponent(req.path.replace(/^\//, ''));
  const filePath = path.join(notesImagesDir, rel);
  const baseDir = path.resolve(notesImagesDir);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(baseDir) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return next();
  const buf = fs.readFileSync(resolved);
  let type = 'application/octet-stream';
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xd8) type = 'image/jpeg';
  else if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) type = 'image/png';
  else if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') type = 'image/webp';
  else if (buf.length > 6 && buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) type = 'image/gif';
  else if (ext === '.jpg' || ext === '.jpeg') type = 'image/jpeg';
  else if (ext === '.png') type = 'image/png';
  else if (ext === '.webp') type = 'image/webp';
  else if (ext === '.gif') type = 'image/gif';
  else if (ext === '.heic') type = 'image/heic';
  else if (ext === '.heif') type = 'image/heif';
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.setHeader('Content-Type', type);
  return res.send(buf);
}

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(notesImagesDir, { recursive: true });

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use('/videos', express.static(videosDir));
app.use('/notes-images', serveNotesImages);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/providers', providerRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/download', downloadRoutes);

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api|\/uploads|\/videos|\/notes-images).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

// 未匹配的 /api/* 先返回 JSON 404，避免前端把 SPA HTML fallback 当 JSON 解析。
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'server_error' });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`server listening on ${port}`));
