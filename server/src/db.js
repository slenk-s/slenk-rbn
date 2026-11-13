import './loadEnv.js';
import pg from 'pg';

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

// sslmode=disable opts a local/CI database out of TLS. Everything else (TiDB
// Cloud, Supabase-style poolers) uses TLS verified against Node's bundled
// Mozilla root store, which includes the CAs TiDB Cloud serves (ISRG Root X1).
let disableSsl = false;
try {
  disableSsl = new URL(connectionString).searchParams.get('sslmode') === 'disable';
} catch {
  // Malformed connection string; pg will report the real error on first query.
}
const sslOptions = disableSsl
  ? {}
  : { ssl: { rejectUnauthorized: true } };

export const pool = new pg.Pool({
  connectionString,
  ...sslOptions,
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
