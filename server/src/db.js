import './loadEnv.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isTestProcess = process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);
const connectionString = isTestProcess
  ? (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)
  : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required (see .env)');
}

if (isTestProcess && !process.env.TEST_DATABASE_URL) {
  console.warn('⚠️ tests are running against DATABASE_URL (shared with the app); set TEST_DATABASE_URL to use a throwaway database');
}

export const pool = new pg.Pool({
  connectionString,
  ssl: {
    ca: fs.readFileSync(path.resolve(__dirname, '../certs/prod-ca-2021.crt')),
    rejectUnauthorized: true
  },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on('error', err => console.error('[db] idle client error', err.message));

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
