import { Router } from 'express';
import { verify, requireAdmin } from '../auth.js';
import { paths } from '../paths.js';

// SQLite 唯一后端（MySQL 已移除）：无 MySQL 连接，连接管理接口一律返回 sqlite_storage。
export const router = Router();
router.use(verify);
router.use(requireAdmin);

// GET 当前存储信息：返回 SQLite 文件与媒体目录路径，前端据此展示。
router.get('/db', (req, res) => {
  res.json({ storage: 'sqlite', path: paths.sqlitePath, mediaDir: paths.mediaDir });
});

// MySQL 连接管理（测试 / 保存 / 重置）已随 MySQL 后端移除，一律 400 sqlite_storage。
router.post('/db/test', (req, res) => res.status(400).json({ error: 'sqlite_storage' }));
router.post('/db', (req, res) => res.status(400).json({ error: 'sqlite_storage' }));
router.delete('/db', (req, res) => res.status(400).json({ error: 'sqlite_storage' }));
