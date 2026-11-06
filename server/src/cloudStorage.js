import fs from 'node:fs';
import path from 'node:path';

// 生成结果持久化到 Supabase Storage（与云端 Postgres 同一个项目），
// 本地 storage/videos 只作为缓存；换机或本地文件丢失后公网 URL 仍可访问。
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const BUCKET = (process.env.SUPABASE_STORAGE_BUCKET || 'task-results').trim();

let bucketChecked = false;

export function cloudStorageEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY && BUCKET);
}

async function ensureBucket() {
  if (bucketChecked) return;
  const headers = { authorization: `Bearer ${SUPABASE_KEY}` };
  const found = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${encodeURIComponent(BUCKET)}`, { headers });
  if (found.ok) {
    bucketChecked = true;
    return;
  }
  const created = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true })
  });
  if (!created.ok) {
    const text = await created.text().catch(() => '');
    // 并发或已存在时创建会报错，再查一次确认；确认存在就视为可用。
    const recheck = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${encodeURIComponent(BUCKET)}`, { headers });
    if (!recheck.ok) throw new Error(`创建 Storage bucket 失败（HTTP ${created.status}）：${text.slice(0, 200)}`);
  }
  bucketChecked = true;
  console.log('[cloud] storage bucket ready:', BUCKET);
}

// 上传本地文件到 bucket 并返回公网 URL；未配置或上传失败返回 null，调用方回退到本地路径。
export async function uploadResultAsset(localPath, key, contentType) {
  if (!cloudStorageEnabled()) return null;
  try {
    await ensureBucket();
    const body = fs.readFileSync(localPath);
    const safeKey = path.basename(key);
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(safeKey)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SUPABASE_KEY}`,
        'content-type': contentType || 'application/octet-stream',
        'x-upsert': 'true'
      },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[cloud] upload failed:', res.status, text.slice(0, 200));
      return null;
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${safeKey}`;
  } catch (err) {
    console.warn('[cloud] upload error:', err.message);
    return null;
  }
}
