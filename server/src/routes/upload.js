import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { verify } from '../auth.js';

export const router = Router();
const uploadDir = path.resolve(process.cwd(), 'uploads');
const upload = multer({ storage: multer.diskStorage({ destination: (req,file,cb)=>cb(null,uploadDir), filename: (req,file,cb)=>cb(null,nanoid()+path.extname(file.originalname)) }) });
router.post('/file', verify, upload.single('file'), (req,res)=>{
  if(!req.file) return res.status(400).json({ error: 'missing_file' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});
