// Bring the local test database up before running the suite.
//
// Usage:  node scripts/test-db-up.mjs
// Wired up as `npm run test:db` in this package.
//
// The container name is coupled to TEST_DATABASE_URL being a localhost target;
// when the tests are pointed at a remote database there is nothing local to
// start, so this exits successfully without touching docker.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('TEST_DATABASE_URL / DATABASE_URL missing in .env');
  process.exit(1);
}

const target = new URL(databaseUrl);
const LOCALHOST = new Set(['localhost', '127.0.0.1', '::1']);
if (!LOCALHOST.has(target.hostname)) {
  console.log(`test database target is ${target.hostname}, not localhost — nothing local to start`);
  process.exit(0);
}

const CONTAINER = 'slenk-notes-test-db';
const database = target.pathname.replace(/^\//, '') || 'postgres';

let started;
try {
  started = execFileSync('docker', ['start', CONTAINER], { encoding: 'utf8' }).trim();
} catch (err) {
  console.error(`docker start ${CONTAINER} failed:`);
  console.error(err.stderr?.toString() || err.message);
  console.error('is Docker Desktop running?');
  process.exit(1);
}
console.log(`docker start ${CONTAINER}: ${started}`);

const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    execFileSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', database], { stdio: 'pipe' });
    console.log(`test database is ready at ${target.host}/${database}`);
    process.exit(0);
  } catch {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

console.error(`timed out waiting for ${CONTAINER} to accept connections`);
process.exit(1);
