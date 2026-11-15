import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

// MySQL 版建表脚本：应用 scripts/schema.mysql.sql 到 DATABASE_URL，并校验表数量。
// 原 PostgreSQL/Supabase 版本（schema.sql + RLS 加固 + Data API 权限校验）已随
// 数据库切换退役；MySQL 无 RLS / anon / authenticated 角色，那些步骤全部移除。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing in .env');
  process.exit(1);
}

const raw = fs.readFileSync(path.join(__dirname, 'schema.mysql.sql'), 'utf8');

// 去掉整行 `--` 注释（schema 头部与表间说明），再按 `;` 切分语句。
// schema.mysql.sql 无字符串字面量内的分号、无存储过程，按 `;` 切分安全。
const withoutComments = raw
  .split('\n')
  .filter(line => !line.trimStart().startsWith('--'))
  .join('\n');
const statements = withoutComments
  .split(';')
  .map(s => s.trim())
  .filter(Boolean);

const conn = await mysql.createConnection(process.env.DATABASE_URL);
try {
  for (const stmt of statements) {
    await conn.query(stmt);
  }
  // create table if not exists → 幂等，重复运行安全。
  const [rows] = await conn.query(
    "select table_name from information_schema.tables where table_schema = database() and table_name like 'slenk\\_notes\\_%' order by table_name"
  );
  console.table(rows);
  if (rows.length !== 7) {
    console.error(`expected 7 tables, found ${rows.length}`);
    process.exit(1);
  }
  console.log('schema applied (7 tables)');
} finally {
  await conn.end();
}
