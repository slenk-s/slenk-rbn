import './env.mjs';
import { createUser, deleteUser } from '../src/store.js';

export async function createTestUser(isAdmin = false) {
  const id = 'tu_' + Math.random().toString(36).slice(2, 10);
  const user = await createUser({ username: id, passwordHash: 'test-hash', isAdmin });
  return user.id;
}

export async function dropTestUser(id) {
  if (!id) return;
  await deleteUser(id);
}
