import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { ensureAdmin, dataDir } from './store.js';
import { router as authRoutes } from './routes/auth.js';
import { router as uploadRoutes } from './routes/upload.js';
import { router as taskRoutes } from './routes/tasks.js';
import { router as aiRoutes } from './routes/ai.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
ensureAdmin();
const uploadsDir = path.resolve(process.env.UPLOADS_PATH || path.join(dataDir, 'uploads'));
const videosDir = path.resolve(process.env.VIDEO_OUT_PATH || path.join(dataDir, 'videos'));
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });

const app = express();
app.use(cors({ origin: process.env.PUBLIC_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(uploadsDir));
app.use('/videos', express.static(videosDir));
app.use('/api/auth', authRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/ai', aiRoutes);
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'server_error' });
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`server listening on ${port}`));
