import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing in .env');
  process.exit(1);
}

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

await client.connect();
await client.query(sql);

const { rows } = await client.query(`
  select c.relname as table_name, c.relrowsecurity as rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like 'slenk_notes_%' and c.relkind = 'r'
  order by c.relname
`);
await client.end();

console.table(rows);
const missing = rows.filter(r => !r.rls_enabled);
if (rows.length !== 5) {
  console.error(`expected 5 tables, found ${rows.length}`);
  process.exit(1);
}
if (missing.length) {
  console.error('RLS not enabled on:', missing.map(r => r.table_name).join(', '));
  process.exit(1);
}
console.log('schema applied, RLS enabled on all 5 tables');
