import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import fs from 'node:fs';
import { connectDatabase } from './db.js';
import { router as authRoutes } from './routes/auth.js';
import { router as uploadRoutes } from './routes/upload.js';
import { router as taskRoutes } from './routes/tasks.js';
import { router as aiRoutes } from './routes/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
connectDatabase();
fs.mkdirSync(path.resolve(__dirname, '../../uploads'), { recursive: true });

const app = express();
app.use(cors({ origin: process.env.PUBLIC_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(path.resolve(__dirname, '../../uploads')));
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
