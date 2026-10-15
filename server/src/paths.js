import './loadEnv.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

const configuredStorage = process.env.STORAGE_PATH || path.resolve(root, 'storage');
const dataDir = path.isAbsolute(configuredStorage) ? configuredStorage : path.resolve(root, configuredStorage);

function resolveDir(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

export const paths = {
  root,
  dataDir,
  uploadsDir: resolveDir(process.env.UPLOADS_PATH, path.join(dataDir, 'uploads')),
  videosDir: resolveDir(process.env.VIDEO_OUT_PATH, path.join(dataDir, 'videos'))
};
