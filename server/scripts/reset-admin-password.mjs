// Resets a user's password directly in the database, for when everyone is
// locked out of the web UI. Usage: node scripts/reset-admin-password.mjs [username] [newPassword]
import '../src/loadEnv.js';
import bcrypt from 'bcryptjs';
import { findUserByUsername, updateUser } from '../src/store.js';

const username = process.argv[2] || 'admin';
const password = process.argv[3] || '123456';

if (password.length < 6) {
  console.error('password must be at least 6 characters');
  process.exit(1);
}

const user = await findUserByUsername(username);
if (!user) {
  console.error(`user not found: ${username}`);
  process.exit(1);
}
await updateUser(user.id, { passwordHash: bcrypt.hashSync(password, 10) });
console.log(`password reset for ${username}`);
process.exit(0);
