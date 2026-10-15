import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { verify } from '../auth.js';
import { paths } from '../paths.js';

export const router = Router();
const uploadDir = paths.uploadsDir;
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ storage: multer.diskStorage({ destination: (req,file,cb)=>cb(null,uploadDir), filename: (req,file,cb)=>cb(null,nanoid()+path.extname(file.originalname)) }), limits: { fileSize: 25 * 1024 * 1024 } });

function fileResponse(file) {
  return { url: `/uploads/${file.filename}`, name: file.originalname, path: file.path, size: file.size };
}

router.post('/file', verify, upload.single('file'), (req,res)=>{
  if(!req.file) return res.status(400).json({ error: 'missing_file' });
  res.json(fileResponse(req.file));
});

router.post('/files', verify, upload.array('file', 9), (req,res)=>{
  if(!req.files || req.files.length === 0) return res.status(400).json({ error: 'missing_files' });
  res.json({ files: req.files.map(fileResponse) });
});
