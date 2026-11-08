// 调试脚本：用供应商真实凭据重放被拒的图生图请求，只打印状态和错误，不打印密钥。
import '../src/loadEnv.js';
import { query } from '../src/db.js';
import fs from 'node:fs';
import path from 'node:path';

const providerId = process.argv[2] || 'prov_mvvin8bg3h7dcc';
const imagePath = process.argv[3] || '../storage/notes-images/81908425e4546d259c083cc8cdee9765.jpg';
const modelOverride = process.argv[4] || '';
const asPng = process.argv.includes('--png');

const { rows } = await query('select name, base_url, api_key, image_model, image_api from slenk_notes_providers where id = $1', [providerId]);
const p = rows[0];
if (!p) { console.log('provider not found'); process.exit(1); }
console.log('provider:', p.name, '| model:', modelOverride || p.image_model, '| png:', asPng, '| base:', p.base_url);

let buf = fs.readFileSync(path.resolve(imagePath));
let mime = 'image/jpeg';
let fname = 'ref-1.jpg';
if (asPng) {
  const sharp = (await import('sharp')).default;
  buf = await sharp(buf).png().toBuffer();
  mime = 'image/png';
  fname = 'ref-1.png';
}
console.log('image bytes:', buf.length);

const fd = new FormData();
fd.set('model', modelOverride || p.image_model || 'turing/gpt-image-2.5-flare');
fd.set('prompt', '保持画面不变');
fd.set('n', '1');
fd.set('size', '1024x1024');
fd.append('image', new Blob([buf], { type: mime }), fname);

const res = await fetch(p.base_url.replace(/\/$/, '') + '/images/edits', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + p.api_key },
  body: fd
});
const data = await res.json().catch(() => null);
console.log('HTTP', res.status);
console.log('error:', JSON.stringify(data?.error || null)?.slice(0, 400));
console.log('images returned:', data?.data?.length ?? 0);
process.exit(0);
