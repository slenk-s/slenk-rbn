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
  ssl: true
});

// Literal prefix match: escape the underscores so LIKE cannot match other names.
const ourTables = `
  select c.oid, c.relacl, c.relname as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname like 'slenk\\_notes\\_%' escape '\\'
`;

await client.connect();
await client.query(sql);

const { rows } = await client.query(`
  select c.relname as table_name, c.relrowsecurity as rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like 'slenk\\_notes\\_%' escape '\\' and c.relkind = 'r'
  order by c.relname
`);

// Direct ACL entries on the tables and their columns, for PUBLIC and both
// Data API roles. Covers table scope and column scope separately.
const { rows: directGrants } = await client.query(`
  with our_tables as (${ourTables})
  select t.table_name,
         case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
         a.privilege_type,
         'table' as scope
  from our_tables t
  cross join lateral aclexplode(t.relacl) a
  where a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole)
  union all
  select t.table_name,
         case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end,
         a.privilege_type,
         'column ' || att.attname
  from our_tables t
  join pg_attribute att on att.attrelid = t.oid and att.attnum > 0 and not att.attisdropped
  cross join lateral aclexplode(att.attacl) a
  where a.grantee = 0 or a.grantee in ('anon'::regrole, 'authenticated'::regrole)
  order by 1, 2, 3, 4
`);

// Effective privileges: all seven table privileges plus column privileges, which
// also surface anything reachable through role inheritance or PUBLIC.
const { rows: effectiveGrants } = await client.query(`
  with our_tables as (${ourTables})
  select t.table_name, p.priv,
         has_table_privilege('anon', t.oid, p.priv) as anon,
         has_table_privilege('authenticated', t.oid, p.priv) as authenticated
  from our_tables t
  cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(priv)
  where has_table_privilege('anon', t.oid, p.priv) or has_table_privilege('authenticated', t.oid, p.priv)
  union all
  select t.table_name, 'column ' || att.attname || ' ' || p.priv,
         has_column_privilege('anon', t.oid, att.attnum, p.priv),
         has_column_privilege('authenticated', t.oid, att.attnum, p.priv)
  from our_tables t
  join pg_attribute att on att.attrelid = t.oid and att.attnum > 0 and not att.attisdropped
  cross join (values ('select'), ('insert'), ('update'), ('references')) as p(priv)
  where has_column_privilege('anon', t.oid, att.attnum, p.priv) or has_column_privilege('authenticated', t.oid, att.attnum, p.priv)
  order by 1, 2
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
if (directGrants.length || effectiveGrants.length) {
  console.error('anon/authenticated still hold privileges on these tables:');
  console.table(directGrants);
  console.table(effectiveGrants);
  process.exit(1);
}
console.log('schema applied, RLS enabled on all 5 tables');
console.log('no anon/authenticated/PUBLIC table or column privileges: tables off the Data API surface');
