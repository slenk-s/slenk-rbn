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

const { rows: leakedGrants } = await client.query(`
  select grantee, table_name, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name like 'slenk_notes_%'
    and grantee in ('anon', 'authenticated')
  order by table_name, grantee, privilege_type
`);

const { rows: stillPrivileged } = await client.query(`
  select c.relname as table_name,
         has_table_privilege('anon', c.oid, 'select') as anon_can_select,
         has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_select
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
const exposed = stillPrivileged.filter(r => r.anon_can_select || r.authenticated_can_select);
if (leakedGrants.length || exposed.length) {
  console.error('anon/authenticated still reach these tables, revokes did not take effect:');
  console.table(leakedGrants);
  console.table(exposed);
  process.exit(1);
}
console.log('schema applied, RLS enabled on all 5 tables');
console.log('no anon/authenticated table grants: tables off the Data API surface');
