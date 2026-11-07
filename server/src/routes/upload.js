import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { verify } from '../auth.js';
import { paths } from '../paths.js';
import { sniffImageFormat, toStandardImage } from '../lib/imageFormat.js';

export const router = Router();
const uploadDir = paths.uploadsDir;
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ storage: multer.diskStorage({ destination: (req,file,cb)=>cb(null,uploadDir), filename: (req,file,cb)=>cb(null,nanoid()+path.extname(file.originalname)) }), limits: { fileSize: 25 * 1024 * 1024 } });

// 图片落盘只允许 jpg/png：webp 等格式上传后转成 png 并换成新文件名；
// 视频和其他非图片文件解码会失败，按原样保留。
async function normalizeUploaded(file) {
  const buf = fs.readFileSync(file.path);
  const fmt = sniffImageFormat(buf);
  if (fmt === 'jpeg' || fmt === 'png') return file;
  const std = await toStandardImage(buf);
  if (!std) return file;
  const newName = file.filename.replace(/\.[a-z0-9]+$/i, '') + std.ext;
  const newPath = path.join(uploadDir, newName);
  fs.writeFileSync(newPath, std.buf);
  if (newPath !== file.path) fs.unlinkSync(file.path);
  return { ...file, filename: newName, path: newPath, size: std.buf.length };
}

function fileResponse(file) {
  return { url: `/uploads/${file.filename}`, name: file.originalname, path: file.path, size: file.size };
}

router.post('/file', verify, upload.single('file'), async (req,res)=>{
  if(!req.file) return res.status(400).json({ error: 'missing_file' });
  res.json(fileResponse(await normalizeUploaded(req.file)));
});

router.post('/files', verify, upload.array('file', 9), async (req,res)=>{
  if(!req.files || req.files.length === 0) return res.status(400).json({ error: 'missing_files' });
  res.json({ files: await Promise.all(req.files.map(normalizeUploaded)).then(files => files.map(fileResponse)) });
});
