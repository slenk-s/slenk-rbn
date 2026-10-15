import { withTransaction, closePool, query } from '../src/db.js';
import { paths } from '../src/paths.js';
import fs from 'node:fs';
import path from 'node:path';

function safeJson(value, label) {
  if (value == null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    console.warn(`malformed JSON (${label}); storing null`);
    return null;
  }
}

const appJson = path.resolve(paths.dataDir, 'app.json');
if (!fs.existsSync(appJson)) {
  console.error('app.json not found at', appJson);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(appJson, 'utf8'));
const stats = { users: 0, providers: 0, notes: 0, tasks: 0 };
const knownUserIds = new Set((data.users || []).map(u => u.id));

await withTransaction(async client => {
  for (const u of data.users || []) {
    await client.query(
      `insert into slenk_notes_users (id, username, password_hash, is_admin, created_at)
       values ($1,$2,$3,$4,$5)
       on conflict (id) do update set username = excluded.username, password_hash = excluded.password_hash`,
      [u.id, u.username, u.passwordHash || '', u.username === 'admin', u.createdAt || new Date().toISOString()]
    );
    await client.query('insert into slenk_notes_user_settings (user_id) values ($1) on conflict do nothing', [u.id]);
    stats.users += 1;
  }

  for (const p of data.providers || []) {
    await client.query(
      `insert into slenk_notes_providers
         (id, name, provider_type, app_type, base_url, api_key, mode, text_model, image_model, notes, is_active, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (id) do update set name = excluded.name, base_url = excluded.base_url,
         api_key = excluded.api_key, mode = excluded.mode, text_model = excluded.text_model,
         image_model = excluded.image_model, is_active = excluded.is_active, updated_at = now()`,
      [p.id, p.name || 'Custom Provider', p.providerType || 'openai-compatible', p.appType || 'openai',
       p.baseUrl || '', p.apiKey || '', p.mode || 'image', p.textModel || '', p.imageModel || '',
       p.notes || '', Boolean(p.active),
       p.createdAt || new Date().toISOString(), p.updatedAt || new Date().toISOString()]
    );
    stats.providers += 1;
  }

  const adminId = (data.users || []).find(u => u.username === 'admin')?.id;
  const hasSettings = data.activeProviderId || data.activeTextProviderId || data.activeImageProviderId;
  if (adminId && hasSettings) {
    await client.query(
      `update slenk_notes_user_settings
       set active_provider_id = $2, active_text_provider_id = $3, active_image_provider_id = $4
       where user_id = $1`,
      [adminId, data.activeProviderId || null, data.activeTextProviderId || null, data.activeImageProviderId || null]
    );
  }

  for (const n of data.notes || []) {
    if (!adminId) throw new Error('no admin user found; refusing to migrate notes without an owner');
    await client.query(
      `insert into slenk_notes_notes (id, user_id, title, content, tags, images, created_at)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set title = excluded.title, content = excluded.content`,
      [n.id, adminId, n.title || '', n.content || '', n.tags || [],
       JSON.stringify(n.images || []), n.createdAt || new Date().toISOString()]
    );
    stats.notes += 1;
  }

  const orphanTasks = (data.tasks || []).filter(t => t.userId && !knownUserIds.has(t.userId));
  if (orphanTasks.length) {
    throw new Error(`tasks reference unknown users: ${orphanTasks.map(t => `${t.id} -> ${t.userId}`).join(', ')}`);
  }

  for (const t of data.tasks || []) {
    if (!t.userId) continue;
    await client.query(
      `insert into slenk_notes_tasks
         (id, user_id, type, label, status, payload, provider_id, tab, result, error, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [t.id, t.userId, t.type, t.label || null, t.status || 'queued',
       safeJson(t.payload, `task ${t.id} payload`), t.providerId || null, t.tab || null,
       safeJson(t.result, `task ${t.id} result`), t.error ?? null,
       t.createdAt || new Date().toISOString(), t.updatedAt || new Date().toISOString()]
    );
    stats.tasks += 1;
  }
});

try {
  const counts = await query(`
    select
      (select count(*)::int from slenk_notes_users) as users,
      (select count(*)::int from slenk_notes_providers) as providers,
      (select count(*)::int from slenk_notes_notes) as notes,
      (select count(*)::int from slenk_notes_tasks) as tasks
  `);
  console.log('migrated', stats);
  console.log('table counts', counts.rows[0]);
} finally {
  await closePool();
}
