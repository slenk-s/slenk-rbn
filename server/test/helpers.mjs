import { randomUUID } from 'node:crypto';
import { query } from '../src/db.js';

export async function createTestUser(isAdmin = false) {
  const id = 'tu_' + randomUUID().slice(0, 8);
  await query(
    'insert into slenk_notes_users (id, username, password_hash, is_admin) values ($1, $2, $3, $4)',
    [id, id, 'test-hash', isAdmin]
  );
  return id;
}

export async function dropTestUser(id) {
  await query('delete from slenk_notes_users where id = $1', [id]);
}
