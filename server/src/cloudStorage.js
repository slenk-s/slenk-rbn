import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { insertMedia } from './store.js';

// 生成结果持久化（Phase 2）：媒体本体存 MySQL slenk_notes_media（LONGBLOB），
// 替代原 Supabase Storage（task-results 桶）。返回站内 URL /api/media/<id>，
// 由 routes/media.js 读库下发；本地 storage/videos 仍作为文件缓存，文件丢失后
// 结果仍可经 /api/media/<id> 从库读回。
//
// 原 Supabase 版返回公网 URL、失败回退本地路径的契约保留：DB 写入失败返回 null，
// 调用方回退到本地 local 路径（文件已在写入本函数前落盘）。

export function cloudStorageEnabled() {
  return true; // DB 媒体始终可用；保留导出以免破坏潜在的调用方。
}

// 读本地文件入库存媒体，返回站内 URL；失败返回 null（调用方回退本地路径）。
export async function uploadResultAsset(localPath, key, contentType, { taskId, userId } = {}) {
  try {
    if (!userId) return null;
    const data = fs.readFileSync(localPath);
    const id = randomUUID();
    await insertMedia({ id, taskId: taskId ?? null, userId, filename: path.basename(key), mimeType: contentType || 'application/octet-stream', data });
    return `/api/media/${id}`;
  } catch (err) {
    console.warn('[media] store failed, falling back to local path:', err.message);
    return null;
  }
}
