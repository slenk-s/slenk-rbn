import './loadEnv.js';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureAdmin } from './store.js';
import { paths } from './paths.js';
import { router as authRoutes } from './routes/auth.js';
import { router as userRoutes } from './routes/users.js';
import { router as uploadRoutes } from './routes/upload.js';
import { router as taskRoutes } from './routes/tasks.js';
import { router as aiRoutes } from './routes/ai.js';
import { router as providerRoutes } from './routes/providers.js';
import { router as noteRoutes } from './routes/notes.js';
import { router as downloadRoutes } from './routes/download.js';

await ensureAdmin();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = paths.uploadsDir;
const videosDir = paths.videosDir;
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use('/videos', express.static(videosDir));
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
  app.get(/^(?!\/api|\/uploads|\/videos).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'server_error' });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`server listening on ${port}`));
